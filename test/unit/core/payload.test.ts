import { describe, expect, it } from 'vitest';
import { buildTestRunRequest, InvalidPayloadError } from '../../../src/core/payload';
import type { NormalizedTestRun } from '../../../src/core/types';
import type { SubmissionMetadata } from '../../../src/core/submissionMetadata';
import type { DeclaredSource, TestEvidencePayload } from '../../../src/capture/evidence';
import { testRun } from '../helpers/fakes';

const metadata: SubmissionMetadata = {
  assignmentKey: 'assignment-101',
  projectName: 'my-project',
  commitHash: 'deadbeef',
  repoUrl: 'https://github.com/org/repo',
};

function sampleRun(overrides: Partial<NormalizedTestRun> = {}): NormalizedTestRun {
  return testRun(
    [
      { testSuite: 'test_calculator', testName: 'test_adds', status: 'PASSED', durationMs: 5 },
      {
        testSuite: 'test_calculator',
        testName: 'test_divides_by_zero',
        status: 'FAILED',
        durationMs: 3,
        message: 'boom',
        stackTrace: 'Traceback ...',
      },
    ],
    overrides,
  );
}

describe('buildTestRunRequest', () => {
  it('maps a normalized run + metadata onto the exact TestRunRequest/TestResultRequest shape', () => {
    const request = buildTestRunRequest(sampleRun(), metadata);

    expect(request).toEqual({
      assignmentKey: 'assignment-101',
      ide: 'VSCODE',
      projectName: 'my-project',
      commitHash: 'deadbeef',
      repoUrl: 'https://github.com/org/repo',
      startedAtMs: 1000,
      finishedAtMs: 2000,
      results: [
        { testSuite: 'test_calculator', testName: 'test_adds', status: 'PASSED', durationMs: 5 },
        {
          testSuite: 'test_calculator',
          testName: 'test_divides_by_zero',
          status: 'FAILED',
          durationMs: 3,
          message: 'boom',
        },
      ],
    });
  });

  it('never includes the raw stack trace in the payload', () => {
    const request = buildTestRunRequest(sampleRun(), metadata);
    const serialized = JSON.stringify(request);
    expect(serialized).not.toContain('Traceback');
  });

  it('caps a huge failure message so it cannot sink the whole run', () => {
    const run = testRun([{ testName: 'test_big_diff', status: 'FAILED', message: `<${'x'.repeat(50_000)}>` }]);

    const [result] = buildTestRunRequest(run, metadata).results;

    expect(result.message).toHaveLength(4000);
    expect(result.message?.startsWith('xxx')).toBe(true);
  });

  it('throws InvalidPayloadError when there are no results', () => {
    expect(() => buildTestRunRequest(sampleRun({ results: [] }), metadata)).toThrow(InvalidPayloadError);
  });

  it('throws InvalidPayloadError when there are more results than the gateway accepts', () => {
    const results = Array.from({ length: 5001 }, (_, index) => ({
      testName: `test_${index}`,
      status: 'PASSED' as const,
    }));
    expect(() => buildTestRunRequest(sampleRun({ results }), metadata)).toThrow(InvalidPayloadError);
  });

  it.each([
    ['blank', '   '],
    ['emptied by sanitizing', '<>'],
  ])('sends a %s test name as unnamed rather than failing the whole run', (_label, testName) => {
    const run = sampleRun({ results: [{ testSuite: '<>', testName, status: 'PASSED' }] });

    const [result] = buildTestRunRequest(run, metadata).results;

    expect(result.testName).toBe('(unnamed test)');
    expect(result.testSuite).toBeUndefined();
  });

  it.each([
    ['blank', '  '],
    ['too long', 'y'.repeat(101)],
    ['outside the allowed characters', 'assignment 101'],
  ])('throws InvalidPayloadError when assignmentKey is %s', (_label, assignmentKey) => {
    expect(() => buildTestRunRequest(sampleRun(), { ...metadata, assignmentKey })).toThrow(
      InvalidPayloadError,
    );
  });

  it('strips angle brackets so values survive Moodle PARAM_TEXT validation', () => {
    const request = buildTestRunRequest(
      sampleRun({
        results: [
          {
            testSuite: 'suite',
            testName: 'test_compare',
            status: 'FAILED',
            message: 'expected: <0> but was: <-1>',
          },
        ],
      }),
      metadata,
    );

    expect(request.results[0].message).toBe('expected: 0 but was: -1');
  });

  it('truncates fields exceeding the DTO @Size limits', () => {
    const request = buildTestRunRequest(
      sampleRun({
        results: [{ testSuite: 'x'.repeat(300), testName: 'x'.repeat(1100), status: 'PASSED' }],
      }),
      { ...metadata, projectName: 'p'.repeat(300), commitHash: 'c'.repeat(150) },
    );

    expect(request.projectName).toHaveLength(255);
    expect(request.commitHash).toHaveLength(100);
    expect(request.results[0].testSuite).toHaveLength(255);
    expect(request.results[0].testName).toHaveLength(1024);
  });

  it('drops a repoUrl too long to send rather than cutting it', () => {
    const request = buildTestRunRequest(sampleRun(), {
      ...metadata,
      repoUrl: `https://github.com/org/${'z'.repeat(1100)}`,
    });

    expect(request.repoUrl).toBeUndefined();
  });

  it('rounds durations to the whole milliseconds the gateway stores', () => {
    const request = buildTestRunRequest(
      sampleRun({ results: [{ testName: 'test_x', status: 'PASSED', durationMs: 12.6 }] }),
      metadata,
    );

    expect(request.results[0].durationMs).toBe(13);
  });

  it('omits timing the gateway would reject', () => {
    const request = buildTestRunRequest(sampleRun({ startedAt: 2000, finishedAt: 1000 }), metadata);

    expect(request.startedAtMs).toBeUndefined();
    expect(request.finishedAtMs).toBeUndefined();
  });
});

