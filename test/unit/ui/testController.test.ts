import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdapterRegistry } from '../../../src/adapters/registry';
import type { AuthService } from '../../../src/auth/authService';
import { collectTestEvidence } from '../../../src/capture/evidence';
import { CancelledError } from '../../../src/core/errors';
import { submitRun } from '../../../src/core/submitRun';
import { runTests, type RunTestsOptions } from '../../../src/core/testRunner';
import type { NormalizedTestCase } from '../../../src/core/types';
import type { MoodleApiClient } from '../../../src/services/moodleApiClient';
import { registerTestController, type PerformRunOptions } from '../../../src/ui/testController';
import type { KnownTest } from '../../../src/ui/testTree';
import {
  TestMessage,
  TestRunProfileKind,
  TestRunRequest,
  asContext,
  configValues,
  fakeExtensionContext,
  resetVscodeStub,
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
let logged: string[];

beforeEach(async () => {
  resetVscodeStub();
  vi.mocked(runTests).mockReset();
  vi.mocked(submitRun).mockReset();
  vi.mocked(collectTestEvidence).mockClear();

  folderPath = await mkdtemp(join(tmpdir(), 'moodle-controller-'));
  testFile = join(folderPath, 'tests', 'test_math.py');
  await mkdir(join(folderPath, 'tests'));
  await writeFile(testFile, TEST_FILE, 'utf8');
  workspace.workspaceFolders = [workspaceFolder(folderPath, 'calculator')];
  configValues.set('serviceUrl', 'https://bridge.example.edu');

  context = fakeExtensionContext();
  logged = [];
});

function setup() {
  const status = { running: vi.fn(), result: vi.fn(), error: vi.fn(), idle: vi.fn() };
  const authService = { getAccessToken: vi.fn(async () => 'token-abc') };
  const control = registerTestController(asContext(context), {
    registry: {} as AdapterRegistry,
    authService: authService as unknown as AuthService,
    apiClient: {} as MoodleApiClient,
    logger: { log: (message) => void logged.push(message) },
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
      run: { adapterId: 'pytest', platform: 'python', startedAt: 1, finishedAt: 2, results },
      summary: { total: results.length, passed, failed, skipped },
    };
  });
}

function performRun(control: ReturnType<typeof setup>['control'], options: Partial<PerformRunOptions> = {}) {
  return control.performRun({ folder: workspace.workspaceFolders![0], submit: false, ...options });
}

const suiteId = (suite = SUITE): string => `${folderPath}::${suite}`;
const testId = (name: string, suite = SUITE): string => `${folderPath}::${suite}::${name}`;

function folderNode(controller: FakeTestController): FakeTestItem {
  return controller.items.get(folderPath)!;
}

function suiteNode(controller: FakeTestController, suite = SUITE): FakeTestItem | undefined {
  return folderNode(controller).children.get(suiteId(suite));
}

function testNode(controller: FakeTestController, name: string, suite = SUITE): FakeTestItem | undefined {
  return suiteNode(controller, suite)?.children.get(testId(name, suite));
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

  it('shows each workspace folder as a placeholder until its first run', () => {
    const { controller } = setup();

    const root = folderNode(controller);
    expect(root.label).toBe('calculator');
    expect(root.description).toBe('run to discover tests');
    expect(root.children.size).toBe(0);
  });

  it('restores the tests remembered from an earlier session', async () => {
    const remembered: KnownTest[] = [
      { suite: SUITE, name: 'test_add', file: testFile },
      { suite: SUITE, name: 'test_subtract' },
      { suite: 'com.example.OtherTest', name: 'works' },
    ];
    await context.workspaceState.update(KNOWN_TESTS_KEY, { [folderPath]: remembered });

    const { controller } = setup();

    expect(folderNode(controller).description).toBeUndefined();
    expect(suiteNode(controller)?.label).toBe('test_math');
    expect(suiteNode(controller)?.description).toBe(SUITE);
    expect(suiteNode(controller)?.uri?.fsPath).toBe(testFile);
    expect(suiteNode(controller)?.children.ids()).toEqual([testId('test_add'), testId('test_subtract')]);
    expect(testNode(controller, 'test_add')?.uri?.fsPath).toBe(testFile);
    expect(testNode(controller, 'test_subtract')?.uri).toBeUndefined();
    expect(suiteNode(controller, 'com.example.OtherTest')?.uri).toBeUndefined();
  });

  it('follows workspace folders being added and removed', async () => {
    const { controller } = setup();
    const onFoldersChanged = workspace.onDidChangeWorkspaceFolders.mock.calls[0][0];
    const other = await mkdtemp(join(tmpdir(), 'moodle-controller-other-'));

    workspace.workspaceFolders = [workspaceFolder(other, 'other')];
    onFoldersChanged();

    expect(controller.items.ids()).toEqual([other]);
  });
});

