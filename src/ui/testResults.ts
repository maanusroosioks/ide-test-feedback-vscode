import * as vscode from 'vscode';
import type { SourceLocation, TestLocationResolver } from '../capture/location';
import type { LocatedResult, SourceFile } from '../capture/sourceFiles';
import type { NormalizedTestCase, NormalizedTestRun, TestStatus } from '../core/types';
import type { TestDeclaration } from '../scanning';
import { getOrCreate } from '../util/maps';
import type { RenderedFile, TestItemTree } from './testItemTree';
import { resultItemId, suiteDescription, suiteItemId, suiteKey, suiteLabel, testItemId } from './testItemIds';

const SEVERITY: Record<TestStatus, number> = { SKIPPED: 0, PASSED: 1, FAILED: 2, ERROR: 3 };

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
        message.location = new vscode.Location(vscode.Uri.file(location.file), lineRange(location.line));
      }
      if (testCase.status === 'FAILED') {
        testRun.failed(item, message, testCase.durationMs);
      } else {
        testRun.errored(item, message, testCase.durationMs);
      }
    }
  }
}

interface DeclarationRuns {
  runs: Set<string>;
  suites: Set<string>;
}

function runsByDeclaration(run: NormalizedTestRun, located: LocatedResult[]): Map<TestDeclaration, DeclarationRuns> {
  const byDeclaration = new Map<TestDeclaration, DeclarationRuns>();
  located.forEach(({ declaration }, index) => {
    if (!declaration) return;
    const { testSuite, testName } = run.results[index];
    const entry = getOrCreate(byDeclaration, declaration, () => ({
      runs: new Set<string>(),
      suites: new Set<string>(),
    }));
    entry.runs.add(`${suiteKey(testSuite)}\n${testName}`);
    entry.suites.add(suiteKey(testSuite));
  });
  return byDeclaration;
}

/** Finds or creates the item each result of one run reports on. */
class ResultPlacer {
  /** Every result item this run reported on; the ones from earlier runs that aren't here get pruned. */
  readonly liveResults = new Set<vscode.TestItem>();
  private readonly rendered = new Map<SourceFile, RenderedFile>();

  constructor(
    private readonly tree: TestItemTree,
    private readonly folder: vscode.WorkspaceFolder,
    private readonly resolver: TestLocationResolver,
    private readonly runs: Map<TestDeclaration, DeclarationRuns>,
  ) {}

  async itemFor(
    testCase: NormalizedTestCase,
    { location, file, declaration }: LocatedResult,
  ): Promise<vscode.TestItem | undefined> {
    if (file && declaration) return this.declaredItem(testCase, file, declaration);
    if (file && file.declarations.length > 0) return this.fileResultItem(testCase, file, location);
    return this.suiteResultItem(testCase, location);
  }

  /**
   * A declaration that ran once reports on itself. One that ran several times (parameterized
   * cases, theory data, an inherited test run by each subclass) gets a child per run.
   */
  private declaredItem(
    testCase: NormalizedTestCase,
    file: SourceFile,
    declaration: TestDeclaration,
  ): vscode.TestItem | undefined {
    const declared = this.render(file).items.get(declaration);
    const runs = this.runs.get(declaration);
    if (!declared || !runs || runs.runs.size === 1) return declared;

    // An inherited test has the same name in every suite that runs it: the suite tells them apart.
    const bySuite = runs.suites.size > 1;
    const suite = suiteKey(testCase.testSuite);
    const key = bySuite ? `${suite}::${testCase.testName}` : testCase.testName;
    const item = this.resultItem(declared, resultItemId(declared.id, key), testCase.testName, declared.uri);
    item.description = bySuite ? suiteLabel(suite) : undefined;
    item.range = declared.range;
    return item;
  }

  /** In a test file, but matching none of its declarations. */
  private fileResultItem(
    testCase: NormalizedTestCase,
    file: SourceFile,
    location: SourceLocation | undefined,
  ): vscode.TestItem {
    const { fileItem } = this.render(file);
    const id = resultItemId(fileItem.id, testCase.testName);
    const item = this.resultItem(fileItem, id, testCase.testName, fileItem.uri);
    if (location?.line !== undefined) item.range = lineRange(location.line);
    return item;
  }

  /** Traced to no test file at all: grouped under the suite the report names, as before discovery. */
  private async suiteResultItem(
    testCase: NormalizedTestCase,
    location: SourceLocation | undefined,
  ): Promise<vscode.TestItem> {
    const folderPath = this.folder.uri.fsPath;
    const suite = suiteKey(testCase.testSuite);
    const suiteFile = await this.resolver.resolveSuiteFile(testCase.testSuite);
    const suiteItem = this.resultItem(
      this.tree.folderItem(this.folder),
      suiteItemId(folderPath, suite),
      suiteLabel(suite),
      suiteFile ? vscode.Uri.file(suiteFile) : undefined,
    );
    suiteItem.description = suiteDescription(suite);
    const item = this.resultItem(
      suiteItem,
      testItemId(folderPath, suite, testCase.testName),
      testCase.testName,
      location ? vscode.Uri.file(location.file) : undefined,
    );
    if (location?.line !== undefined) item.range = lineRange(location.line);
    return item;
  }

  /** Each file is rendered once per run, however many of its results report on it. */
  private render(file: SourceFile): RenderedFile {
    return getOrCreate(this.rendered, file, () => this.tree.renderFile(this.folder, file));
  }

  private resultItem(parent: vscode.TestItem, id: string, label: string, uri?: vscode.Uri): vscode.TestItem {
    const item = this.tree.resultItem(parent, id, label, uri);
    this.liveResults.add(item);
    return item;
  }
}

/** Puts each result on the item for its declaration, creating items for what only a run reveals. */
export async function applyResults(
  tree: TestItemTree,
  testRun: vscode.TestRun,
  folder: vscode.WorkspaceFolder,
  run: NormalizedTestRun,
  located: LocatedResult[],
  resolver: TestLocationResolver,
): Promise<void> {
  const placer = new ResultPlacer(tree, folder, resolver, runsByDeclaration(run, located));
  const reported = new Map<string, TestStatus>();

  for (const [index, testCase] of run.results.entries()) {
    const entry = located[index] ?? {};
    const item = await placer.itemFor(testCase, entry);
    if (!item) continue;

    // A name repeated under one item (unnamed cases, a rerun) shares it: the worse outcome stands.
    const previous = reported.get(item.id);
    if (previous !== undefined && SEVERITY[previous] >= SEVERITY[testCase.status]) continue;
    reported.set(item.id, testCase.status);

    testRun.started(item);
    reportResult(testRun, item, testCase, entry.location);
  }

  tree.pruneResults(folder, placer.liveResults);
}
