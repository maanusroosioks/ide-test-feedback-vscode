export type TestStatus = 'PASSED' | 'FAILED' | 'SKIPPED' | 'ERROR';

/** The language an adapter runs. Kotlin and other JVM languages run under `java`. */
export type RunLanguage = 'java' | 'python' | 'csharp';

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
  language: RunLanguage;
  startedAt: number;
  finishedAt: number;
  results: NormalizedTestCase[];
}
