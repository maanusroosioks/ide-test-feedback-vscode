import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { UNNAMED_TEST, type NormalizedTestCase, type TestStatus } from '../../core/types';
import { describeError } from '../../core/errors';
import { createReportParser, parseReportFile, ReportUnavailableError } from './report-file';

interface TrxErrorInfo {
  Message?: string;
  StackTrace?: string;
}

interface TrxUnitTestResult {
  '@_testId': string;
  '@_testName'?: string;
  '@_outcome': string;
  '@_duration'?: string;
  Output?: {
    ErrorInfo?: TrxErrorInfo;
  };
  InnerResults?: { UnitTestResult?: TrxUnitTestResult[] };
}

interface TrxUnitTest {
  '@_id': string;
  TestMethod?: { '@_className'?: string; '@_name'?: string };
}

const parser = createReportParser(['UnitTestResult', 'UnitTest']);

function parseTrxDuration(duration?: string): number | undefined {
  if (!duration) return undefined;
  const match = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(duration);
  if (!match) return undefined;
  const [, hours, minutes, seconds] = match;
  return Number(hours) * 3_600_000 + Number(minutes) * 60_000 + Math.round(Number(seconds) * 1000);
}

function mapOutcome(outcome: string): TestStatus {
  switch (outcome) {
    case 'Passed':
    case 'PassedButRunAborted':
    case 'Warning':
      return 'PASSED';
    case 'Failed':
      return 'FAILED';
    case 'NotExecuted':
      return 'SKIPPED';
    default:
      return 'ERROR';
  }
}

/** A data-driven MSTest reports one parent result with a row per data set under it; the rows are the tests. */
function flattenDataRows(results: TrxUnitTestResult[]): TrxUnitTestResult[] {
  return results.flatMap((result) => {
    const rows = result.InnerResults?.UnitTestResult ?? [];
    return rows.length > 0 ? flattenDataRows(rows) : [result];
  });
}

export function parseTrx(xml: string): NormalizedTestCase[] {
  const doc = parser.parse(xml);
  // As in parseJUnitXml: a missing root means an unusable file, not an empty run.
  if (doc.TestRun === undefined) {
    throw new Error('no <TestRun> element found — this is not a TRX report');
  }
  const testRun = doc.TestRun;
  const results = flattenDataRows(testRun.Results?.UnitTestResult ?? []);
  const definitions: TrxUnitTest[] = testRun.TestDefinitions?.UnitTest ?? [];

  const classNameById = new Map<string, string | undefined>();
  for (const definition of definitions) {
    classNameById.set(definition['@_id'], definition.TestMethod?.['@_className']);
  }

  return results.map((result) => {
    const errorInfo = result.Output?.ErrorInfo;
    return {
      testSuite: classNameById.get(result['@_testId']),
      testName: result['@_testName'] || UNNAMED_TEST,
      status: mapOutcome(result['@_outcome']),
      durationMs: parseTrxDuration(result['@_duration']),
      message: errorInfo?.Message,
      stackTrace: errorInfo?.StackTrace,
    };
  });
}

export function parseTrxFile(path: string): Promise<NormalizedTestCase[]> {
  return parseReportFile(path, parseTrx);
}

/** A solution writes one TRX per test project. */
export async function parseTrxDirectory(dir: string): Promise<NormalizedTestCase[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    throw new ReportUnavailableError(`no report was written to ${dir} (${describeError(error)})`);
  }
  const reports = names.filter((name) => name.toLowerCase().endsWith('.trx')).sort();
  if (reports.length === 0) {
    throw new ReportUnavailableError(`no TRX report was written to ${dir}`);
  }
  const perFile = await Promise.all(reports.map((name) => parseTrxFile(join(dir, name))));
  return perFile.flat();
}
