// End-to-end over the real sample projects: real filesystem, real resolver, no mocks.
// Skipped when the samples aren't checked out (e.g. on CI). They're looked for in MOODLE_EXAMPLES_DIR,
// else in the `examples` folder two levels above this repository.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildTestRunRequest } from '../../../src/core/payload';
import { TestLocationResolver } from '../../../src/capture/location';
import { collectTestEvidence, type TestEvidence } from '../../../src/capture/evidence';
import { locateResults, SourceFileCache } from '../../../src/capture/sourceFiles';
import { describeSuspiciousTests } from '../../../src/capture/integrity';
import { sliceLines } from '../../../src/scanning';
import type { NormalizedTestCase, NormalizedTestRun, Platform } from '../../../src/core/types';
import { declaredAt, filePathOf, kindsOf } from '../helpers/evidence';
import { testRun } from '../helpers/fakes';

const EXAMPLES = process.env.MOODLE_EXAMPLES_DIR ?? resolve(__dirname, '../../../../../examples');

const metadata = { assignmentKey: 'sample-assignment', projectName: 'sample' };

async function evidenceFor(folder: string, run: NormalizedTestRun): Promise<TestEvidence> {
  const resolver = new TestLocationResolver(folder, run.platform);
  const located = await locateResults(run, resolver, new SourceFileCache(folder, run.platform));
  return collectTestEvidence(run, located, { captureSource: true, maxTotalChars: 200000 });
}

function run(adapterId: string, platform: Platform, results: NormalizedTestCase[]): NormalizedTestRun {
  return testRun(results, { adapterId, platform });
}

/** Reads a test back the way the grader has to: slice it out of its file. */
function codeFor(evidence: TestEvidence, index: number): string {
  const source = declaredAt(evidence, index);
  const file = evidence.payload.files.find((candidate) => candidate.path === source.filePath);
  expect(file?.truncated).toBeUndefined();
  return sliceLines(file?.content ?? '', source.startLine, source.endLine);
}

function located(evidence: TestEvidence): number {
  return evidence.integrity.filter((entry) => entry.integrity.located).length;
}

const pythonSample = resolve(EXAMPLES, 'python-sample');
const mavenSample = resolve(EXAMPLES, 'java-maven-sample');
const gradleSample = resolve(EXAMPLES, 'java-gradle-sample');
const dotnetSample = resolve(EXAMPLES, 'dotnet-sample');

describe.skipIf(!existsSync(pythonSample))('python-sample', () => {
  const testRun = run('pytest', 'python', [
    { testSuite: 'test_calculator', testName: 'test_add_returns_sum', status: 'PASSED' },
    { testSuite: 'test_calculator', testName: 'test_divide_returns_quotient[10-2-5]', status: 'PASSED' },
    { testSuite: 'test_calculator', testName: 'test_divide_returns_quotient[9-3-3]', status: 'PASSED' },
    { testSuite: 'test_calculator', testName: 'test_divide_by_zero_raises', status: 'PASSED' },
    {
      testSuite: 'test_calculator',
      testName: 'test_multiply_returns_product_intentionally_failing',
      status: 'FAILED',
      message: 'assert 9 == 99',
      stackTrace: 'test_calculator.py:27: AssertionError',
    },
  ]);

  it('locates every test and captures its own source', async () => {
    const evidence = await evidenceFor(pythonSample, testRun);

    expect(located(evidence)).toBe(5);
    expect(new Set(kindsOf(evidence))).toEqual(new Set(['TEST']));
    expect(new Set(evidence.payload.sources.map(filePathOf))).toEqual(new Set(['test_calculator.py']));
  });

  it('maps both parametrized ids onto the same declaration, decorator included', async () => {
    const evidence = await evidenceFor(pythonSample, testRun);

    expect(codeFor(evidence, 1)).toContain('@pytest.mark.parametrize');
    expect(codeFor(evidence, 1)).toContain('assert divide(a, b) == expected');
    expect(declaredAt(evidence, 1).startLine).toBe(declaredAt(evidence, 2).startLine);
    expect(codeFor(evidence, 1)).not.toContain('def test_divide_by_zero_raises');
  });

  it('counts assertions and finds nothing suspicious', async () => {
    const evidence = await evidenceFor(pythonSample, testRun);

    expect(describeSuspiciousTests(evidence.integrity)).toEqual([]);
    for (const entry of evidence.integrity) {
      expect(entry.integrity.assertionCount, entry.testName).toBeGreaterThan(0);
    }
  });
});

