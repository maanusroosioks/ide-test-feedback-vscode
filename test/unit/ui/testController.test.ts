import { readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import type { AdapterRegistry } from '../../../src/runner/registry';
import type { AuthService, GetAccessTokenOptions } from '../../../src/auth/authService';
import { collectTestEvidence } from '../../../src/capture/evidence';
import { TestFileFinder } from '../../../src/capture/discovery';
import { locateResults, type SourceFileCache } from '../../../src/capture/sourceFiles';
import { CancelledError } from '../../../src/core/errors';
import { WORKSPACE_CONFIG_FILE_NAME } from '../../../src/core/workspaceConfig';
import { submitRun } from '../../../src/core/submitRun';
import { runTests, type RunTestsOptions } from '../../../src/core/testRunner';
import type { NormalizedTestCase } from '../../../src/core/types';
import type { MoodleApiClient } from '../../../src/services/moodleApiClient';
import type { PerformRunOptions } from '../../../src/ui/runFolder';
import { registerTestController } from '../../../src/ui/testController';
import { RESCAN_DELAY_MS } from '../../../src/ui/testDiscovery';
import {
  fakeStatus,
  recordingLogger,
  registryWith,
  stubAdapter,
  testRun,
  writeWorkspaceConfig,
  type RecordingLogger,
} from '../helpers/fakes';
import { tempDir, writeTree } from '../helpers/fs';
import {
  Range,
  TestMessage,
  TestRunProfileKind,
  TestRunRequest,
  Uri,
  asContext,
  configValues,
  fakeExtensionContext,
  fireFileEvent,
  tests,
  window,
  workspace,
  workspaceFolder,
  type FakeExtensionContext,
  type FakeTestController,
  type FakeTestItem,
} from '../helpers/vscodeStub';

vi.mock('../../../src/core/testRunner', () => ({ runTests: vi.fn() }));
vi.mock('../../../src/core/submitRun', () => ({ submitRun: vi.fn() }));
vi.mock('../../../src/capture/evidence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/capture/evidence')>();
  return { ...actual, collectTestEvidence: vi.fn(actual.collectTestEvidence) };
});
vi.mock('../../../src/capture/sourceFiles', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/capture/sourceFiles')>();
  return { ...actual, locateResults: vi.fn(actual.locateResults) };
});

const KNOWN_TESTS_KEY = 'moodleSubmit.knownTests';
const SUITE = 'tests.test_math';

const TEST_FILE = `def test_add():
    assert 1 + 1 == 2


def test_subtract():
    assert 3 - 1 == 1


def test_emptied():
    pass
`;

let folderPath: string;
let testFile: string;
let context: FakeExtensionContext;
let logger: RecordingLogger;

beforeEach(async () => {
  vi.mocked(runTests).mockReset();
  vi.mocked(submitRun).mockReset();
  vi.mocked(collectTestEvidence).mockClear();
  vi.mocked(locateResults).mockClear();

  folderPath = await tempDir();
  testFile = join(folderPath, 'tests', 'test_math.py');
  await writeTree(folderPath, { 'tests/test_math.py': TEST_FILE });
  await writeWorkspaceConfig(folderPath, { assignmentKey: 'assignment-7' });
  workspace.workspaceFolders = [workspaceFolder(folderPath, 'calculator')];
  workspace.getWorkspaceFolder.mockImplementation((uri) =>
    workspace.workspaceFolders?.find((folder) => uri.fsPath.startsWith(folder.uri.fsPath)),
  );
  configValues.set('serviceUrl', 'https://bridge.example.edu');

  context = fakeExtensionContext();
  logger = recordingLogger();
});

/** The registry only feeds discovery here: `runTests` is mocked. */
function setup(registry: AdapterRegistry = registryWith(stubAdapter('pytest'))) {
  const status = fakeStatus();
  const authService = { getAccessToken: vi.fn(async (_options?: GetAccessTokenOptions) => 'token-abc') };
  const control = registerTestController(asContext(context), {
    registry,
    authService: authService as unknown as AuthService,
    apiClient: {} as MoodleApiClient,
    logger,
    status,
  });
  const controller = tests.createTestController.mock.results[0].value as FakeTestController;
  return { control, controller, status, authService };
}

function testsRan(results: NormalizedTestCase[], onRun?: (options: RunTestsOptions) => void): void {
  vi.mocked(runTests).mockImplementation(async (_registry, _folder, options) => {
    onRun?.(options);
    const failed = results.filter((r) => r.status === 'FAILED' || r.status === 'ERROR').length;
    const skipped = results.filter((r) => r.status === 'SKIPPED').length;
    const passed = results.filter((r) => r.status === 'PASSED').length;
    return {
      run: testRun(results),
      summary: { total: results.length, passed, failed, skipped },
    };
  });
}

function performRun(control: ReturnType<typeof setup>['control'], options: Partial<PerformRunOptions> = {}) {
  return control.performRun({ folder: workspace.workspaceFolders![0], submit: false, ...options });
}

const TEST_PATH = 'tests/test_math.py';

const fileId = (relativePath = TEST_PATH): string => `${folderPath}::/${relativePath}`;
const declId = (name: string, relativePath = TEST_PATH): string => `${fileId(relativePath)}::::${name}`;
const resultId = (parentId: string, name: string): string => `${parentId}::run:${name}`;
const suiteId = (suite: string): string => `${folderPath}::${suite}`;
const suiteTestId = (name: string, suite: string): string => `${folderPath}::${suite}::${name}`;

