import { stat } from 'node:fs/promises';
import { posix } from 'node:path';
import * as vscode from 'vscode';
import type { AdapterRegistry } from '../runner/registry';
import type { AuthService } from '../auth/authService';
import {
  getPreferredAdapterId,
  getSourceCaptureSettings,
  getWarnOnSuspiciousTests,
} from '../config/settings';
import { isInside, samePath, TestLocationResolver, type SourceLocation } from '../capture/location';
import { collectTestEvidence, type TestEvidence } from '../capture/evidence';
import { mayBeTestFolder, SOURCE_FILE_GLOB, TestFileFinder } from '../capture/discovery';
import { locateResults, SourceFileCache, type LocatedResult, type SourceFile } from '../capture/sourceFiles';
import { describeSuspiciousTests } from '../capture/integrity';
import {
  classItemId,
  declarationItemId,
  fileItemId,
  folderItemId,
  isFileItemId,
  resultItemId,
  suiteDescription,
  suiteItemId,
  suiteKey,
  suiteLabel,
  testItemId,
} from './testTree';
import { runTests } from '../core/testRunner';
import { pickAdapter, resolveWorkspaceFolder } from './workspacePicker';
import { submitRun } from '../core/submitRun';
import type { NormalizedTestCase, NormalizedTestRun, Platform, TestStatus } from '../core/types';
import type { TestDeclaration } from '../scanning';
import { CancelledError, describeError } from '../core/errors';
import { handleCommandError } from './errorHandling';
import { ensureConfigured } from './onboarding';
import { ensureAssignmentKey } from './assignmentKey';
import type { MoodleApiClient } from '../services/moodleApiClient';
import { confirmDegradedRun, describeFinding } from './degradedRunPrompt';
import type { Logger, StatusReporter } from '../core/ports';

/** Where versions before discovery remembered the last run's tests. Cleared, since the tree now comes from source. */
const KNOWN_TESTS_KEY = 'moodleSubmit.knownTests';

const NOT_DISCOVERED = 'run to discover tests';

/** Saving often writes a file more than once in quick succession; one scan covers them all. */
export const RESCAN_DELAY_MS = 300;

const SEVERITY: Record<TestStatus, number> = { SKIPPED: 0, PASSED: 1, FAILED: 2, ERROR: 3 };

export interface TestControllerDeps {
  registry: AdapterRegistry;
  authService: AuthService;
  apiClient: MoodleApiClient;
  logger: Logger;
  status: StatusReporter;
}

export interface PerformRunOptions {
  folder: vscode.WorkspaceFolder;
  submit: boolean;
  request?: vscode.TestRunRequest;
  signal?: AbortSignal;
  report?: (message: string) => void;
}

export interface MoodleTestControl {
  performRun(options: PerformRunOptions): Promise<void>;
  folderFor(target: unknown): vscode.WorkspaceFolder | undefined;
}

function asTestItem(target: unknown): vscode.TestItem | undefined {
  if (typeof target !== 'object' || target === null) return undefined;
  const candidate = target as Partial<vscode.TestItem>;
  return typeof candidate.id === 'string' && candidate.children !== undefined
    ? (candidate as vscode.TestItem)
    : undefined;
}

/** The Testing terminal renders raw bytes, so bare LF would stair-step. */
function toCrlf(text: string): string {
  return text.replace(/\r?\n/g, '\r\n');
}

/** Snapshots ids so the collection can be mutated while walking it. */
function idsOf(collection: vscode.TestItemCollection): string[] {
  const ids: string[] = [];
  collection.forEach((item) => ids.push(item.id));
  return ids;
}

/** Stack-trace lines are 1-based; editor ranges are 0-based. */
function lineRange(line: number): vscode.Range {
  const zeroBased = Math.max(0, line - 1);
  return new vscode.Range(zeroBased, 0, zeroBased, 0);
}

function isAtOrUnder(path: string, root: string): boolean {
  return samePath(path, root) || isInside(root, path);
}

function failureMessage(testCase: NormalizedTestCase): string {
  const parts = [testCase.message, testCase.stackTrace].filter(
    (part): part is string => !!part && part.trim().length > 0,
  );
  return parts.length > 0 ? parts.join('\n\n') : `${testCase.status} with no reported message.`;
}

