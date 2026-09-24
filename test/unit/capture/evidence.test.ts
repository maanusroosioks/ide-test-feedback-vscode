import { readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TestLocationResolver } from '../../../src/capture/location';
import {
  collectTestEvidence,
  type CaptureOptions,
  type DeclaredSource,
  type FileSource,
  type TestEvidence,
  type TestSourceKind,
} from '../../../src/capture/evidence';
import { describeSuspiciousTests } from '../../../src/capture/integrity';
import { sliceLines } from '../../../src/scanning';
import type { NormalizedTestCase, NormalizedTestRun, Platform } from '../../../src/core/types';

const FOLDER = resolve('/project');
const PYTHON_SOURCE = readFileSync(
  join(__dirname, '../fixtures/source/python/test_calculator.py'),
  'utf8',
);

interface Harness {
  evidence: TestEvidence;
  reads: string[];
}

/** Every arm's fields as optional, so assertions needn't narrow on `kind` first. */
type AnySource = Partial<Omit<DeclaredSource, 'kind'> & Omit<FileSource, 'kind'>> & {
  kind: TestSourceKind;
};

function sourcesOf(evidence: TestEvidence): AnySource[] {
  return evidence.payload.sources as AnySource[];
}

function run(results: NormalizedTestCase[], platform: Platform = 'python'): NormalizedTestRun {
  return { adapterId: 'pytest', platform, startedAt: 1000, finishedAt: 2000, results };
}