describe('performRun — results', () => {
  it('reports each outcome against an item under folder › suite › test', async () => {
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
    expect(run.outcomes.get(testId('test_add'))).toEqual({ status: 'passed', durationMs: 3 });
    expect(run.outcomes.get(testId('test_emptied'))).toEqual({ status: 'skipped' });
    expect(run.outcomes.get(testId('test_broken'))).toMatchObject({
      status: 'errored',
      message: new TestMessage('ERROR with no reported message.'),
    });
    expect(run.ended).toBe(true);
    expect(folderNode(controller).description).toBeUndefined();
  });

  it('points a failure at the line from its stack trace', async () => {
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

    const outcome = controller.runs[0].outcomes.get(testId('test_subtract'));
    expect(outcome?.status).toBe('failed');
    const message = (outcome as { message: TestMessage }).message;
    expect(message.message).toBe('assert 2 == 1\n\ntests/test_math.py:6: AssertionError');
    expect(message.location?.uri.fsPath).toBe(testFile);
    expect(message.location?.range.startLine).toBe(5);

    const item = testNode(controller, 'test_subtract');
    expect(item?.uri?.fsPath).toBe(testFile);
    expect(item?.range?.startLine).toBe(5);
  });

  it('prunes tests and suites that no longer ran', async () => {
    const { control, controller } = setup();
    testsRan([
      { testSuite: SUITE, testName: 'test_add', status: 'PASSED' },
      { testSuite: SUITE, testName: 'test_subtract', status: 'PASSED' },
      { testSuite: 'tests.test_old', testName: 'test_gone', status: 'PASSED' },
    ]);
    await performRun(control);

    testsRan(PASSING);
    await performRun(control);

    expect(folderNode(controller).children.ids()).toEqual([suiteId()]);
    expect(suiteNode(controller)?.children.ids()).toEqual([testId('test_add')]);
  });

  it('groups results without a suite under a placeholder suite', async () => {
    const { control, controller } = setup();
    testsRan([{ testName: 'lonely', status: 'PASSED' }]);

    await performRun(control);

    expect(suiteNode(controller, '(no suite)')?.children.ids()).toEqual([testId('lonely', '(no suite)')]);
  });

  it('picks up a test file that appeared since the last run', async () => {
    const { control, controller } = setup();
    const suite = 'tests.test_new';
    testsRan([{ testSuite: suite, testName: 'test_it', status: 'PASSED' }]);
    await performRun(control);
    expect(testNode(controller, 'test_it', suite)?.uri).toBeUndefined();

    const newFile = join(folderPath, 'tests', 'test_new.py');
    await writeFile(newFile, 'def test_it():\n    assert True\n', 'utf8');
    await performRun(control);

    expect(testNode(controller, 'test_it', suite)?.uri?.fsPath).toBe(newFile);
    expect(suiteNode(controller, suite)?.children.size).toBe(1);
  });

  it('remembers the tests so the tree survives a reload', async () => {
    const { control } = setup();
    testsRan([
      { testSuite: SUITE, testName: 'test_add', status: 'PASSED' },
      { testSuite: 'tests.test_missing', testName: 'test_x', status: 'PASSED' },
    ]);

    await performRun(control);

    expect(context.workspaceState.get(KNOWN_TESTS_KEY)).toEqual({
      [folderPath]: [
        { suite: SUITE, name: 'test_add', file: testFile },
        { suite: 'tests.test_missing', name: 'test_x', file: undefined },
      ],
    });
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
    expect(logged).toContain('Run complete (not submitted).');
    expect(authService.getAccessToken).not.toHaveBeenCalled();
    expect(submitRun).not.toHaveBeenCalled();
  });

  it('uses the request it was given for the test run', async () => {
    const { control, controller } = setup();
    testsRan(PASSING);
    const request = new TestRunRequest();

    await performRun(control, { request: request as never });

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

  it('signs in first, then runs, then submits the run with its evidence', async () => {
    configValues.set('assignmentKey', 'assignment-7');
    const { control, controller, authService } = setup();
    testsRan(PASSING);
    const report = vi.fn();

    await performRun(control, { submit: true, report });

    expect(controller.runs[0].name).toBe('Run & Submit to Moodle');
    expect(authService.getAccessToken).toHaveBeenCalledOnce();
    expect(report.mock.calls.map(([m]) => m)).toEqual(['Signing in…', 'Running tests…', 'Submitting to Moodle…']);

    const [run, submitContext] = vi.mocked(submitRun).mock.calls[0];
    expect(run.results).toEqual(PASSING);
    expect(submitContext).toMatchObject({ folderPath, projectName: 'calculator', assignmentKeySetting: 'assignment-7' });
    expect(submitContext.evidence?.sources).toEqual([
      { kind: 'TEST', filePath: 'tests/test_math.py', startLine: 1, endLine: 2 },
    ]);
    expect(submitContext.evidence?.files[0].content).toBe(TEST_FILE);

    expect(logged).toContain('Located 1/1 tests in 1 file(s) (' + TEST_FILE.length + ' chars).');
    expect(logged).toContain('Submitted successfully.');
    expect(controller.runs[0].output).toBe('\r\nSubmitted 1 test result(s) to Moodle.\r\n');
    expect(window.showInformationMessage).toHaveBeenCalledWith('Submitted 1 test result(s) to Moodle (1 passed).');
  });

  it('does not run the tests when sign-in fails', async () => {
    const { control, authService } = setup();
    authService.getAccessToken.mockRejectedValue(new CancelledError());

    await expect(performRun(control, { submit: true })).rejects.toBeInstanceOf(CancelledError);

    expect(runTests).not.toHaveBeenCalled();
  });

  it('warns about an emptied test and submits only on confirmation', async () => {
    const { control } = setup();
    testsRan([...PASSING, { testSuite: SUITE, testName: 'test_emptied', status: 'PASSED' }]);
    window.showWarningMessage.mockResolvedValueOnce('Submit anyway');

    await performRun(control, { submit: true });

    expect(logged).toContain('Integrity warning: tests.test_math.test_emptied — has an empty body');
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
    expect(logged).toContain('Submission cancelled at the integrity warning.');
    expect(controller.runs[0].output).toBe('\r\nSubmission cancelled.\r\n');
    expect(controller.runs[0].ended).toBe(true);
  });

  it('skips the warning prompt when turned off, but still logs findings', async () => {
    configValues.set('warnOnSuspiciousTests', false);
    const { control } = setup();
    testsRan([{ testSuite: SUITE, testName: 'test_emptied', status: 'PASSED' }]);

    await performRun(control, { submit: true });

    expect(window.showWarningMessage).not.toHaveBeenCalled();
    expect(logged.some((m) => m.startsWith('Integrity warning:'))).toBe(true);
    expect(submitRun).toHaveBeenCalledOnce();
  });

  it('still submits, without evidence, when source capture fails', async () => {
    const { control } = setup();
    testsRan(PASSING);
    vi.mocked(collectTestEvidence).mockRejectedValueOnce(new Error('disk on fire'));

    await performRun(control, { submit: true });

    expect(logged).toContain('Could not capture test source: disk on fire');
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
    const other = workspaceFolder(await mkdtemp(join(tmpdir(), 'moodle-controller-other-')), 'other');
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
    expect(control.folderFor(suiteNode(controller))?.name).toBe('calculator');
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
