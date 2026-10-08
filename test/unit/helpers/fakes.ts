import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { vi } from 'vitest';
import type { Logger } from '../../../src/core/ports';
import { WORKSPACE_CONFIG_FILE_NAME } from '../../../src/core/submissionMetadata';
import type { NormalizedTestCase, NormalizedTestRun } from '../../../src/core/types';
import { AdapterRegistry } from '../../../src/runner/registry';
import type { TestRunnerAdapter } from '../../../src/runner/types';

export function fakeStatus() {
  return { running: vi.fn(), result: vi.fn(), error: vi.fn(), idle: vi.fn() };
}

export interface RecordingLogger extends Logger {
  messages: string[];
}

export function recordingLogger(): RecordingLogger {
  const messages: string[] = [];
  return { messages, log: (message) => void messages.push(message) };
}

export function testRun(results: NormalizedTestCase[], overrides: Partial<NormalizedTestRun> = {}): NormalizedTestRun {
  return { adapterId: 'pytest', platform: 'python', startedAt: 1000, finishedAt: 2000, results, ...overrides };
}

/** Detects every folder and refuses to run unless `overrides` supplies `run`. */
export function stubAdapter(id: string, overrides: Partial<TestRunnerAdapter> = {}): TestRunnerAdapter {
  return {
    id,
    displayName: id,
    platform: 'python',
    detect: async () => true,
    run: async () => {
      throw new Error('not used in this test');
    },
    ...overrides,
  };
}

export function registryWith(...adapters: TestRunnerAdapter[]): AdapterRegistry {
  const registry = new AdapterRegistry();
  adapters.forEach((adapter) => registry.register(adapter));
  return registry;
}

export async function writeWorkspaceConfig(folderPath: string, config: object): Promise<void> {
  await writeFile(join(folderPath, WORKSPACE_CONFIG_FILE_NAME), JSON.stringify(config), 'utf8');
}