function folderNode(controller: FakeTestController): FakeTestItem {
  return controller.items.get(folderPath)!;
}

function fileNode(controller: FakeTestController, relativePath = TEST_PATH): FakeTestItem | undefined {
  return folderNode(controller).children.get(fileId(relativePath));
}

function testNode(controller: FakeTestController, name: string, relativePath = TEST_PATH): FakeTestItem | undefined {
  return fileNode(controller, relativePath)?.children.get(declId(name, relativePath));
}

function suiteNode(controller: FakeTestController, suite: string): FakeTestItem | undefined {
  return folderNode(controller).children.get(suiteId(suite));
}

/** What VS Code does when the Testing view first needs the tree. */
async function discover(controller: FakeTestController): Promise<void> {
  await controller.resolveHandler?.(undefined);
}

/** Long enough for a debounced rescan to have run, for asserting that it changed nothing. */
function rescanSettled(): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, RESCAN_DELAY_MS + 100));
}

const PASSING: NormalizedTestCase[] = [
  { testSuite: SUITE, testName: 'test_add', status: 'PASSED', durationMs: 3 },
];

describe('registerTestController — tree', () => {
  it('registers one default Run profile on a disposable controller', () => {
    const { controller } = setup();

    expect(tests.createTestController).toHaveBeenCalledWith('moodleSubmit.tests', 'Moodle Tests');
    expect(context.subscriptions).toContain(controller);
    expect(controller.profiles).toEqual([
      expect.objectContaining({ label: 'Run Tests', kind: TestRunProfileKind.Run, isDefault: true }),
    ]);
  });

  it('shows each workspace folder as a placeholder until its tests are discovered', () => {
    const { controller } = setup();

    const root = folderNode(controller);
    expect(root.label).toBe('calculator');
    expect(root.description).toBe('run to discover tests');
    expect(root.children.size).toBe(0);
  });

  it('discovers the tests declared in the source when the Testing view asks for them', async () => {
    const { controller } = setup();

    await discover(controller);

    expect(folderNode(controller).description).toBeUndefined();
    const file = fileNode(controller);
    expect(file?.label).toBe('test_math.py');
    expect(file?.description).toBe('tests');
    expect(file?.uri?.fsPath).toBe(testFile);
    expect(file?.children.ids()).toEqual([declId('test_add'), declId('test_subtract'), declId('test_emptied')]);
    expect(testNode(controller, 'test_add')?.uri?.fsPath).toBe(testFile);
    expect(testNode(controller, 'test_add')?.range).toEqual(new Range(0, 0, 1, '    assert 1 + 1 == 2'.length));
    expect(testNode(controller, 'test_subtract')?.range?.startLine).toBe(4);
  });

  it('nests a test under each class it is declared in, except one named after its file', async () => {
    await writeTree(folderPath, {
      'src/test/java/CalculatorTest.java': [
        'class CalculatorTest {',
        '  @Test void adds() {}',
        '  @Nested class Division {',
        '    @Test void divides() {}',
        '  }',
        '}',
      ].join('\n'),
    });
    const { controller } = setup(registryWith(stubAdapter('maven-junit', { platform: 'jvm' })));

    await discover(controller);

    const javaFile = 'src/test/java/CalculatorTest.java';
    const file = fileNode(controller, javaFile)!;
    const nested = file.children.get(`${fileId(javaFile)}::CalculatorTest.Division`);
    expect(file.children.ids()).toEqual([
      `${fileId(javaFile)}::CalculatorTest::adds`,
      `${fileId(javaFile)}::CalculatorTest.Division`,
    ]);
    expect(nested?.label).toBe('Division');
    expect(nested?.children.ids()).toEqual([`${fileId(javaFile)}::CalculatorTest.Division::divides`]);
  });

  it('tells apart two tests declared under the same name by their order', async () => {
    await writeTree(folderPath, {
      [TEST_PATH]: 'def test_twice():\n    assert True\n\ndef test_twice():\n    assert False\n',
    });
    const { controller } = setup();

    await discover(controller);

    expect(fileNode(controller)?.children.ids()).toEqual([declId('test_twice'), `${declId('test_twice')}#2`]);
  });

  it('keeps the placeholder for a folder with no tests to discover', async () => {
    await rm(join(folderPath, 'tests'), { recursive: true });
    const { controller } = setup();

    await discover(controller);

    expect(folderNode(controller).description).toBe('run to discover tests');
    expect(folderNode(controller).children.size).toBe(0);
  });

  it('discovers nothing in a folder no test adapter recognises', async () => {
    const { controller } = setup(registryWith());

    await discover(controller);

    expect(folderNode(controller).children.size).toBe(0);
  });

  it('clears the test list that versions before discovery remembered', async () => {
    await context.workspaceState.update(KNOWN_TESTS_KEY, { [folderPath]: [{ suite: SUITE, name: 'test_add' }] });

    setup();

    expect(context.workspaceState.get(KNOWN_TESTS_KEY)).toBeUndefined();
  });

  it('follows workspace folders being added and removed', async () => {
    const { controller } = setup();
    const onFoldersChanged = workspace.onDidChangeWorkspaceFolders.mock.calls[0][0];
    const other = await tempDir();

    workspace.workspaceFolders = [workspaceFolder(other, 'other')];
    onFoldersChanged();

    expect(controller.items.ids()).toEqual([other]);
  });

  it('discovers the tests of a folder added once discovery has started', async () => {
    const { controller } = setup();
    await discover(controller);
    const other = await tempDir();
    await writeTree(other, { 'test_other.py': 'def test_it():\n    assert True\n' });

    workspace.workspaceFolders = [...workspace.workspaceFolders!, workspaceFolder(other, 'other', 1)];
    workspace.onDidChangeWorkspaceFolders.mock.calls[0][0]();

    await vi.waitFor(() => expect(controller.items.get(other)?.children.ids()).toEqual([`${other}::/test_other.py`]));
  });
});