/** sampleEvidence()'s first source is always the TEST arm, and these tests read and edit it as one. */
function declared(payload: TestEvidencePayload): DeclaredSource {
  return payload.sources[0] as DeclaredSource;
}

function sampleEvidence(overrides: Partial<TestEvidencePayload> = {}): TestEvidencePayload {
  return {
    sources: [
      { kind: 'TEST', filePath: 'tests/test_calculator.py', startLine: 3, endLine: 4 },
      { kind: 'NONE' },
    ],
    files: [
      {
        path: 'tests/test_calculator.py',
        content: 'import pytest\n\ndef test_adds():\n    assert add(2, 3) == 5\n',
      },
    ],
    ...overrides,
  };
}

// With no evidence, the exact-shape test above already rules out `source` and `testFiles`.
describe('buildTestRunRequest — captured source', () => {
  it('attaches source index-aligned with the results, omitting it for an unlocated test', () => {
    const request = buildTestRunRequest(sampleRun(), metadata, sampleEvidence());

    expect(request.results[0].source).toEqual({
      path: 'tests/test_calculator.py',
      startLine: 3,
      endLine: 4,
    });
    expect(request.results[1].source).toBeUndefined();
  });

  it('sends only the file path for a test that could not be isolated', () => {
    const request = buildTestRunRequest(sampleRun(), metadata, {
      ...sampleEvidence(),
      sources: [{ kind: 'FILE', filePath: 'tests/test_calculator.py' }, { kind: 'NONE' }],
    });

    expect(request.results[0].source).toEqual({ path: 'tests/test_calculator.py' });
  });

  it('submits no integrity signals — they exist only to drive the local warning', () => {
    const request = buildTestRunRequest(sampleRun(), metadata, sampleEvidence());

    expect(request).not.toHaveProperty('integrity');
    for (const result of request.results) {
      expect(result).not.toHaveProperty('integrity');
    }
    expect(JSON.stringify(request)).not.toContain('assertionCount');
  });

  it('ships each test file once, with its content', () => {
    const request = buildTestRunRequest(sampleRun(), metadata, sampleEvidence());

    expect(request.testFiles).toEqual([
      {
        path: 'tests/test_calculator.py',
        content: 'import pytest\n\ndef test_adds():\n    assert add(2, 3) == 5\n',
      },
    ]);
  });

  it('carries no captureDisabled flag on an ordinary run', () => {
    const serialized = JSON.stringify(buildTestRunRequest(sampleRun(), metadata, sampleEvidence()));

    expect(serialized).not.toContain('captureDisabled');
  });

  it('reports at the top level that the student switched source capture off', () => {
    const request = buildTestRunRequest(sampleRun(), metadata, {
      ...sampleEvidence(),
      captureDisabled: true,
    });

    expect(request.captureDisabled).toBe(true);
  });

  it('keeps angle brackets in file content — PARAM_TEXT stripping must not touch code', () => {
    const evidence = sampleEvidence();
    evidence.files[0].content =
      'public void t() {\n    Assert.Throws<DivideByZeroException>(() -> divide(1, 0));\n}';

    const request = buildTestRunRequest(sampleRun(), metadata, evidence);

    expect(request.testFiles?.[0].content).toContain('Assert.Throws<DivideByZeroException>');
  });

  it('truncates file paths to the DTO limit', () => {
    const evidence = sampleEvidence();
    const longPath = `${'p'.repeat(1100)}.py`;
    declared(evidence).filePath = longPath;
    evidence.files[0].path = longPath;

    const request = buildTestRunRequest(sampleRun(), metadata, evidence);

    expect(request.results[0].source?.path).toHaveLength(1024);
    expect(request.testFiles?.[0].path).toHaveLength(1024);
  });
});

