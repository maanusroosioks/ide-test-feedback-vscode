import type { NormalizedTestCase, Platform } from '../core/types';
import { describeError } from '../core/errors';
import { runCommand } from '../util/shell';
import type { AdapterRunResult, RunOptions, TestRunnerAdapter } from './types';

export interface PreparedRun {
  command: string;
  /** `startedAt` is taken just before the command runs, for mtime-based freshness checks. */
  parse(startedAt: number): Promise<NormalizedTestCase[]>;
  cleanup?(): Promise<void>;
}

export interface AdapterSpec {
  id: string;
  displayName: string;
  platform: Platform;
  detect(folderPath: string): Promise<boolean>;
  /** Runs before the command, so it is also where stale reports get cleared. */
  prepare(folderPath: string, opts: RunOptions): Promise<PreparedRun>;
}

const NO_CLEANUP = async (): Promise<void> => {};

export function defineAdapter(spec: AdapterSpec): TestRunnerAdapter {
  const { id, displayName, platform, detect } = spec;

  return {
    id,
    displayName,
    platform,
    detect,

    async run(folderPath, opts): Promise<AdapterRunResult> {
      const prepared = await spec.prepare(folderPath, opts);
      const cleanup = prepared.cleanup ?? NO_CLEANUP;

      try {
        const startedAt = Date.now();
        const { exitCode, stdout, stderr } = await runCommand(prepared.command, {
          cwd: folderPath,
          signal: opts.signal,
          onOutput: opts.onOutput,
        });
        const finishedAt = Date.now();

        let results: NormalizedTestCase[] = [];
        let reportError: string | undefined;
        try {
          results = await prepared.parse(startedAt);
        } catch (error) {
          reportError = describeError(error);
          opts.logger?.log(`${displayName}: ${reportError}`);
        }

        return {
          run: { adapterId: id, platform, startedAt, finishedAt, results },
          stdout,
          stderr,
          exitCode,
          reportError,
          cleanup,
        };
      } catch (error) {
        await cleanup();
        throw error;
      }
    },
  };
}
