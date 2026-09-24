export type TestStatus = 'PASSED' | 'FAILED' | 'SKIPPED' | 'ERROR';

/**
 * How far the test was resolved in the project's source, independent of whether its file's content
 * was captured. `TEST` — the declaration, located by line range within its file. `FILE` — only the file itself.
 * `NONE` — not found at all, so there is nothing but the framework's own report.
 */
export type TestSourceKind = 'TEST' | 'FILE' | 'NONE';

export interface NormalizedTestCase {
  testSuite?: string;
  testName: string;
  status: TestStatus;
  durationMs?: number;
  message?: string;
  stackTrace?: string;
}

export interface NormalizedTestRun {
  adapterId: string;
  language: string;
  startedAt: number;
  finishedAt: number;
  results: NormalizedTestCase[];
}
