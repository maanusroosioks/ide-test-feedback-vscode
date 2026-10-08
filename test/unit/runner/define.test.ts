import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineAdapter, type PreparedRun } from '../../../src/runner/define';
import { CancelledError } from '../../../src/core/errors';
import type { NormalizedTestCase } from '../../../src/core/types';
import { runCommand } from '../../../src/util/shell';
import { recordingLogger } from '../helpers/fakes';

vi.mock('../../../src/util/shell', () => ({ runCommand: vi.fn() }));

function adapterThatPrepares(prepared: Partial<PreparedRun>) {
  return defineAdapter({
    id: 'fake',
    displayName: 'Fake Runner',
    platform: 'python',
    detect: async () => true,
    prepare: async () => ({
      command: 'fake-tool',
      parse: async () => [],
      ...prepared,
    }),
  });
}

beforeEach(() => {
  vi.mocked(runCommand).mockReset();
  vi.mocked(runCommand).mockImplementation(async (_command, { signal }) => {
    if (signal?.aborted) throw new CancelledError();
    return { exitCode: 0, stdout: '', stderr: '' };
  });
});

describe('defineAdapter', () => {
  it('stamps the run with the adapter id and language from the spec', async () => {
    const adapter = adapterThatPrepares({
      parse: async () => [{ testName: 'works', status: 'PASSED' as const }],
    });

    const result = await adapter.run('/work', {});

    expect(result.run.adapterId).toBe('fake');
    expect(result.run.platform).toBe('python');
    expect(result.run.results).toHaveLength(1);
    expect(result.reportError).toBeUndefined();
    expect(result.run.finishedAt).toBeGreaterThanOrEqual(result.run.startedAt);
  });

  it('runs the prepared command in the project folder', async () => {
    await adapterThatPrepares({}).run('/work', {});

    expect(runCommand).toHaveBeenCalledWith('fake-tool', expect.objectContaining({ cwd: '/work' }));
  });

  it('reports an unreadable report instead of passing off empty results as a clean run', async () => {
    const logger = recordingLogger();
    const adapter = adapterThatPrepares({
      parse: async () => {
        throw new Error('no report was written to /tmp/nope.xml');
      },
    });

    const result = await adapter.run('/work', { logger });

    expect(result.run.results).toEqual([]);
    expect(result.reportError).toContain('no report was written');
    expect(logger.messages).toContainEqual(expect.stringContaining('Fake Runner'));
  });

  it('times the run from just before the command starts', async () => {
    const before = Date.now();
    const parse = vi.fn(async (): Promise<NormalizedTestCase[]> => []);

    const result = await adapterThatPrepares({ parse }).run('/work', {});

    expect(result.run.startedAt).toBeGreaterThanOrEqual(before);
    expect(parse).toHaveBeenCalledOnce();
  });

  it('cleans up when the run is cancelled', async () => {
    const cleanup = vi.fn(async () => {});
    const adapter = adapterThatPrepares({ cleanup });

    await expect(adapter.run('/work', { signal: AbortSignal.abort() })).rejects.toBeInstanceOf(CancelledError);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('hands cleanup back to the caller on the success path rather than running it early', async () => {
    const cleanup = vi.fn(async () => {});
    const adapter = adapterThatPrepares({ cleanup });

    const result = await adapter.run('/work', {});
    expect(cleanup).not.toHaveBeenCalled();

    await result.cleanup();
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