describe('buildTestRunRequest — local paths in messages', () => {
  const messageOf = (message: string, roots: { workspace: string; home?: string }): string | undefined =>
    buildTestRunRequest(sampleRun({ results: [{ testName: 't', status: 'FAILED', message }] }), metadata, undefined, roots)
      .results[0].message;

  it('makes paths in the project relative and hides the rest of the home folder', () => {
    const roots = { workspace: '/home/alice/proj', home: '/home/alice' };

    expect(messageOf('FileNotFoundException: /home/alice/proj/data/in.txt', roots)).toBe(
      'FileNotFoundException: data/in.txt',
    );
    expect(messageOf('cannot read /home/alice/.m2/settings.xml', roots)).toBe('cannot read ~/.m2/settings.xml');
    expect(messageOf('cwd was /home/alice/proj', roots)).toBe('cwd was .');
  });

  it('leaves a path that only shares a prefix with a root', () => {
    expect(messageOf('see /home/alice2/x and /home/alice/proj-old/y', { workspace: '/home/alice/proj', home: '/home/alice' }))
      .toBe('see /home/alice2/x and ~/proj-old/y');
  });

  it('matches a Windows root in any case and with either separator', () => {
    const roots = { workspace: 'c:\\Users\\Alice\\proj', home: 'C:\\Users\\Alice' };

    expect(messageOf('at C:\\Users\\alice\\proj\\src\\Calc.cs and C:/Users/Alice/Downloads/x.cs', roots)).toBe(
      'at src\\Calc.cs and ~/Downloads/x.cs',
    );
  });

  it('leaves messages alone when no roots are given', () => {
    expect(
      buildTestRunRequest(sampleRun({ results: [{ testName: 't', status: 'FAILED', message: '/home/a/x' }] }), metadata)
        .results[0].message,
    ).toBe('/home/a/x');
  });
});

describe('InvalidPayloadError', () => {
  it('prefixes its message for the user', () => {
    expect(new InvalidPayloadError('too many results').userMessage).toBe('Invalid submission: too many results');
  });
});