describe('registerTestController — keeping up with edits', () => {
  it('adds a test as soon as its file is saved', async () => {
    const { controller } = setup();
    await discover(controller);

    await writeTree(folderPath, { [TEST_PATH]: `${TEST_FILE}\n\ndef test_multiply():\n    assert 2 * 3 == 6\n` });
    fireFileEvent('change', testFile);

    await vi.waitFor(() => expect(testNode(controller, 'test_multiply')).toBeDefined());
    expect(fileNode(controller)?.children.size).toBe(4);
  });

  it('drops a test removed from its file, and the file once it holds none', async () => {
    const { controller } = setup();
    await discover(controller);

    await writeTree(folderPath, { [TEST_PATH]: 'def test_add():\n    assert 1 + 1 == 2\n' });
    fireFileEvent('change', testFile);
    await vi.waitFor(() => expect(fileNode(controller)?.children.ids()).toEqual([declId('test_add')]));

    await writeTree(folderPath, { [TEST_PATH]: 'def helper():\n    return 1\n' });
    fireFileEvent('change', testFile);
    await vi.waitFor(() => expect(fileNode(controller)).toBeUndefined());
    expect(folderNode(controller).description).toBe('run to discover tests');
  });

  it('picks up a new test file', async () => {
    const { controller } = setup();
    await discover(controller);

    await writeTree(folderPath, { 'tests/test_new.py': 'def test_it():\n    assert True\n' });
    fireFileEvent('create', join(folderPath, 'tests', 'test_new.py'));

    await vi.waitFor(() => expect(testNode(controller, 'test_it', 'tests/test_new.py')).toBeDefined());
  });

  it('ignores a new file that is not a test file, however test-like its contents', async () => {
    const { controller } = setup();
    await discover(controller);

    await writeTree(folderPath, { 'helpers.py': 'def test_helper():\n    return 1\n' });
    fireFileEvent('create', join(folderPath, 'helpers.py'));
    await rescanSettled();

    expect(folderNode(controller).children.ids()).toEqual([fileId()]);
  });

  it('removes a deleted test file, and every test file under a deleted folder', async () => {
    await writeTree(folderPath, { 'other/test_other.py': 'def test_it():\n    assert True\n' });
    const { controller } = setup();
    await discover(controller);
    expect(folderNode(controller).children.size).toBe(2);

    fireFileEvent('delete', join(folderPath, 'other', 'test_other.py'));
    expect(folderNode(controller).children.ids()).toEqual([fileId()]);

    fireFileEvent('delete', join(folderPath, 'tests'));
    expect(folderNode(controller).children.size).toBe(0);
    expect(folderNode(controller).description).toBe('run to discover tests');
  });

  it('scans a test file when it is opened, without the Testing view', async () => {
    const { controller } = setup();
    const onOpened = workspace.onDidOpenTextDocument.mock.calls[0][0];

    onOpened({ uri: Uri.file(testFile) });

    await vi.waitFor(() => expect(testNode(controller, 'test_add')).toBeDefined());
  });

  it('scans the test files already open at startup', async () => {
    workspace.textDocuments = [{ uri: Uri.file(testFile) }];

    const { controller } = setup();

    await vi.waitFor(() => expect(testNode(controller, 'test_add')).toBeDefined());
  });

  it('finds the tests in a renamed folder, which reports only the folder itself', async () => {
    const { controller } = setup();
    await discover(controller);

    await rename(join(folderPath, 'tests'), join(folderPath, 'spec'));
    fireFileEvent('delete', join(folderPath, 'tests'));
    fireFileEvent('create', join(folderPath, 'spec'));

    await vi.waitFor(() => expect(testNode(controller, 'test_add', 'spec/test_math.py')).toBeDefined());
    expect(fileNode(controller)).toBeUndefined();
  });

  it('keeps a file that a rescan added while a slower discovery was still walking', async () => {
    const { controller } = setup();
    const original = TestFileFinder.prototype.discover;
    let walkDone = (): void => {};
    const walkFinished = new Promise<void>((resolveWalk) => (walkDone = resolveWalk));
    let release = (): void => {};
    const released = new Promise<void>((resolveRelease) => (release = resolveRelease));
    const spy = vi
      .spyOn(TestFileFinder.prototype, 'discover')
      .mockImplementationOnce(async function (this: TestFileFinder, files: SourceFileCache) {
        const found = await original.call(this, files);
        walkDone();
        await released;
        return found;
      });

    try {
      const discovering = discover(controller);
      await walkFinished;
      // Too late for the walk to see: only the rescan can add it.
      await writeTree(folderPath, { 'tests/test_new.py': 'def test_it():\n    assert True\n' });
      fireFileEvent('create', join(folderPath, 'tests', 'test_new.py'));
      await vi.waitFor(() => expect(fileNode(controller, 'tests/test_new.py')).toBeDefined());

      release();
      await discovering;

      expect(fileNode(controller, 'tests/test_new.py')).toBeDefined();
      expect(fileNode(controller)).toBeDefined();
    } finally {
      spy.mockRestore();
    }
  });

  it('finds the tests once the folder gains the build file that identifies it', async () => {
    const detect = vi.fn(async () => false);
    const { controller } = setup(registryWith(stubAdapter('pytest', { detect })));
    await discover(controller);
    expect(folderNode(controller).children.size).toBe(0);

    detect.mockResolvedValue(true);
    fireFileEvent('change', testFile);

    await vi.waitFor(() => expect(testNode(controller, 'test_add')).toBeDefined());
  });

  it('keeps a test file only a run could find up to date, and through rediscovery', async () => {
    // Named for a custom `python_files`, so discovery alone never looks at it.
    const checkFile = join(folderPath, 'tests', 'check_math.py');
    await writeTree(folderPath, { 'tests/check_math.py': 'def test_it():\n    assert True\n' });
    const { control, controller } = setup();
    testsRan([{ testSuite: 'tests.check_math', testName: 'test_it', status: 'PASSED' }]);
    await performRun(control);
    expect(testNode(controller, 'test_it', 'tests/check_math.py')).toBeDefined();

    await writeTree(folderPath, {
      'tests/check_math.py': 'def test_it():\n    assert True\n\n\ndef test_more():\n    assert True\n',
    });
    fireFileEvent('change', checkFile);
    await vi.waitFor(() => expect(testNode(controller, 'test_more', 'tests/check_math.py')).toBeDefined());

    await discover(controller);
    expect(fileNode(controller, 'tests/check_math.py')).toBeDefined();
  });
});

