// End-to-end over the real sample projects: real filesystem, real resolver, no mocks.
// Skipped when the samples aren't checked out beside the extension (e.g. on CI).

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildTestRunRequest } from '../../../src/core/payload';
import { TestLocationResolver } from '../../../src/capture/location';
import {
  collectTestEvidence,
  type DeclaredSource,
  type FileSource,
  type TestEvidence,
  type TestSourceKind,
} from '../../../src/capture/evidence';
import { describeSuspiciousTests } from '../../../src/capture/integrity';
import { sliceLines } from '../../../src/scanning';
import type { NormalizedTestCase, NormalizedTestRun, Platform } from '../../../src/core/types';

const EXAMPLES = resolve('c:/Moodle/examples');

const metadata = { assignmentKey: 'sample-assignment', projectName: 'sample' };

/** Every arm's fields as optional, so assertions needn't narrow on `kind` first. */
type AnySource = Partial<Omit<DeclaredSource, 'kind'> & Omit<FileSource, 'kind'>> & {
  kind: TestSourceKind;
};

function sourcesOf(evidence: TestEvidence): AnySource[] {
  return evidence.payload.sources as AnySource[];
}

async function evidenceFor(folder: string, run: NormalizedTestRun): Promise<TestEvidence> {
  return collectTestEvidence(run, new TestLocationResolver(folder, run.platform), {
    folderPath: folder,
    captureSource: true,
    maxTotalChars: 200000,
  });
}

function run(
  adapterId: string,
  platform: Platform,
  results: NormalizedTestCase[],
): NormalizedTestRun {
  return { adapterId, platform, startedAt: 1000, finishedAt: 2000, results };
}

/** Reads a test back the way the grader has to: slice it out of its file. */
function codeFor(evidence: TestEvidence, index: number): string {
  const source = sourcesOf(evidence)[index];
  expect(source.kind).toBe('TEST');
  const file = evidence.payload.files.find((candidate) => candidate.path === source.filePath);
  expect(file?.truncated).toBeUndefined();
  return sliceLines(file?.content as string, source.startLine as number, source.endLine as number);
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
    expect(sourcesOf(evidence).every((source) => source.kind === 'TEST')).toBe(true);
    expect(
      sourcesOf(evidence).every((source) => source.filePath === 'test_calculator.py'),
    ).toBe(true);
  });

  it('maps both parametrized ids onto the same declaration, decorator included', async () => {
    const evidence = await evidenceFor(pythonSample, testRun);

    expect(codeFor(evidence, 1)).toContain('@pytest.mark.parametrize');
    expect(codeFor(evidence, 1)).toContain('assert divide(a, b) == expected');
    expect(sourcesOf(evidence)[1].startLine).toBe(sourcesOf(evidence)[2].startLine);
    expect(codeFor(evidence, 1)).not.toContain('def test_divide_by_zero_raises');
  });

  it('counts assertions and finds nothing suspicious', async () => {
    const evidence = await evidenceFor(pythonSample, testRun);

    expect(describeSuspiciousTests(evidence.integrity)).toEqual([]);
    expect(evidence.integrity.every((entry) => (entry.integrity.assertionCount ?? 0) > 0)).toBe(true);
  });
});

describe.skipIf(!existsSync(mavenSample) || !existsSync(gradleSample))('java samples', () => {
  const testRun = run('maven-junit', 'jvm', [
    { testSuite: 'com.example.calculator.CalculatorTest', testName: 'addReturnsSum()', status: 'PASSED' },
    {
      testSuite: 'com.example.calculator.CalculatorTest',
      testName: 'divideReturnsQuotient(int, int, int)[1]',
      status: 'PASSED',
    },
    {
      testSuite: 'com.example.calculator.CalculatorTest',
      testName: 'divideByZeroThrows()',
      status: 'PASSED',
    },
  ]);

  it.each([
    ['maven', mavenSample],
    ['gradle', gradleSample],
  ])('%s: resolves tests under src/test/java and captures them', async (_name, folder) => {
    const evidence = await evidenceFor(folder, testRun);

    expect(located(evidence)).toBe(3);
    expect(sourcesOf(evidence)[0].filePath).toBe(
      'src/test/java/com/example/calculator/CalculatorTest.java',
    );
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
    expect(sourcesOf(evidence)[0].filePath).toBe('CalculatorTests.cs');
    expect(codeFor(evidence, 1)).toContain('[Theory]');
    expect(codeFor(evidence, 1)).toContain('[InlineData(10, 2, 5)]');
    expect(codeFor(evidence, 1)).toContain('[InlineData(9, 3, 3)]');
  });

  it('keeps angle brackets in generic assertions all the way through the payload', async () => {
    const evidence = await evidenceFor(dotnetSample, testRun);
    const request = buildTestRunRequest(testRun, metadata, evidence.payload);

    // Sanitized for Moodle PARAM_TEXT, but the captured code must survive verbatim.
    expect(request.testFiles?.[0].content).toContain('Assert.Throws<DivideByZeroException>');
    expect(request.results[2].source).toEqual({
      filePath: 'CalculatorTests.cs',
      startLine: (evidence.payload.sources[2] as DeclaredSource).startLine,
      endLine: (evidence.payload.sources[2] as DeclaredSource).endLine,
    });
    expect(request).not.toHaveProperty('integrity');
  });
});