describe.skipIf(!existsSync(mavenSample) || !existsSync(gradleSample))('java samples', () => {
  const javaRun = (adapterId: string, parameterizedName: string): NormalizedTestRun =>
    run(adapterId, 'jvm', [
      { testSuite: 'com.example.calculator.CalculatorTest', testName: 'addReturnsSum()', status: 'PASSED' },
      { testSuite: 'com.example.calculator.CalculatorTest', testName: parameterizedName, status: 'PASSED' },
      { testSuite: 'com.example.calculator.CalculatorTest', testName: 'divideByZeroThrows()', status: 'PASSED' },
    ]);

  // Each as its own report names a parameterized invocation: gradle leaves the method out.
  it.each([
    ['maven', mavenSample, javaRun('maven-junit', 'divideReturnsQuotient(int, int, int)[1]')],
    ['gradle', gradleSample, javaRun('gradle-junit', '[1] 10, 2, 5')],
  ])('%s: resolves tests under src/test/java and captures them', async (_name, folder, testRun) => {
    const evidence = await evidenceFor(folder, testRun);

    expect(located(evidence)).toBe(3);
    expect(declaredAt(evidence, 0).filePath).toBe('src/test/java/com/example/calculator/CalculatorTest.java');
    expect(codeFor(evidence, 0)).toContain('assertEquals(5, Calculator.add(2, 3));');
    expect(codeFor(evidence, 1)).toContain('@ParameterizedTest');
    expect(codeFor(evidence, 1)).toContain('@CsvSource({"10, 2, 5", "9, 3, 3"})');
    expect(codeFor(evidence, 2)).toContain('assertThrows(ArithmeticException.class');
  });
});

describe.skipIf(!existsSync(dotnetSample))('dotnet-sample', () => {
  const suite = 'CalculatorSample.Tests.CalculatorTests';
  const testRun = run('dotnet-test', 'dotnet', [
    { testSuite: suite, testName: `${suite}.Add_ReturnsSum`, status: 'PASSED' },
    {
      testSuite: suite,
      testName: `${suite}.Divide_ReturnsQuotient(a: 10, b: 2, expected: 5)`,
      status: 'PASSED',
    },
    { testSuite: suite, testName: `${suite}.Divide_ByZero_Throws`, status: 'PASSED' },
  ]);

  it('captures tests from a file-scoped namespace', async () => {
    const evidence = await evidenceFor(dotnetSample, testRun);

    expect(located(evidence)).toBe(3);
    expect(declaredAt(evidence, 0).filePath).toBe('CalculatorTests.cs');
    expect(codeFor(evidence, 1)).toContain('[Theory]');
    expect(codeFor(evidence, 1)).toContain('[InlineData(10, 2, 5)]');
    expect(codeFor(evidence, 1)).toContain('[InlineData(9, 3, 3)]');
  });

  it('keeps angle brackets in generic assertions all the way through the payload', async () => {
    const evidence = await evidenceFor(dotnetSample, testRun);
    const request = buildTestRunRequest(testRun, metadata, evidence.payload);

    // Sanitized for Moodle PARAM_TEXT, but the captured code must survive verbatim.
    expect(request.testFiles?.[0].content).toContain('Assert.Throws<DivideByZeroException>');
    const { startLine, endLine } = declaredAt(evidence, 2);
    expect(request.results[2].source).toEqual({ path: 'CalculatorTests.cs', startLine, endLine });
    expect(request).not.toHaveProperty('integrity');
  });
});