describe('performRun — results', () => {
  it('reports each outcome against the test declared in the source', async () => {
    const { control, controller } = setup();
    testsRan([
      { testSuite: SUITE, testName: 'test_add', status: 'PASSED', durationMs: 3 },
      {
        testSuite: SUITE,
        testName: 'test_subtract',
        status: 'FAILED',
        durationMs: 4,
        message: 'assert 2 == 1',
        stackTrace: 'tests/test_math.py:6: AssertionError',
      },
      { testSuite: SUITE, testName: 'test_emptied', status: 'SKIPPED' },
      { testSuite: SUITE, testName: 'test_broken', status: 'ERROR' },
    ]);

    await performRun(control);

    const [run] = controller.runs;
    expect(run.name).toBe('Run Tests');
    expect(run.startedIds).toHaveLength(4);
    expect(run.outcomes.get(declId('test_add'))).toEqual({ status: 'passed', durationMs: 3 });
    expect(run.outcomes.get(declId('test_subtract'))?.status).toBe('failed');
    expect(run.outcomes.get(declId('test_emptied'))).toEqual({ status: 'skipped' });
    // Ran, but declared nowhere in the file it was traced to.
    expect(run.outcomes.get(resultId(fileId(), 'test_broken'))).toMatchObject({
      status: 'errored',
      message: new TestMessage('ERROR with no reported message.'),
    });
    expect(run.ended).toBe(true);
    expect(folderNode(controller).description).toBeUndefined();
  });

  it('gives a passing test the line of its declaration', async () => {
    const { control, controller } = setup();
    testsRan(PASSING);

    await performRun(control);

    expect(testNode(controller, 'test_add')?.range?.startLine).toBe(0);
  });

  it('shows the worse outcome when one name is reported twice', async () => {
    const { control, controller } = setup();
    testsRan([
      { testSuite: SUITE, testName: 'test_add', status: 'FAILED', message: 'assert 1 == 2' },
      { testSuite: SUITE, testName: 'test_add', status: 'PASSED' },
      { testSuite: SUITE, testName: 'test_sub', status: 'PASSED' },
      { testSuite: SUITE, testName: 'test_sub', status: 'ERROR' },
    ]);

    await performRun(control);

    const [run] = controller.runs;
    expect(run.outcomes.get(declId('test_add'))?.status).toBe('failed');
    expect(run.outcomes.get(resultId(fileId(), 'test_sub'))?.status).toBe('errored');
  });

  it('points a failure message at the line from its stack trace', async () => {
    const { control, controller } = setup();
    testsRan([
      {
        testSuite: SUITE,
        testName: 'test_subtract',
        status: 'FAILED',
        message: 'assert 2 == 1',
        stackTrace: 'tests/test_math.py:6: AssertionError',
      },
    ]);

    await performRun(control);

    const outcome = controller.runs[0].outcomes.get(declId('test_subtract'));
    expect(outcome?.status).toBe('failed');
    const message = (outcome as { message: TestMessage }).message;
    expect(message.message).toBe('assert 2 == 1\n\ntests/test_math.py:6: AssertionError');
    expect(message.location?.uri.fsPath).toBe(testFile);
    expect(message.location?.range.startLine).toBe(5);

    // The test itself keeps the line it is declared on.
    expect(testNode(controller, 'test_subtract')?.range?.startLine).toBe(4);
  });

  it('shows each case of a parameterized test under the test', async () => {
    const { control, controller } = setup();
    testsRan([
      { testSuite: SUITE, testName: 'test_add[1-2]', status: 'PASSED' },
      { testSuite: SUITE, testName: 'test_add[2-3]', status: 'FAILED', message: 'assert 5 == 6' },
    ]);

    await performRun(control);

    const declared = testNode(controller, 'test_add')!;
    const cases = [resultId(declared.id, 'test_add[1-2]'), resultId(declared.id, 'test_add[2-3]')];
    expect(declared.children.ids()).toEqual(cases);
    expect(declared.children.get(cases[0])?.label).toBe('test_add[1-2]');
    expect(declared.children.get(cases[0])?.range).toEqual(declared.range);
    expect(controller.runs[0].outcomes.get(cases[0])?.status).toBe('passed');
    expect(controller.runs[0].outcomes.get(cases[1])?.status).toBe('failed');
  });

  it('reports on the test itself again once it runs under one name', async () => {
    const { control, controller } = setup();
    testsRan([
      { testSuite: SUITE, testName: 'test_add[1-2]', status: 'PASSED' },
      { testSuite: SUITE, testName: 'test_add[2-3]', status: 'PASSED' },
    ]);
    await performRun(control);

    testsRan(PASSING);
    await performRun(control);

    expect(testNode(controller, 'test_add')?.children.size).toBe(0);
    expect(controller.runs[1].outcomes.get(declId('test_add'))?.status).toBe('passed');
  });

  it('moves the cases of a parameterized test along with it when its file is edited', async () => {
    const { control, controller } = setup();
    testsRan([
      { testSuite: SUITE, testName: 'test_add[1-2]', status: 'PASSED' },
      { testSuite: SUITE, testName: 'test_add[2-3]', status: 'PASSED' },
    ]);
    await performRun(control);

    await writeTree(folderPath, { [TEST_PATH]: `import math\n\n\n${TEST_FILE}` });
    fireFileEvent('change', testFile);

    await vi.waitFor(() => expect(testNode(controller, 'test_add')?.range?.startLine).toBe(3));
    const declared = testNode(controller, 'test_add')!;
    expect(declared.children.size).toBe(2);
    declared.children.forEach((child) => expect(child.range).toEqual(declared.range));
  });

  it('tells apart the runs of a test inherited by several suites', async () => {
    const { control, controller } = setup();
    testsRan([
      { testSuite: SUITE, testName: 'test_add', status: 'PASSED' },
      {
        testSuite: 'tests.test_other',
        testName: 'test_add',
        status: 'FAILED',
        message: 'assert 1 == 2',
        stackTrace: 'tests/test_math.py:2: AssertionError',
      },
    ]);

    await performRun(control);

    const declared = testNode(controller, 'test_add')!;
    const runs = [resultId(declared.id, `${SUITE}::test_add`), resultId(declared.id, 'tests.test_other::test_add')];
    expect(declared.children.ids()).toEqual(runs);
    expect(declared.children.get(runs[0])?.description).toBe('test_math');
    expect(declared.children.get(runs[1])?.description).toBe('test_other');
    expect(controller.runs[0].outcomes.get(runs[0])?.status).toBe('passed');
    expect(controller.runs[0].outcomes.get(runs[1])?.status).toBe('failed');
  });

  it('still shows and submits the results when tracing them to the source fails', async () => {
    const { control, controller } = setup();
    testsRan(PASSING);
    vi.mocked(locateResults).mockRejectedValueOnce(new Error('scanner bug'));

    await performRun(control, { submit: true });

    expect(logger.messages).toContain('Could not trace the results to the source: scanner bug');
    expect(controller.runs[0].outcomes.get(suiteTestId('test_add', SUITE))?.status).toBe('passed');
    // No evidence rather than evidence claiming every test is missing, which would warn of tampering.
    expect(window.showWarningMessage).not.toHaveBeenCalled();
    expect(submitRun).toHaveBeenCalledOnce();
    expect(vi.mocked(submitRun).mock.calls[0][1].evidence).toBeUndefined();
  });

  it('keeps declared tests that did not run, but drops results that no longer ran', async () => {
    const { control, controller } = setup();
    testsRan([
      { testSuite: SUITE, testName: 'test_add', status: 'PASSED' },
      { testSuite: SUITE, testName: 'test_broken', status: 'PASSED' },
      { testSuite: 'tests.test_old', testName: 'test_gone', status: 'PASSED' },
    ]);
    await performRun(control);
    expect(folderNode(controller).children.ids()).toEqual([fileId(), suiteId('tests.test_old')]);

    testsRan(PASSING);
    await performRun(control);

    expect(folderNode(controller).children.ids()).toEqual([fileId()]);
    expect(fileNode(controller)?.children.ids()).toEqual([
      declId('test_add'),
      declId('test_subtract'),
      declId('test_emptied'),
    ]);
  });

  it('groups results traced to no file under the suite the report names', async () => {
    const { control, controller } = setup();
    testsRan([{ testName: 'lonely', status: 'PASSED' }]);

    await performRun(control);

    expect(suiteNode(controller, '(no suite)')?.children.ids()).toEqual([suiteTestId('lonely', '(no suite)')]);
  });

  it('moves a result into its file once the file appears', async () => {
    const { control, controller } = setup();
    const suite = 'tests.test_new';
    testsRan([{ testSuite: suite, testName: 'test_it', status: 'PASSED' }]);
    await performRun(control);
    expect(suiteNode(controller, suite)?.children.ids()).toEqual([suiteTestId('test_it', suite)]);

    await writeTree(folderPath, { 'tests/test_new.py': 'def test_it():\n    assert True\n' });
    await performRun(control);

    expect(testNode(controller, 'test_it', 'tests/test_new.py')?.uri?.fsPath).toBe(
      join(folderPath, 'tests', 'test_new.py'),
    );
    expect(suiteNode(controller, suite)).toBeUndefined();
  });

  it('streams tool output into the run with CRLF line endings', async () => {
    const { control, controller } = setup();
    testsRan(PASSING, ({ onOutput }) => onOutput?.('collected 1 item\n\ntest_math.py .\r\n', 'stdout'));

    await performRun(control);

    expect(controller.runs[0].output).toBe('collected 1 item\r\n\r\ntest_math.py .\r\n');
  });

  it('updates the status bar and stops short of submitting', async () => {
    const { control, status, authService } = setup();
    testsRan(PASSING);
    const report = vi.fn();

    await performRun(control, { report });

    expect(status.running).toHaveBeenCalledOnce();
    expect(status.result).toHaveBeenCalledWith({ total: 1, passed: 1, failed: 0, skipped: 0 });
    expect(report.mock.calls).toEqual([['Running tests…']]);
    expect(logger.messages).toContain('Run complete (not submitted).');
    expect(authService.getAccessToken).not.toHaveBeenCalled();
    expect(submitRun).not.toHaveBeenCalled();
  });

  it('uses the request it was given for the test run', async () => {
    const { control, controller } = setup();
    testsRan(PASSING);
    const request = new TestRunRequest();

    await performRun(control, { request: request as unknown as vscode.TestRunRequest });

    expect(controller.runs[0].request).toBe(request);
  });

  it('writes the error into the run output, ends the run, and rethrows', async () => {
    const { control, controller } = setup();
    vi.mocked(runTests).mockRejectedValue(new Error('mvn: command not found'));

    await expect(performRun(control)).rejects.toThrow('mvn: command not found');

    expect(controller.runs[0].output).toBe('\r\nmvn: command not found\r\n');
    expect(controller.runs[0].ended).toBe(true);
  });
});