interface RenderedFile {
  fileItem: vscode.TestItem;
  items: Map<TestDeclaration, vscode.TestItem>;
}

export function registerTestController(
  context: vscode.ExtensionContext,
  deps: TestControllerDeps,
): MoodleTestControl {
  const controller = vscode.tests.createTestController('moodleSubmit.tests', 'Moodle Tests');
  context.subscriptions.push(controller);

  if (context.workspaceState.get(KNOWN_TESTS_KEY) !== undefined) {
    void context.workspaceState.update(KNOWN_TESTS_KEY, undefined);
  }

  // ---------------------------------------------------------------- tree ----

  /** Results that exist only once the tests run; a run prunes these, never what came from source. */
  const resultItems = new WeakSet<vscode.TestItem>();

  /** When each file item was last built, so a slow discovery can tell what changed while it walked. */
  let renders = 0;
  const renderedAt = new WeakMap<vscode.TestItem, number>();

  function isOpen(folder: vscode.WorkspaceFolder): boolean {
    return (vscode.workspace.workspaceFolders ?? []).some((open) => open.uri.fsPath === folder.uri.fsPath);
  }

  function folderItem(folder: vscode.WorkspaceFolder): vscode.TestItem {
    const id = folderItemId(folder.uri.fsPath);
    const existing = controller.items.get(id);
    if (existing) return existing;

    const item = controller.createTestItem(id, folder.name, folder.uri);
    item.description = NOT_DISCOVERED;
    controller.items.add(item);
    return item;
  }

  function updatePlaceholder(folder: vscode.WorkspaceFolder): void {
    const root = folderItem(folder);
    root.description = root.children.size === 0 ? NOT_DISCOVERED : undefined;
  }

  function childItem(
    parent: vscode.TestItem,
    id: string,
    label: string,
    uri: vscode.Uri | undefined,
  ): vscode.TestItem {
    const existing = parent.children.get(id);
    // `TestItem.uri` is readonly, so an item whose file moved must be recreated.
    if (existing && existing.uri?.toString() === uri?.toString()) {
      existing.label = label;
      return existing;
    }
    if (existing) {
      parent.children.delete(id);
    }
    const item = controller.createTestItem(id, label, uri);
    parent.children.add(item);
    return item;
  }

  /** Builds or refreshes one file's subtree from its scan, keeping the run-time results under it. */
  function renderFile(folder: vscode.WorkspaceFolder, file: SourceFile): RenderedFile {
    const uri = vscode.Uri.file(file.absolutePath);
    const fileId = fileItemId(folder.uri.fsPath, file.relativePath);
    const fileItem = childItem(folderItem(folder), fileId, posix.basename(file.relativePath), uri);
    renderedAt.set(fileItem, ++renders);
    const dir = posix.dirname(file.relativePath);
    fileItem.description = dir === '.' ? undefined : dir;

    const stem = posix.basename(file.relativePath, posix.extname(file.relativePath));
    const lines = file.text.split('\n');
    const kept = new Map<vscode.TestItem, Set<string>>();
    const keep = (parent: vscode.TestItem, item: vscode.TestItem): vscode.TestItem => {
      kept.set(parent, (kept.get(parent) ?? new Set()).add(item.id));
      return item;
    };
    const items = new Map<TestDeclaration, vscode.TestItem>();
    const seen = new Map<string, number>();

    for (const declaration of file.declarations) {
      const segments = declaration.container?.split('.') ?? [];
      let parent = fileItem;
      // A class named after its file adds nothing to the file it is in.
      for (let depth = segments[0] === stem ? 1 : 0; depth < segments.length; depth++) {
        const classId = classItemId(fileId, segments.slice(0, depth + 1).join('.'));
        parent = keep(parent, childItem(parent, classId, segments[depth], uri));
      }

      const baseId = declarationItemId(fileId, declaration.container, declaration.name);
      const count = (seen.get(baseId) ?? 0) + 1;
      seen.set(baseId, count);
      // Overloads, or a function defined twice: the later ones are told apart by their order.
      const id = count === 1 ? baseId : `${baseId}#${count}`;
      const item = keep(parent, childItem(parent, id, declaration.name, uri));
      // Whole lines, so "run test at cursor" works anywhere in the test.
      item.range = new vscode.Range(
        declaration.startLine - 1,
        0,
        declaration.endLine - 1,
        lines[declaration.endLine - 1]?.length ?? 0,
      );
      // Its parameterized cases sit where it does, wherever an edit has moved it.
      item.children.forEach((child) => {
        if (resultItems.has(child)) child.range = item.range;
      });
      items.set(declaration, item);
    }

    const prune = (item: vscode.TestItem): void => {
      const keepIds = kept.get(item) ?? new Set<string>();
      for (const id of idsOf(item.children)) {
        const child = item.children.get(id);
        if (!child || resultItems.has(child)) continue;
        if (keepIds.has(id)) prune(child);
        else item.children.delete(id);
      }
    };
    prune(fileItem);

    return { fileItem, items };
  }

  function fileItemsOf(folder: vscode.WorkspaceFolder): vscode.TestItem[] {
    const items: vscode.TestItem[] = [];
    folderItem(folder).children.forEach((item) => {
      if (isFileItemId(folder.uri.fsPath, item.id)) items.push(item);
    });
    return items;
  }

  /** Removes the file at `path`, or every file under it when it was a folder. */
  function removeFiles(folder: vscode.WorkspaceFolder, path: string): void {
    const root = folderItem(folder);
    for (const item of fileItemsOf(folder)) {
      if (item.uri && isAtOrUnder(item.uri.fsPath, path)) root.children.delete(item.id);
    }
    updatePlaceholder(folder);
  }

  // ----------------------------------------------------------- discovery ----

  let discoveryStarted = false;

  /** The platforms the folder's build tools test on. Detection only, so no prompt can appear. */
  async function platformsFor(folderPath: string): Promise<Platform[]> {
    try {
      const preferred = getPreferredAdapterId(folderPath);
      const adapters = preferred
        ? [await deps.registry.resolveAdapter(folderPath, { preferredAdapterId: preferred })]
        : await deps.registry.detectAdapters(folderPath);
      return [...new Set(adapters.map((adapter) => adapter.platform))];
    } catch {
      return [];
    }
  }

  /**
   * Detected afresh each time, never cached: adding `pom.xml` or `conftest.py`, or changing
   * `preferredAdapter`, changes the answer. It's a handful of file checks.
   */
  async function finderFor(folder: vscode.WorkspaceFolder): Promise<TestFileFinder | undefined> {
    const platforms = await platformsFor(folder.uri.fsPath);
    return platforms.length > 0 ? new TestFileFinder(folder.uri.fsPath, platforms) : undefined;
  }

  async function discoverFolder(folder: vscode.WorkspaceFolder): Promise<void> {
    const folderPath = folder.uri.fsPath;
    const startedAt = renders;
    try {
      const finder = await finderFor(folder);
      const found = finder ? await finder.discover(new SourceFileCache(folderPath, finder.platforms[0])) : [];
      if (!isOpen(folder)) return;

      const live = new Set(found.map((file) => renderFile(folder, file).fileItem.id));
      const root = folderItem(folder);
      for (const item of fileItemsOf(folder)) {
        // Rebuilt during the walk by a rescan or a run: newer than what this walk saw.
        const stale = (renderedAt.get(item) ?? 0) <= startedAt;
        // A file only a run traced, e.g. one a custom `python_files` names, isn't the walk's to remove.
        const discoverable = !finder || (item.uri !== undefined && finder.isCandidate(item.uri.fsPath));
        if (!live.has(item.id) && stale && discoverable) root.children.delete(item.id);
      }
      updatePlaceholder(folder);
    } catch (error) {
      deps.logger.log(`Could not discover the tests in "${folder.name}": ${describeError(error)}`);
    }
  }

  // Called with no item when the Testing view first needs the tree.
  controller.resolveHandler = async (item) => {
    if (item) return;
    discoveryStarted = true;
    await Promise.all((vscode.workspace.workspaceFolders ?? []).map(discoverFolder));
  };

  function syncFolders(): void {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const live = new Set(folders.map((folder) => folderItemId(folder.uri.fsPath)));
    for (const id of idsOf(controller.items)) {
      if (!live.has(id)) controller.items.delete(id);
    }
    for (const folder of folders) {
      const added = !controller.items.get(folderItemId(folder.uri.fsPath));
      folderItem(folder);
      if (added && discoveryStarted) void discoverFolder(folder);
    }
  }

  syncFolders();
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(syncFolders));

  // -------------------------------------------------------------- rescan ----

  const pendingRescans = new Map<string, ReturnType<typeof setTimeout>>();
  context.subscriptions.push({ dispose: () => pendingRescans.forEach((timer) => clearTimeout(timer)) });

  async function rescanFile(uri: vscode.Uri): Promise<void> {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) return;
    const finder = await finderFor(folder);
    // A file already in the tree stays current even if only a run could find it.
    const tracked = fileItemsOf(folder).some((item) => item.uri && samePath(item.uri.fsPath, uri.fsPath));
    if (!finder || !(finder.isCandidate(uri.fsPath) || tracked)) return;

    const file = await finder.load(uri.fsPath, new SourceFileCache(folder.uri.fsPath, finder.platforms[0]));
    if (!isOpen(folder)) return;
    if (file) {
      renderFile(folder, file);
      updatePlaceholder(folder);
    } else {
      removeFiles(folder, uri.fsPath);
    }
  }

  function scheduleRescan(uri: vscode.Uri): void {
    if (uri.scheme !== 'file') return;
    clearTimeout(pendingRescans.get(uri.fsPath));
    pendingRescans.set(
      uri.fsPath,
      setTimeout(() => {
        pendingRescans.delete(uri.fsPath);
        void rescanFile(uri);
      }, RESCAN_DELAY_MS),
    );
  }

  function onDeleted(uri: vscode.Uri): void {
    clearTimeout(pendingRescans.get(uri.fsPath));
    pendingRescans.delete(uri.fsPath);
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (folder) removeFiles(folder, uri.fsPath);
  }

  // Creating, moving or renaming a folder reports only the folder, not the test files in it, so
  // any folder that turns up has its workspace folder discovered again, once things go quiet.
  const createdPaths = new Map<string, Set<string>>();
  const pendingDiscoveries = new Map<string, ReturnType<typeof setTimeout>>();
  context.subscriptions.push({ dispose: () => pendingDiscoveries.forEach((timer) => clearTimeout(timer)) });

  async function discoverIfFolderCreated(folder: vscode.WorkspaceFolder): Promise<void> {
    const paths = createdPaths.get(folder.uri.fsPath) ?? new Set<string>();
    createdPaths.delete(folder.uri.fsPath);
    for (const path of paths) {
      const isDirectory = await stat(path).then(
        (stats) => stats.isDirectory(),
        () => false,
      );
      if (isDirectory) {
        await discoverFolder(folder);
        return;
      }
    }
  }

  function onCreated(uri: vscode.Uri): void {
    if (uri.scheme !== 'file') return;
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    // Build output, caches and source files (the source watcher's) are dropped here, unread.
    if (!folder || !mayBeTestFolder(folder.uri.fsPath, uri.fsPath)) return;

    const key = folder.uri.fsPath;
    createdPaths.set(key, (createdPaths.get(key) ?? new Set<string>()).add(uri.fsPath));
    clearTimeout(pendingDiscoveries.get(key));
    pendingDiscoveries.set(
      key,
      setTimeout(() => {
        pendingDiscoveries.delete(key);
        void discoverIfFolderCreated(folder);
      }, RESCAN_DELAY_MS),
    );
  }

  const sourceWatcher = vscode.workspace.createFileSystemWatcher(SOURCE_FILE_GLOB);
  // Folders as well as files; deleting a folder, too, reports only the folder.
  const treeWatcher = vscode.workspace.createFileSystemWatcher('**/*', false, true, false);
  context.subscriptions.push(
    sourceWatcher,
    treeWatcher,
    sourceWatcher.onDidCreate(scheduleRescan),
    sourceWatcher.onDidChange(scheduleRescan),
    treeWatcher.onDidCreate(onCreated),
    treeWatcher.onDidDelete(onDeleted),
    // So an open test file gets its gutter icons even if the Testing view is never opened.
    vscode.workspace.onDidOpenTextDocument((document) => scheduleRescan(document.uri)),
  );
  vscode.workspace.textDocuments.forEach((document) => scheduleRescan(document.uri));

  function folderOf(item: vscode.TestItem): vscode.WorkspaceFolder | undefined {
    let root = item;
    while (root.parent) {
      root = root.parent;
    }
    return (vscode.workspace.workspaceFolders ?? []).find(
      (folder) => folderItemId(folder.uri.fsPath) === root.id,
    );
  }

  // ------------------------------------------------------------- results ----

  async function applyResults(
    testRun: vscode.TestRun,
    folder: vscode.WorkspaceFolder,
    run: NormalizedTestRun,
    located: LocatedResult[],
    resolver: TestLocationResolver,
  ): Promise<void> {
    const folderPath = folder.uri.fsPath;
    const root = folderItem(folder);
    const rendered = new Map<SourceFile, RenderedFile>();
    const render = (file: SourceFile): RenderedFile => {
      let result = rendered.get(file);
      if (!result) {
        result = renderFile(folder, file);
        rendered.set(file, result);
      }
      return result;
    };

    const liveResults = new Set<vscode.TestItem>();
    const resultItem = (parent: vscode.TestItem, id: string, label: string, uri?: vscode.Uri): vscode.TestItem => {
      const item = childItem(parent, id, label, uri);
      resultItems.add(item);
      liveResults.add(item);
      return item;
    };

    // A declaration that ran once reports on itself. One that ran several times (parameterized
    // cases, theory data, an inherited test run by each subclass) gets a child per run.
    const runsByDeclaration = new Map<TestDeclaration, { runs: Set<string>; suites: Set<string> }>();
    located.forEach(({ declaration }, index) => {
      if (!declaration) return;
      const { testSuite, testName } = run.results[index];
      const entry = runsByDeclaration.get(declaration) ?? { runs: new Set<string>(), suites: new Set<string>() };
      entry.runs.add(`${suiteKey(testSuite)}\n${testName}`);
      entry.suites.add(suiteKey(testSuite));
      runsByDeclaration.set(declaration, entry);
    });

    const reported = new Map<string, TestStatus>();

    for (const [index, testCase] of run.results.entries()) {
      const { location, file, declaration } = located[index] ?? {};
      let item: vscode.TestItem;

      if (file && declaration) {
        const declared = render(file).items.get(declaration);
        if (!declared) continue;
        const runs = runsByDeclaration.get(declaration);
        if (!runs || runs.runs.size === 1) {
          item = declared;
        } else {
          // An inherited test has the same name in every suite that runs it: the suite tells them apart.
          const bySuite = runs.suites.size > 1;
          const suite = suiteKey(testCase.testSuite);
          const key = bySuite ? `${suite}::${testCase.testName}` : testCase.testName;
          item = resultItem(declared, resultItemId(declared.id, key), testCase.testName, declared.uri);
          item.description = bySuite ? suiteLabel(suite) : undefined;
          item.range = declared.range;
        }
      } else if (file && file.declarations.length > 0) {
        const { fileItem } = render(file);
        item = resultItem(fileItem, resultItemId(fileItem.id, testCase.testName), testCase.testName, fileItem.uri);
        if (location?.line !== undefined) item.range = lineRange(location.line);
      } else {
        // Traced to no test file at all: grouped under the suite the report names, as before discovery.
        const suite = suiteKey(testCase.testSuite);
        const suiteFile = await resolver.resolveSuiteFile(testCase.testSuite);
        const suiteItem = resultItem(
          root,
          suiteItemId(folderPath, suite),
          suiteLabel(suite),
          suiteFile ? vscode.Uri.file(suiteFile) : undefined,
        );
        suiteItem.description = suiteDescription(suite);
        item = resultItem(
          suiteItem,
          testItemId(folderPath, suite, testCase.testName),
          testCase.testName,
          location ? vscode.Uri.file(location.file) : undefined,
        );
        if (location?.line !== undefined) item.range = lineRange(location.line);
      }

      // A name repeated under one item (unnamed cases, a rerun) shares it: the worse outcome stands.
      const previous = reported.get(item.id);
      if (previous !== undefined && SEVERITY[previous] >= SEVERITY[testCase.status]) continue;
      reported.set(item.id, testCase.status);

      testRun.started(item);
      reportResult(testRun, item, testCase, location);
    }

    // Results from earlier runs go; tests declared in the source stay, whether or not they ran.
    const prune = (item: vscode.TestItem): void => {
      for (const id of idsOf(item.children)) {
        const child = item.children.get(id);
        if (!child) continue;
        if (resultItems.has(child) && !liveResults.has(child)) item.children.delete(id);
        else prune(child);
      }
    };
    prune(root);
    updatePlaceholder(folder);
  }

  function reportResult(
    testRun: vscode.TestRun,
    item: vscode.TestItem,
    testCase: NormalizedTestCase,
    location: SourceLocation | undefined,
  ): void {
    switch (testCase.status) {
      case 'PASSED':
        testRun.passed(item, testCase.durationMs);
        return;
      case 'SKIPPED':
        testRun.skipped(item);
        return;
      default: {
        const message = new vscode.TestMessage(failureMessage(testCase));
        if (location?.line !== undefined) {
          message.location = new vscode.Location(
            vscode.Uri.file(location.file),
            lineRange(location.line),
          );
        }
        if (testCase.status === 'FAILED') {
          testRun.failed(item, message, testCase.durationMs);
        } else {
          testRun.errored(item, message, testCase.durationMs);
        }
      }
    }
  }

  // ------------------------------------------------------------ evidence ----

  function gatherEvidence(
    run: NormalizedTestRun,
    folder: vscode.WorkspaceFolder,
    located: LocatedResult[],
  ): TestEvidence | undefined {
    try {
      const evidence = collectTestEvidence(run, located, getSourceCaptureSettings(folder.uri.fsPath));
      const { sources, files } = evidence.payload;
      const found = sources.filter((source) => source.kind === 'TEST').length;
      const fileChars = files.reduce((total, file) => total + (file.content?.length ?? 0), 0);
      deps.logger.log(
        `Located ${found}/${run.results.length} tests in ${files.length} file(s) (${fileChars} chars).`,
      );
      return evidence;
    } catch (error) {
      // Capturing source must never be able to break a submission.
      deps.logger.log(`Could not capture test source: ${describeError(error)}`);
      return undefined;
    }
  }

  // ----------------------------------------------------------------- run ----

  const inFlight = new Set<string>();

  async function performRun(options: PerformRunOptions): Promise<void> {
    const { folder } = options;
    // A second build in the same folder would clear the first one's reports mid-run.
    if (inFlight.has(folder.uri.fsPath)) {
      void vscode.window.showInformationMessage(`Tests are already running in "${folder.name}".`);
      return;
    }
    inFlight.add(folder.uri.fsPath);
    try {
      await runFolder(options);
    } finally {
      inFlight.delete(folder.uri.fsPath);
    }
  }

  async function runFolder({
    folder,
    submit,
    request,
    signal,
    report,
  }: PerformRunOptions): Promise<void> {
    if (submit && !((await ensureConfigured(context)) && (await ensureAssignmentKey(folder)))) {
      return;
    }

    const testRun = controller.createTestRun(
      request ?? new vscode.TestRunRequest(),
      submit ? 'Run & Submit to Moodle' : 'Run Tests',
      true,
    );
    const controllerAbort = new AbortController();
    const onAbort = (): void => controllerAbort.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) controllerAbort.abort();
    const cancelSub = testRun.token.onCancellationRequested(onAbort);

    try {
      if (submit) {
        report?.('Signing in…');
        await deps.authService.getAccessToken();
      }

      deps.status.running();
      report?.('Running tests…');
      const { run, summary } = await runTests(deps.registry, folder.uri.fsPath, {
        logger: deps.logger,
        signal: controllerAbort.signal,
        onOutput: (chunk) => testRun.appendOutput(toCrlf(chunk)),
        pickFromMultiple: pickAdapter,
      });

      // Read and scanned once, for both the tree and the submission.
      const resolver = new TestLocationResolver(folder.uri.fsPath, run.platform);
      let located: LocatedResult[] | undefined;
      try {
        located = await locateResults(run, resolver, new SourceFileCache(folder.uri.fsPath, run.platform));
      } catch (error) {
        // Tracing results into the source must never be able to break a run or a submission:
        // without it the results are still shown and sent, just not tied to their code.
        deps.logger.log(`Could not trace the results to the source: ${describeError(error)}`);
      }
      await applyResults(testRun, folder, run, located ?? run.results.map(() => ({})), resolver);
      deps.status.result(summary);

      if (!submit) {
        deps.logger.log('Run complete (not submitted).');
        return;
      }

      // Untraced, every test would look missing from the source and set off the tampering warning.
      const evidence = located && gatherEvidence(run, folder, located);
      if (evidence) {
        const findings = describeSuspiciousTests(evidence.integrity);
        for (const finding of findings) {
          deps.logger.log(`Integrity warning: ${describeFinding(finding)}`);
        }
        if (findings.length > 0 && getWarnOnSuspiciousTests(folder.uri.fsPath)) {
          if (!(await confirmDegradedRun(findings, summary.total))) {
            deps.logger.log('Submission cancelled at the integrity warning.');
            testRun.appendOutput(toCrlf('\nSubmission cancelled.\n'));
            return;
          }
        }
      }

      report?.('Submitting to Moodle…');
      await submitRun(
        run,
        {
          folderPath: folder.uri.fsPath,
          projectName: folder.name,
          evidence: evidence?.payload,
        },
        { apiClient: deps.apiClient, logger: deps.logger },
      );
      deps.logger.log('Submitted successfully.');
      testRun.appendOutput(toCrlf(`\nSubmitted ${summary.total} test result(s) to Moodle.\n`));
      void vscode.window.showInformationMessage(
        `Submitted ${summary.total} test result(s) to Moodle (${summary.passed} passed).`,
      );
    } catch (error) {
      testRun.appendOutput(toCrlf(`\n${describeError(error)}\n`));
      throw error;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      cancelSub.dispose();
      testRun.end();
    }
  }

  // ------------------------------------------------------------- profile ----

  // One profile: submitting is the separate runAndSubmit command. Each folder's run shares the
  // request's cancellation and performRun listens on that; the handler token only stops the loop.
  const runHandler = async (request: vscode.TestRunRequest, token?: vscode.CancellationToken): Promise<void> => {
    let folders: vscode.WorkspaceFolder[];
    try {
      folders = await foldersForRequest(request);
    } catch (error) {
      handleCommandError(error, deps.logger, deps.status);
      return;
    }
    // One folder failing to build shouldn't keep the others from running.
    for (const folder of folders) {
      if (token?.isCancellationRequested) return;
      try {
        await performRun({ folder, submit: false, request });
      } catch (error) {
        handleCommandError(error, deps.logger, deps.status);
        if (error instanceof CancelledError) return;
      }
    }
  };

  controller.createRunProfile('Run Tests', vscode.TestRunProfileKind.Run, runHandler, true);

  /** Each folder the selection touches, once; with no selection, the active or picked one. */
  async function foldersForRequest(request: vscode.TestRunRequest): Promise<vscode.WorkspaceFolder[]> {
    const included = new Map<string, vscode.WorkspaceFolder>();
    for (const item of request.include ?? []) {
      const folder = folderOf(item);
      if (folder) included.set(folder.uri.fsPath, folder);
    }
    return included.size > 0 ? [...included.values()] : [await resolveWorkspaceFolder()];
  }

  function folderFor(target: unknown): vscode.WorkspaceFolder | undefined {
    const item = asTestItem(target);
    return item ? folderOf(item) : undefined;
  }

  return { performRun, folderFor };
}
