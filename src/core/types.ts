export type TestStatus = 'PASSED' | 'FAILED' | 'SKIPPED' | 'ERROR';

/** What an adapter's tests run on; one platform can host several source languages. */
export type Platform = 'jvm' | 'python' | 'dotnet';

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
  platform: Platform;
  startedAt: number;
  finishedAt: number;
  results: NormalizedTestCase[];
}