describe('performRun — cancellation', () => {
  function captureSignal(): { signal: () => AbortSignal } {
    let signal: AbortSignal | undefined;
    testsRan(PASSING, (options) => (signal = options.signal));
    return { signal: () => signal! };
  }

  it('aborts the tests when the Testing view stops the run', async () => {
    const { control, controller } = setup();
    let abortedAfterStop: boolean | undefined;
    testsRan(PASSING, ({ signal }) => {
      controller.runs[0].cancel();
      abortedAfterStop = signal?.aborted;
    });

    await performRun(control);

    expect(abortedAfterStop).toBe(true);
  });

  it('aborts the tests when the caller cancels', async () => {
    const { control } = setup();
    const caller = new AbortController();
    let abortedAfterCancel: boolean | undefined;
    testsRan(PASSING, ({ signal }) => {
      caller.abort();
      abortedAfterCancel = signal?.aborted;
    });

    await performRun(control, { signal: caller.signal });

    expect(abortedAfterCancel).toBe(true);
  });

  it('starts aborted when the caller already cancelled', async () => {
    const { control } = setup();
    const { signal } = captureSignal();

    await performRun(control, { signal: AbortSignal.abort() });

    expect(signal().aborted).toBe(true);
  });

  it('stops listening once the run is over', async () => {
    const { control, controller } = setup();
    const caller = new AbortController();
    const { signal } = captureSignal();

    await performRun(control, { signal: caller.signal });
    caller.abort();

    expect(signal().aborted).toBe(false);
    expect(controller.runs[0].cancelListenerCount).toBe(0);
  });
});

