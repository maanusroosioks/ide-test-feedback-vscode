import * as vscode from 'vscode';
import type { AdapterRegistry } from '../runner/registry';
import type { AuthService } from '../auth/authService';
import {
  getSourceCaptureSettings,
  getWarnOnSuspiciousTests,
} from '../config/settings';
import { TestLocationResolver, type SourceLocation } from '../capture/location';
import { collectTestEvidence, type TestEvidence } from '../capture/evidence';
import { describeSuspiciousTests } from '../capture/integrity';
import {
  folderItemId,
  suiteDescription,
  suiteItemId,
  suiteKey,
  suiteLabel,
  testItemId,
  type KnownTest,
} from './testTree';
import { runTests } from '../core/testRunner';
import { pickAdapter, resolveWorkspaceFolder } from './workspacePicker';
import { submitRun } from '../core/submitRun';
import type { NormalizedTestCase, NormalizedTestRun, TestStatus } from '../core/types';
import { CancelledError, describeError } from '../core/errors';
import { handleCommandError } from './errorHandling';
import { ensureConfigured } from './onboarding';
import { ensureAssignmentKey } from './assignmentKey';
import type { MoodleApiClient } from '../services/moodleApiClient';
import { confirmDegradedRun, describeFinding } from './degradedRunPrompt';
import type { Logger, StatusReporter } from '../core/ports';

const KNOWN_TESTS_KEY = 'moodleSubmit.knownTests';

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

function failureMessage(testCase: NormalizedTestCase): string {
  const parts = [testCase.message, testCase.stackTrace].filter(
    (part): part is string => !!part && part.trim().length > 0,
  );
  return parts.length > 0 ? parts.join('\n\n') : `${testCase.status} with no reported message.`;
}

