import { describe, expect, it } from 'vitest';
import { parseTrx, parseTrxFile } from '../../../../src/runner/parsers/trx-parser';
import { ReportUnavailableError } from '../../../../src/runner/parsers/report-file';
import { fixturePath, readFixture } from '../../helpers/project';

describe('parseTrx', () => {
  it('parses a .trx report, mapping outcomes and joining test names to their class via TestDefinitions', () => {
    const results = parseTrx(readFixture('dotnet/sample-results.trx'));

    expect(results).toHaveLength(3);

    const passed = results.find((r) => r.testName === 'AddsTwoNumbers');
    expect(passed).toMatchObject({
      status: 'PASSED',
      testSuite: 'Calculator.Tests.CalculatorTests',
      durationMs: 1,
    });

    const failed = results.find((r) => r.testName === 'DividesByZero');
    expect(failed?.status).toBe('FAILED');
    expect(failed?.message).toContain('Assert.Throws');
    expect(failed?.stackTrace).toContain('CalculatorTests.cs');

    const skipped = results.find((r) => r.testName === 'NotReadyYet');
    expect(skipped?.status).toBe('SKIPPED');
  });
});

describe('parseTrx — edge cases', () => {
  const report = (outcome: string) => `<?xml version="1.0"?>
<TestRun>
  <Results>
    <UnitTestResult testId="1" testName="HangsForever" outcome="${outcome}" duration="00:00:30.0000000" />
  </Results>
</TestRun>`;

  it.each(['Timeout', 'Aborted', 'Inconclusive'])('reports a %s outcome as an error', (outcome) => {
    expect(parseTrx(report(outcome))[0]).toMatchObject({ testName: 'HangsForever', status: 'ERROR' });
  });

  it('leaves the suite unset when a result has no matching definition', () => {
    expect(parseTrx(report('Passed'))[0].testSuite).toBeUndefined();
  });

  it('treats a TestRun with no results as an empty run', () => {
    expect(parseTrx('<TestRun></TestRun>')).toEqual([]);
  });

  it('rejects XML that is not a TRX report', () => {
    expect(() => parseTrx('<testsuites/>')).toThrow('no <TestRun> element found');
  });
});

describe('parseTrxFile', () => {
  it('reads and parses a report from disk', async () => {
    const results = await parseTrxFile(fixturePath('dotnet/sample-results.trx'));
    expect(results).toHaveLength(3);
  });

  it('reports a missing file as an unavailable report', async () => {
    await expect(parseTrxFile(fixturePath('dotnet/missing.trx'))).rejects.toBeInstanceOf(ReportUnavailableError);
  });
});