describe('performRun — submitting', () => {
  it('does nothing when the extension is not configured and the user backs out', async () => {
    configValues.delete('serviceUrl');
    const { control, controller } = setup();

    await performRun(control, { submit: true });

    expect(window.showWarningMessage).toHaveBeenCalledOnce();
    expect(controller.runs).toHaveLength(0);
    expect(runTests).not.toHaveBeenCalled();
  });

  it('asks for a missing assignment key before running, and stops if the user backs out', async () => {
    await rm(join(folderPath, WORKSPACE_CONFIG_FILE_NAME));
    const { control, controller } = setup();

    await performRun(control, { submit: true });

    expect(window.showWarningMessage).toHaveBeenCalledWith(
      '"calculator" has no assignment key. Add one to its .moodle-submit.json?',
      'Add key',
    );
    expect(controller.runs).toHaveLength(0);
    expect(runTests).not.toHaveBeenCalled();
  });

  it('catches an invalid key before running, rather than after the whole test run', async () => {
    await writeWorkspaceConfig(folderPath, { assignmentKey: 'week 3' });
    const { control, controller } = setup();

    await performRun(control, { submit: true });

    expect(window.showWarningMessage).toHaveBeenCalledWith(
      `The assignment key in "calculator"'s .moodle-submit.json can't be used: The assignment key may only contain letters, digits, '_' and '-'.`,
      'Fix key',
    );
    expect(controller.runs).toHaveLength(0);
    expect(runTests).not.toHaveBeenCalled();
  });

  it('accepts a key with stray spaces around it in the file', async () => {
    await writeWorkspaceConfig(folderPath, { assignmentKey: ' assignment-7 ' });
    const { control } = setup();
    testsRan(PASSING);

    await performRun(control, { submit: true });

    expect(window.showWarningMessage).not.toHaveBeenCalled();
    expect(runTests).toHaveBeenCalledOnce();
  });

  it('saves a key entered at the prompt and goes on to run', async () => {
    await rm(join(folderPath, WORKSPACE_CONFIG_FILE_NAME));
    window.showWarningMessage.mockResolvedValueOnce('Add key');
    window.showInputBox.mockResolvedValueOnce(' assignment-9 ');
    const { control } = setup();
    testsRan(PASSING);

    await performRun(control, { submit: true });

    expect(JSON.parse(await readFile(join(folderPath, WORKSPACE_CONFIG_FILE_NAME), 'utf8'))).toEqual({
      assignmentKey: 'assignment-9',
    });
    expect(submitRun).toHaveBeenCalledOnce();
  });

  it('does not ask for a key when only running', async () => {
    await rm(join(folderPath, WORKSPACE_CONFIG_FILE_NAME));
    const { control } = setup();
    testsRan(PASSING);

    await performRun(control, { submit: false });

    expect(window.showWarningMessage).not.toHaveBeenCalled();
    expect(runTests).toHaveBeenCalledOnce();
  });

  it('signs in first, then runs, then submits the run with its evidence', async () => {
    const { control, controller, authService } = setup();
    testsRan(PASSING);
    const report = vi.fn();

    await performRun(control, { submit: true, report });

    expect(controller.runs[0].name).toBe('Run & Submit to Moodle');
    expect(authService.getAccessToken).toHaveBeenCalledOnce();
    expect(report.mock.calls.map(([m]) => m)).toEqual(['Signing in…', 'Running tests…', 'Submitting to Moodle…']);

    const [run, submitContext] = vi.mocked(submitRun).mock.calls[0];
    expect(run.results).toEqual(PASSING);
    expect(submitContext).toMatchObject({ folderPath, projectName: 'calculator' });
    expect(submitContext.evidence?.sources).toEqual([
      { kind: 'TEST', filePath: 'tests/test_math.py', startLine: 1, endLine: 2 },
    ]);
    expect(submitContext.evidence?.files[0].content).toBe(TEST_FILE);

    expect(logger.messages).toContain('Located 1/1 tests in 1 file(s) (' + TEST_FILE.length + ' chars).');
    expect(logger.messages).toContain('Submitted successfully.');
    expect(controller.runs[0].output).toBe('\r\nSubmitted 1 test result(s) to Moodle.\r\n');
    expect(window.showInformationMessage).toHaveBeenCalledWith('Submitted 1 test result(s) to Moodle (1 passed).');
  });

  it('does not run the tests when sign-in fails', async () => {
    const { control, authService } = setup();
    authService.getAccessToken.mockRejectedValue(new CancelledError());

    await expect(performRun(control, { submit: true })).rejects.toBeInstanceOf(CancelledError);

    expect(runTests).not.toHaveBeenCalled();
  });

  it('frees the folder when the run is cancelled during sign-in', async () => {
    const { control, authService } = setup();
    const caller = new AbortController();
    authService.getAccessToken.mockImplementationOnce(
      ({ signal } = {}) =>
        new Promise<string>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new CancelledError()));
          caller.abort();
        }),
    );
    testsRan(PASSING);

    await expect(performRun(control, { submit: true, signal: caller.signal })).rejects.toBeInstanceOf(CancelledError);
    await performRun(control);

    expect(window.showInformationMessage).not.toHaveBeenCalledWith(expect.stringContaining('already running'));
    expect(runTests).toHaveBeenCalledOnce();
  });

  it('warns about an emptied test and submits only on confirmation', async () => {
    const { control } = setup();
    testsRan([...PASSING, { testSuite: SUITE, testName: 'test_emptied', status: 'PASSED' }]);
    window.showWarningMessage.mockResolvedValueOnce('Submit anyway');

    await performRun(control, { submit: true });

    expect(logger.messages).toContain('Integrity warning: tests.test_math.test_emptied — has an empty body');
    expect(window.showWarningMessage.mock.calls[0][0]).toBe(
      '1 of 2 tests look like they may have been emptied or disabled.',
    );
    expect(submitRun).toHaveBeenCalledOnce();
  });

  it('cancels the submission when the warning is declined', async () => {
    const { control, controller } = setup();
    testsRan([...PASSING, { testSuite: SUITE, testName: 'test_emptied', status: 'PASSED' }]);

    await performRun(control, { submit: true });

    expect(submitRun).not.toHaveBeenCalled();
    expect(logger.messages).toContain('Submission cancelled at the integrity warning.');
    expect(controller.runs[0].output).toBe('\r\nSubmission cancelled.\r\n');
    expect(controller.runs[0].ended).toBe(true);
  });

  it('skips the warning prompt when turned off, but still logs findings', async () => {
    configValues.set('warnOnSuspiciousTests', false);
    const { control } = setup();
    testsRan([{ testSuite: SUITE, testName: 'test_emptied', status: 'PASSED' }]);

    await performRun(control, { submit: true });

    expect(window.showWarningMessage).not.toHaveBeenCalled();
    expect(logger.messages).toContainEqual(expect.stringMatching(/^Integrity warning:/));
    expect(submitRun).toHaveBeenCalledOnce();
  });

  it('still submits, without evidence, when source capture fails', async () => {
    const { control } = setup();
    testsRan(PASSING);
    vi.mocked(collectTestEvidence).mockImplementationOnce(() => {
      throw new Error('disk on fire');
    });

    await performRun(control, { submit: true });

    expect(logger.messages).toContain('Could not capture test source: disk on fire');
    expect(vi.mocked(submitRun).mock.calls[0][1].evidence).toBeUndefined();
  });

  it('honors turning off source capture', async () => {
    configValues.set('submitTestSource', false);
    const { control } = setup();
    testsRan(PASSING);

    await performRun(control, { submit: true });

    const evidence = vi.mocked(submitRun).mock.calls[0][1].evidence;
    expect(evidence?.captureDisabled).toBe(true);
    expect(evidence?.files[0].content).toBeUndefined();
  });

  it('refuses a second run in a folder that is still running, which would clear its reports mid-build', async () => {
    const { control } = setup();
    let finish = (): void => {};
    vi.mocked(runTests).mockImplementationOnce(
      () =>
        new Promise((resolveRun) => {
          finish = () => resolveRun({ run: testRun(PASSING), summary: { total: 1, passed: 1, failed: 0, skipped: 0 } });
        }),
    );

    const first = performRun(control);
    await vi.waitFor(() => expect(runTests).toHaveBeenCalledOnce());
    await performRun(control);

    expect(runTests).toHaveBeenCalledOnce();
    expect(window.showInformationMessage).toHaveBeenCalledWith('Tests are already running in "calculator".');

    finish();
    await first;
    testsRan(PASSING);
    await performRun(control);
    expect(runTests).toHaveBeenCalledTimes(2);
  });

  it('surfaces a failed submission in the run output', async () => {
    const { control, controller } = setup();
    testsRan(PASSING);
    vi.mocked(submitRun).mockRejectedValue(new Error('Submission service returned 500'));

    await expect(performRun(control, { submit: true })).rejects.toThrow('Submission service returned 500');

    expect(controller.runs[0].output).toBe('\r\nSubmission service returned 500\r\n');
    expect(window.showInformationMessage).not.toHaveBeenCalled();
  });
});