export function registerTestController(
  context: vscode.ExtensionContext,
  deps: TestControllerDeps,
): MoodleTestControl {
  const controller = vscode.tests.createTestController('moodleSubmit.tests', 'Moodle Tests');
  context.subscriptions.push(controller);

  // ---------------------------------------------------------------- tree ----

  function folderItem(folder: vscode.WorkspaceFolder): vscode.TestItem {
    const id = folderItemId(folder.uri.fsPath);
    const existing = controller.items.get(id);
    if (existing) return existing;

    const item = controller.createTestItem(id, folder.name, folder.uri);
    item.description = 'run to discover tests';
    controller.items.add(item);
    return item;
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

  function knownTests(): Record<string, KnownTest[]> {
    return context.workspaceState.get<Record<string, KnownTest[]>>(KNOWN_TESTS_KEY) ?? {};
  }

  async function rememberTests(folderPath: string, tests: KnownTest[]): Promise<void> {
    await context.workspaceState.update(KNOWN_TESTS_KEY, { ...knownTests(), [folderPath]: tests });
  }

  function restoreFolder(folder: vscode.WorkspaceFolder): void {
    const root = folderItem(folder);
    const remembered = knownTests()[folder.uri.fsPath] ?? [];
    if (remembered.length === 0) return;

    // Grouped by suite first — recreating a suite item mid-loop would drop
    // siblings already added under it.
    const bySuite = new Map<string, KnownTest[]>();
    for (const test of remembered) {
      bySuite.set(test.suite, [...(bySuite.get(test.suite) ?? []), test]);
    }

    for (const [suite, tests] of bySuite) {
      const suiteFile = tests.find((test) => test.file)?.file;
      const suiteItem = childItem(
        root,
        suiteItemId(folder.uri.fsPath, suite),
        suiteLabel(suite),
        suiteFile ? vscode.Uri.file(suiteFile) : undefined,
      );
      suiteItem.description = suiteDescription(suite);
      for (const test of tests) {
        childItem(
          suiteItem,
          testItemId(folder.uri.fsPath, suite, test.name),
          test.name,
          test.file ? vscode.Uri.file(test.file) : undefined,
        );
      }
    }
    root.description = undefined;
  }

  function syncFolders(): void {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const live = new Set(folders.map((folder) => folderItemId(folder.uri.fsPath)));
    for (const id of idsOf(controller.items)) {
      if (!live.has(id)) {
        controller.items.delete(id);
      }
    }
    for (const folder of folders) {
      restoreFolder(folder);
    }
  }

  syncFolders();
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(syncFolders));

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
    resolver: TestLocationResolver,
  ): Promise<void> {
    const folderPath = folder.uri.fsPath;
    const root = folderItem(folder);
    const remembered: KnownTest[] = [];
    const liveSuites = new Set<string>();
    const liveTests = new Map<string, Set<string>>();
    const reported = new Map<string, TestStatus>();

    for (const testCase of run.results) {
      const suite = suiteKey(testCase.testSuite);
      const testId = testItemId(folderPath, suite, testCase.testName);
      // A name repeated in one suite (unnamed cases, a rerun) shares one item: the worse outcome stands.
      const previous = reported.get(testId);
      if (previous !== undefined && SEVERITY[previous] >= SEVERITY[testCase.status]) continue;
      reported.set(testId, testCase.status);

      const location = await resolver.resolveTestLocation(testCase.testSuite, testCase.stackTrace);
      const suiteFile = await resolver.resolveSuiteFile(testCase.testSuite);

      const suiteId = suiteItemId(folderPath, suite);
      const suiteItem = childItem(
        root,
        suiteId,
        suiteLabel(suite),
        suiteFile ? vscode.Uri.file(suiteFile) : undefined,
      );
      suiteItem.description = suiteDescription(suite);
      liveSuites.add(suiteId);

      const item = childItem(
        suiteItem,
        testId,
        testCase.testName,
        location ? vscode.Uri.file(location.file) : undefined,
      );
      if (location?.line !== undefined) {
        item.range = lineRange(location.line);
      }
      liveTests.set(suiteId, (liveTests.get(suiteId) ?? new Set()).add(testId));
      if (previous === undefined) {
        remembered.push({ suite, name: testCase.testName, file: location?.file });
      }

      testRun.started(item);
      reportResult(testRun, item, testCase, location);
    }

    for (const suiteId of idsOf(root.children)) {
      const suiteItem = root.children.get(suiteId);
      if (!suiteItem) continue;
      if (!liveSuites.has(suiteId)) {
        root.children.delete(suiteId);
        continue;
      }
      const kept = liveTests.get(suiteId) ?? new Set<string>();
      for (const testId of idsOf(suiteItem.children)) {
        if (!kept.has(testId)) {
          suiteItem.children.delete(testId);
        }
      }
    }

    root.description = undefined;
    await rememberTests(folderPath, remembered);
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

  async function gatherEvidence(
    run: NormalizedTestRun,
    folder: vscode.WorkspaceFolder,
    resolver: TestLocationResolver,
  ): Promise<TestEvidence | undefined> {
    try {
      const evidence = await collectTestEvidence(run, resolver, {
        folderPath: folder.uri.fsPath,
        ...getSourceCaptureSettings(folder.uri.fsPath),
      });
      const { sources, files } = evidence.payload;
      const located = sources.filter((source) => source.kind === 'TEST').length;
      const fileChars = files.reduce((total, file) => total + (file.content?.length ?? 0), 0);
      deps.logger.log(
        `Located ${located}/${run.results.length} tests in ${files.length} file(s) (${fileChars} chars).`,
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

      // Shared with source capture, whose second pass over the results then reuses the probe cache.
      const resolver = new TestLocationResolver(folder.uri.fsPath, run.platform);
      await applyResults(testRun, folder, run, resolver);
      deps.status.result(summary);

      if (!submit) {
        deps.logger.log('Run complete (not submitted).');
        return;
      }

      const evidence = await gatherEvidence(run, folder, resolver);
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
