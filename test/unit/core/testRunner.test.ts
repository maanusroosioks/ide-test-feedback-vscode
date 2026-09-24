import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdapterRegistry } from '../../../src/adapters/registry';
import type { AdapterRunResult, RunOptions, TestRunnerAdapter } from '../../../src/adapters/types';
import { NoTestResultsError, runTests } from '../../../src/core/testRunner';
import type { NormalizedTestCase } from '../../../src/core/types';
import { configValues, resetVscodeStub } from '../helpers/vscodeStub';

interface FakeAdapterOptions {
  id?: string;
  detects?: boolean;
  results?: NormalizedTestCase[];
  exitCode?: number;
  stderr?: string;
  reportError?: string;
}

function fakeAdapter(options: FakeAdapterOptions = {}) {
  const cleanup = vi.fn(async () => {});
  const runOptions: RunOptions[] = [];
  const adapter: TestRunnerAdapter = {
    id: options.id ?? 'fake',
    displayName: `Fake ${options.id ?? 'fake'}`,
    platform: 'python',
    detect: async () => options.detects ?? true,
    run: async (_folder, opts): Promise<AdapterRunResult> => {
      runOptions.push(opts);
      return {
        run: { adapterId: 'fake', platform: 'python', startedAt: 1, finishedAt: 2, results: options.results ?? [] },
        stdout: 'collected 3 items',
        stderr: options.stderr ?? '',
        exitCode: options.exitCode ?? 0,
        reportError: options.reportError,
        cleanup,
      };
    },
  };
  return { adapter, cleanup, runOptions };
}

function registryWith(...adapters: TestRunnerAdapter[]): AdapterRegistry {
  const registry = new AdapterRegistry();
  adapters.forEach((adapter) => registry.register(adapter));
  return registry;
}

const MIXED_RESULTS: NormalizedTestCase[] = [
  { testName: 'a', status: 'PASSED' },
  { testName: 'b', status: 'PASSED' },
  { testName: 'c', status: 'FAILED' },
  { testName: 'd', status: 'ERROR' },
  { testName: 'e', status: 'SKIPPED' },
];

let logged: string[];
const logger = { log: (message: string) => void logged.push(message) };

beforeEach(() => {
  resetVscodeStub();
  logged = [];
});

describe('runTests', () => {
  it('summarizes the run, counting errors as failures', async () => {
    const { adapter } = fakeAdapter({ results: MIXED_RESULTS });

    const { run, summary } = await runTests(registryWith(adapter), '/work', { logger });

    expect(run.results).toEqual(MIXED_RESULTS);
    expect(summary).toEqual({ total: 5, passed: 2, failed: 2, skipped: 1 });
    expect(logged).toContain('Detected adapter: Fake fake');
    expect(logged).toContain('Parsed 5 result(s): 2 passed, 2 failed/errored, 1 skipped.');
  });

  it("logs the tool's stdout and, when present, its stderr", async () => {
    const { adapter } = fakeAdapter({ results: MIXED_RESULTS, stderr: 'DeprecationWarning' });

    await runTests(registryWith(adapter), '/work', { logger });

    expect(logged).toContain('collected 3 items');
    expect(logged).toContain('DeprecationWarning');
  });

  it("passes the adapter's own command override, signal and output sink through", async () => {
    configValues.set('testCommandOverrides', { fake: 'pytest -x', other: 'mvn verify' });
    const { adapter, runOptions } = fakeAdapter({ results: MIXED_RESULTS });
    const signal = new AbortController().signal;
    const onOutput = vi.fn();

    await runTests(registryWith(adapter), '/work', { logger, signal, onOutput });

    expect(runOptions[0]).toMatchObject({ commandOverride: 'pytest -x', signal, onOutput, logger });
  });

  it('cleans up the adapter run once results are read', async () => {
    const { adapter, cleanup } = fakeAdapter({ results: MIXED_RESULTS });

    await runTests(registryWith(adapter), '/work', { logger });

    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('treats an empty run as a failed command, not a clean zero-test run', async () => {
    const { adapter, cleanup } = fakeAdapter({ results: [], exitCode: 127 });

    const attempt = runTests(registryWith(adapter), '/work', { logger });

    await expect(attempt).rejects.toBeInstanceOf(NoTestResultsError);
    await expect(attempt).rejects.toThrow(/produced no test results \(exit code 127\)/);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('names the report problem when the report could not be read', async () => {
    const { adapter } = fakeAdapter({ results: [], exitCode: 1, reportError: 'no report was written to x.xml' });

    await expect(runTests(registryWith(adapter), '/work', { logger })).rejects.toThrow(
      'Fake fake exited with code 1 and its report could not be used: no report was written to x.xml.',
    );
  });

  it('asks the picker when several adapters match', async () => {
    const first = fakeAdapter({ id: 'first', results: MIXED_RESULTS });
    const second = fakeAdapter({ id: 'second', results: MIXED_RESULTS });
    const pickFromMultiple = vi.fn(async (candidates: TestRunnerAdapter[]) => candidates[1]);

    await runTests(registryWith(first.adapter, second.adapter), '/work', { logger, pickFromMultiple });

    expect(pickFromMultiple).toHaveBeenCalledOnce();
    expect(second.runOptions).toHaveLength(1);
    expect(first.runOptions).toHaveLength(0);
  });

  it('honors the preferredAdapter setting over detection', async () => {
    configValues.set('preferredAdapter', 'second');
    const first = fakeAdapter({ id: 'first', results: MIXED_RESULTS });
    const second = fakeAdapter({ id: 'second', results: MIXED_RESULTS });

    await runTests(registryWith(first.adapter, second.adapter), '/work', { logger });

    expect(second.runOptions).toHaveLength(1);
    expect(logged).toContain('Detected adapter: Fake second');
  });

  it("warns when the forced adapter doesn't fit the folder", async () => {
    configValues.set('preferredAdapter', 'fake');
    const { adapter } = fakeAdapter({ detects: false, results: MIXED_RESULTS });

    await runTests(registryWith(adapter), '/work', { logger });

    expect(logged.some((m) => m.startsWith('Warning: moodleSubmit.preferredAdapter forces Fake fake'))).toBe(true);
    expect(logged).not.toContain('Detected adapter: Fake fake');
  });
});