describe('run profile and folderFor', () => {
  async function populate(
    control: ReturnType<typeof setup>['control'],
    folder = workspace.workspaceFolders![0],
  ): Promise<void> {
    testsRan(PASSING);
    await performRun(control, { folder });
    vi.mocked(runTests).mockClear();
  }

  it('runs the folder that owns the requested item', async () => {
    const other = workspaceFolder(await tempDir(), 'other');
    const calculator = workspaceFolder(folderPath, 'calculator', 1);
    workspace.workspaceFolders = [other, calculator];
    const { control, controller } = setup();
    await populate(control, calculator);

    await controller.profiles[0].handler(new TestRunRequest([testNode(controller, 'test_add')!]));

    expect(vi.mocked(runTests).mock.calls[0][1]).toBe(folderPath);
    expect(controller.runs[1].name).toBe('Run Tests');
  });

  it('falls back to the workspace folder for a run-all request', async () => {
    const { controller } = setup();
    testsRan(PASSING);

    await controller.profiles[0].handler(new TestRunRequest());

    expect(vi.mocked(runTests).mock.calls[0][1]).toBe(folderPath);
  });

  it("hands the folder's adapter settings to the run", async () => {
    configValues.set('preferredAdapter', 'pytest');
    configValues.set('testCommandOverrides', { pytest: 'pytest -x' });
    const { controller } = setup();
    testsRan(PASSING);

    await controller.profiles[0].handler(new TestRunRequest());

    expect(vi.mocked(runTests).mock.calls[0][2]).toMatchObject({
      preferredAdapterId: 'pytest',
      commandOverrides: { pytest: 'pytest -x' },
    });
  });

  it('runs every folder the selection spans, each once', async () => {
    const other = workspaceFolder(await tempDir(), 'other', 1);
    workspace.workspaceFolders = [workspace.workspaceFolders![0], other];
    const { controller } = setup();
    testsRan(PASSING);
    const root = (folder: typeof other) => controller.items.get(folder.uri.fsPath)!;

    await controller.profiles[0].handler(
      new TestRunRequest([root(other), root(workspace.workspaceFolders[0]), root(other)]),
    );

    expect(vi.mocked(runTests).mock.calls.map((call) => call[1])).toEqual([other.uri.fsPath, folderPath]);
  });

  it("keeps running the other folders when one folder's build fails", async () => {
    const other = workspaceFolder(await tempDir(), 'other', 1);
    workspace.workspaceFolders = [workspace.workspaceFolders![0], other];
    const { controller, status } = setup();
    testsRan(PASSING);
    vi.mocked(runTests).mockRejectedValueOnce(new Error('mvn: command not found'));
    const roots = workspace.workspaceFolders.map((folder) => controller.items.get(folder.uri.fsPath)!);

    await controller.profiles[0].handler(new TestRunRequest(roots));

    expect(vi.mocked(runTests)).toHaveBeenCalledTimes(2);
    expect(status.error).toHaveBeenCalledWith('mvn: command not found');
  });

  it('reports profile run failures through the status bar instead of throwing', async () => {
    const { controller, status } = setup();
    vi.mocked(runTests).mockRejectedValue(new Error('pytest: not found'));

    await expect(controller.profiles[0].handler(new TestRunRequest())).resolves.toBeUndefined();

    expect(status.error).toHaveBeenCalledWith('pytest: not found');
  });

  it('maps any item in the tree back to its workspace folder', async () => {
    const { control, controller } = setup();
    await populate(control);

    expect(control.folderFor(testNode(controller, 'test_add'))?.name).toBe('calculator');
    expect(control.folderFor(fileNode(controller))?.name).toBe('calculator');
    expect(control.folderFor(folderNode(controller))?.name).toBe('calculator');
  });

  it('ignores command arguments that are not test items', () => {
    const { control } = setup();

    expect(control.folderFor(undefined)).toBeUndefined();
    expect(control.folderFor(null)).toBeUndefined();
    expect(control.folderFor('uri-string')).toBeUndefined();
    expect(control.folderFor({ id: 'no-children' })).toBeUndefined();
  });

  it('returns undefined for an item whose folder has closed', async () => {
    const { control, controller } = setup();
    await populate(control);
    const item = testNode(controller, 'test_add');

    workspace.workspaceFolders = [];

    expect(control.folderFor(item)).toBeUndefined();
  });
});