async function collect(
  testRun: NormalizedTestRun,
  files: Record<string, string>,
  overrides: Partial<CaptureOptions> = {},
): Promise<Harness> {
  const absolute = new Map(
    Object.entries(files).map(([path, content]) => [resolve(FOLDER, path), content]),
  );
  const reads: string[] = [];

  const resolver = new TestLocationResolver(FOLDER, testRun.platform, {
    exists: async (path) => absolute.has(resolve(path)),
    listDirs: async () => [],
  });

  const evidence = await collectTestEvidence(testRun, resolver, {
    folderPath: FOLDER,
    captureSource: true,
    maxTotalChars: 200000,
    readFile: async (path) => {
      reads.push(path);
      const content = absolute.get(resolve(path));
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
    ...overrides,
  });

  return { evidence, reads };
}

const PYTHON_FILES = { 'test_calculator.py': PYTHON_SOURCE };

describe('collectTestEvidence — source capture', () => {
  it('locates just the matched test, decorator included', async () => {
    const { evidence } = await collect(
      run([
        {
          testSuite: 'test_calculator',
          testName: 'test_divide_returns_quotient[10-2-5]',
          status: 'PASSED',
        },
      ]),
      PYTHON_FILES,
    );

    const source = sourcesOf(evidence)[0];
    expect(source.kind).toBe('TEST');
    expect(source.filePath).toBe('test_calculator.py');
    expect(source.startLine).toBeLessThan(source.endLine as number);
    expect(evidence.payload.files[0].content).toBe(PYTHON_SOURCE);

    const sliced = sliceLines(PYTHON_SOURCE, source.startLine as number, source.endLine as number);
    expect(sliced).toContain('@pytest.mark.parametrize');
    expect(sliced).toContain('assert divide(a, b) == expected');
    expect(sliced).not.toContain('def test_uses_a_nested_helper');
  });

  it('points an unmatched test at the file', async () => {
    const { evidence } = await collect(
      run([{ testSuite: 'test_calculator', testName: 'test_not_in_the_file', status: 'PASSED' }]),
      PYTHON_FILES,
    );

    expect(sourcesOf(evidence)[0]).toEqual({ kind: 'FILE', filePath: 'test_calculator.py' });
    expect(evidence.integrity[0].integrity).toEqual({ located: false });
    expect(evidence.payload.files[0].content).toBe(PYTHON_SOURCE);
  });

  it('sends one copy of the file however many of its tests went unmatched', async () => {
    // The Spock/ScalaTest case: the scanner finds no declarations, so every result falls back.
    const unmatched = Array.from({ length: 20 }, (_, index) => ({
      testSuite: 'test_calculator',
      testName: `spec_${index}`,
      status: 'PASSED' as const,
    }));
    const { evidence } = await collect(run(unmatched), PYTHON_FILES);

    expect(sourcesOf(evidence).every((source) => source.kind === 'FILE')).toBe(true);
    expect(evidence.payload.files).toHaveLength(1);

    const serialized = JSON.stringify(evidence);
    expect(serialized.split('assert add(2, 3) == 5').length - 1).toBe(1);
    expect(serialized.length).toBeLessThan(PYTHON_SOURCE.length * 20);
  });

  it('reports NONE when no source file can be located at all', async () => {
    const { evidence } = await collect(
      run([{ testSuite: 'nowhere', testName: 'test_x', status: 'PASSED' }]),
      PYTHON_FILES,
    );

    expect(sourcesOf(evidence)[0]).toEqual({ kind: 'NONE' });
    expect(evidence.integrity[0].integrity.located).toBe(false);
  });

  it('reads and scans each file once, however many of its tests ran', async () => {
    const { reads } = await collect(
      run([
        { testSuite: 'test_calculator', testName: 'test_add_returns_sum', status: 'PASSED' },
        { testSuite: 'test_calculator', testName: 'test_empty_body', status: 'PASSED' },
        { testSuite: 'test_calculator', testName: 'test_async_add', status: 'PASSED' },
      ]),
      PYTHON_FILES,
    );

    expect(reads).toHaveLength(1);
  });

  it('lists each distinct file once', async () => {
    const { evidence } = await collect(
      run([
        { testSuite: 'test_calculator', testName: 'test_add_returns_sum', status: 'PASSED' },
        { testSuite: 'test_calculator', testName: 'test_empty_body', status: 'PASSED' },
      ]),
      PYTHON_FILES,
    );

    expect(evidence.payload.files).toEqual([{ path: 'test_calculator.py', content: PYTHON_SOURCE }]);
    // filePath is the join key from a result back into files.
    for (const source of sourcesOf(evidence)) {
      expect(source.filePath).toBe(evidence.payload.files[0].path);
    }
  });

  it('lists no more files than the gateway accepts', async () => {
    const files = Object.fromEntries(
      Array.from({ length: 205 }, (_, index) => [`test_${index}.py`, `def test_${index}():\n    assert True\n`]),
    );
    const results = Array.from({ length: 205 }, (_, index) => ({
      testSuite: `test_${index}`,
      testName: `test_${index}`,
      status: 'PASSED' as const,
    }));
    const { evidence } = await collect(run(results), files);

    expect(evidence.payload.files).toHaveLength(200);
    const listed = new Set(evidence.payload.files.map((file) => file.path));
    const sources = sourcesOf(evidence);
    expect(sources.filter((source) => source.kind === 'TEST')).toHaveLength(200);
    expect(sources.filter((source) => source.kind === 'NONE')).toHaveLength(5);
    // A source must never point at a file that was left out of the payload.
    expect(sources.every((source) => source.kind === 'NONE' || listed.has(source.filePath as string))).toBe(true);
  });
});

describe('collectTestEvidence — paths must not leak the student', () => {
  it('sends a workspace-relative path with forward slashes', async () => {
    const { evidence } = await collect(
      run([{ testSuite: 'tests.test_calculator', testName: 'test_add_returns_sum', status: 'PASSED' }]),
      { [join('tests', 'test_calculator.py')]: PYTHON_SOURCE },
    );

    expect(sourcesOf(evidence)[0].filePath).toBe('tests/test_calculator.py');
  });

  it('degrades to the basename for a file outside the workspace folder', async () => {
    const outside = resolve('/elsewhere/vendor/test_outside.py');
    const testRun = run([
      {
        testSuite: 'unresolvable',
        testName: 'test_x',
        status: 'FAILED',
        stackTrace: `File "${outside}", line 3, in test_x`,
      },
    ]);

    const resolver = new TestLocationResolver(FOLDER, 'python', {
      exists: async (path) => resolve(path) === outside,
      listDirs: async () => [],
    });
    const evidence = await collectTestEvidence(testRun, resolver, {
      folderPath: FOLDER,
      captureSource: true,
      maxTotalChars: 200000,
      readFile: async () => 'def test_x():\n    assert True\n',
    });

    expect(sourcesOf(evidence)[0].filePath).toBe('test_outside.py');
    expect(sourcesOf(evidence)[0].filePath).not.toContain(sep);
    expect(relative(FOLDER, outside).startsWith('..')).toBe(true);
  });
});

describe('collectTestEvidence — budget and opt-out', () => {
  const three = run([
    { testSuite: 'test_calculator', testName: 'test_add_returns_sum', status: 'PASSED' },
    { testSuite: 'test_calculator', testName: 'test_async_add', status: 'PASSED' },
    { testSuite: 'test_calculator', testName: 'test_empty_body', status: 'PASSED' },
  ]);

  it('truncates a file that only partly fits, keeping locations and integrity', async () => {
    const { evidence } = await collect(three, PYTHON_FILES, { maxTotalChars: 900 });

    const file = evidence.payload.files[0];
    expect(file.truncated).toBe(true);
    expect(file.content).toContain('assert add(2, 3) == 5');
    expect(file.content).toContain('more characters]');
    expect(file.content).not.toContain('assert "{" + "}" == "{}"');

    expect(sourcesOf(evidence).every((source) => source.kind === 'TEST')).toBe(true);
    expect(evidence.integrity.every((entry) => entry.integrity.located)).toBe(true);
  });

  it('sends the files the budget no longer covers without content', async () => {
    const testRun = run([
      { testSuite: 'test_a', testName: 'test_a', status: 'PASSED' },
      { testSuite: 'test_b', testName: 'test_b', status: 'PASSED' },
    ]);
    const body = (name: string): string => `def ${name}():\n    assert ${'x'.repeat(200)}\n`;
    // test_a's 226 chars plus the 57 reserved for a truncation notice, leaving test_b no room.
    const { evidence } = await collect(
      testRun,
      { 'test_a.py': body('test_a'), 'test_b.py': body('test_b') },
      { maxTotalChars: 283 },
    );

    expect(evidence.payload.files).toEqual([
      { path: 'test_a.py', content: body('test_a') },
      { path: 'test_b.py' },
    ]);
    expect(sourcesOf(evidence)[1]).toMatchObject({ kind: 'TEST', filePath: 'test_b.py' });
  });

  it('reads each test off its file rather than sending its body separately', async () => {
    const { evidence } = await collect(three, PYTHON_FILES);

    expect(sourcesOf(evidence).every((source) => source.kind === 'TEST')).toBe(true);
    expect(evidence.payload.files[0].content).toBe(PYTHON_SOURCE);

    const serialized = JSON.stringify(evidence.payload);
    expect(serialized.split('assert add(2, 3) == 5').length - 1).toBe(1);
  });

  it('opting out of source still submits where each test was found', async () => {
    const { evidence } = await collect(three, PYTHON_FILES, { captureSource: false });

    for (const source of sourcesOf(evidence)) {
      expect(source.kind).toBe('TEST');
      expect(source.startLine).toBeGreaterThan(0);
    }
    expect(evidence.payload.files).toEqual([{ path: 'test_calculator.py' }]);
    expect(evidence.integrity.every((entry) => entry.integrity.located)).toBe(true);
    expect(evidence.payload.captureDisabled).toBe(true);
    expect(evidence.integrity.filter((entry) => entry.integrity.empty).length).toBe(1);
  });

  it('keeps the truncation notice inside the budget it reports against', async () => {
    const maxTotalChars = 120;
    const { evidence } = await collect(three, PYTHON_FILES, { maxTotalChars });

    const inFiles = evidence.payload.files.reduce(
      (total, file) => total + (file.content?.length ?? 0),
      0,
    );

    expect(evidence.payload.files[0].truncated).toBe(true);
    expect(inFiles).toBeLessThanOrEqual(maxTotalChars);
  });

  it('leaves captureDisabled unset when capture is on', async () => {
    const { evidence } = await collect(three, PYTHON_FILES);

    expect(evidence.payload.captureDisabled).toBeUndefined();
  });
});

describe('collectTestEvidence — local integrity signals', () => {
  it('computes per-test signals for the pre-submit warning', async () => {
    const { evidence } = await collect(
      run([
        { testSuite: 'test_calculator', testName: 'test_add_returns_sum', status: 'PASSED' },
        { testSuite: 'test_calculator', testName: 'test_empty_body', status: 'PASSED' },
        { testSuite: 'test_calculator', testName: 'test_only_a_docstring', status: 'PASSED' },
        { testSuite: 'test_calculator', testName: 'test_skipped_outright', status: 'SKIPPED' },
        { testSuite: 'nowhere', testName: 'test_missing', status: 'PASSED' },
      ]),
      PYTHON_FILES,
    );

    const integrity = evidence.integrity.map((entry) => entry.integrity);
    expect(integrity.filter((entry) => entry.located)).toHaveLength(4);
    expect(integrity.filter((entry) => entry.empty)).toHaveLength(2);
    expect(integrity.filter((entry) => entry.located && entry.assertionCount === 0)).toHaveLength(2);
    expect(integrity.filter((entry) => entry.skipMarker)).toHaveLength(1);
  });
});

describe('collectTestEvidence — tamper detection', () => {
  const testRun = run([
    { testSuite: 'test_calculator', testName: 'test_add_returns_sum', status: 'PASSED' },
    { testSuite: 'test_calculator', testName: 'test_async_add', status: 'PASSED' },
  ]);

  it('flags the gutted test, but leaves its neighbour alone', async () => {
    const gutted = PYTHON_SOURCE.replace(
      'def test_add_returns_sum():\n    assert add(2, 3) == 5',
      'def test_add_returns_sum():\n    pass',
    );
    expect(gutted).not.toBe(PYTHON_SOURCE);

    const { evidence } = await collect(testRun, { 'test_calculator.py': gutted });

    expect(evidence.integrity[0].integrity).toMatchObject({ empty: true, assertionCount: 0 });
    expect(describeSuspiciousTests(evidence.integrity)).toEqual([
      {
        testSuite: 'test_calculator',
        testName: 'test_add_returns_sum',
        reasons: ['has an empty body'],
      },
    ]);
  });

  it('leaves sabotage outside every test body to the submitted file content', async () => {
    const sabotaged = PYTHON_SOURCE.replace(
      'from calculator import add, divide',
      'from calculator import add, divide\n\nadd = lambda a, b: 5',
    );

    const { evidence } = await collect(testRun, { 'test_calculator.py': sabotaged });

    expect(evidence.payload.files[0].content).toContain('add = lambda a, b: 5');
    expect(describeSuspiciousTests(evidence.integrity)).toEqual([]);
  });

  it('flags a test whose assertion was removed but whose body still does work', async () => {
    const declawed = PYTHON_SOURCE.replace(
      'def test_add_returns_sum():\n    assert add(2, 3) == 5',
      'def test_add_returns_sum():\n    result = add(2, 3)\n    print(result)',
    );
    const { evidence } = await collect(testRun, { 'test_calculator.py': declawed });

    expect(evidence.integrity[0].integrity).toMatchObject({ empty: false, assertionCount: 0 });
    expect(describeSuspiciousTests(evidence.integrity)[0].reasons).toEqual(['makes no assertions']);
  });

  it('flags a test that was disabled rather than fixed', async () => {
    const disabled = PYTHON_SOURCE.replace(
      'def test_add_returns_sum():',
      '@pytest.mark.skip(reason="later")\ndef test_add_returns_sum():',
    );
    const { evidence } = await collect(testRun, { 'test_calculator.py': disabled });

    expect(evidence.integrity[0].integrity).toMatchObject({
      skipMarker: '@pytest.mark.skip(reason="later")',
    });
    expect(describeSuspiciousTests(evidence.integrity)[0].reasons).toEqual([
      'is marked as skipped (@pytest.mark.skip(reason="later"))',
    ]);
  });
});

describe('describeSuspiciousTests', () => {
  it('names emptied, assertion-free and disabled tests', async () => {
    const testRun = run([
      { testSuite: 'test_calculator', testName: 'test_add_returns_sum', status: 'PASSED' },
      { testSuite: 'test_calculator', testName: 'test_empty_body', status: 'PASSED' },
      { testSuite: 'test_calculator', testName: 'test_skipped_outright', status: 'SKIPPED' },
    ]);
    const { evidence } = await collect(testRun, PYTHON_FILES);

    expect(describeSuspiciousTests(evidence.integrity)).toEqual([
      { testSuite: 'test_calculator', testName: 'test_empty_body', reasons: ['has an empty body'] },
      {
        testSuite: 'test_calculator',
        testName: 'test_skipped_outright',
        reasons: ['is marked as skipped (@pytest.mark.skip(reason="not implemented yet"))'],
      },
    ]);
  });

  it('does not flag a framework-reported skip that has no skip marker', async () => {
    const testRun = run([
      { testSuite: 'test_calculator', testName: 'test_add_returns_sum', status: 'SKIPPED' },
    ]);
    const { evidence } = await collect(testRun, PYTHON_FILES);

    expect(describeSuspiciousTests(evidence.integrity)).toEqual([]);
  });

  it('stays quiet about unlocated tests when they are a small minority', async () => {
    const results: NormalizedTestCase[] = [
      { testSuite: 'test_calculator', testName: 'test_add_returns_sum', status: 'PASSED' },
      { testSuite: 'test_calculator', testName: 'test_async_add', status: 'PASSED' },
      { testSuite: 'test_calculator', testName: 'test_brace_in_a_string', status: 'PASSED' },
      { testSuite: 'nowhere', testName: 'test_missing', status: 'PASSED' },
    ];
    const testRun = run(results);
    const { evidence } = await collect(testRun, PYTHON_FILES);

    expect(describeSuspiciousTests(evidence.integrity)).toEqual([]);
  });

  it('reports unlocated tests once they dominate the run', async () => {
    const testRun = run([
      { testSuite: 'nowhere', testName: 'test_a', status: 'PASSED' },
      { testSuite: 'nowhere', testName: 'test_b', status: 'PASSED' },
    ]);
    const { evidence } = await collect(testRun, PYTHON_FILES);

    expect(describeSuspiciousTests(evidence.integrity).map((f) => f.reasons)).toEqual([
      ["could not be found in the project's source"],
      ["could not be found in the project's source"],
    ]);
  });
});
