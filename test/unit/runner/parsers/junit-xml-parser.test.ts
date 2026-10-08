import { utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pathExists } from '../../../../src/util/shell';
import {
  clearReportDirs,
  parseJUnitXml,
  parseJUnitXmlDirectory,
  parseJUnitXmlFile,
} from '../../../../src/runner/parsers/junit-xml-parser';
import { ReportUnavailableError } from '../../../../src/runner/parsers/report-file';
import { tempDir, writeTree } from '../../helpers/fs';
import { readFixture } from '../../helpers/project';

const MINIMAL_XML = `<?xml version="1.0"?>
<testsuite name="com.example.SampleTest">
  <testcase classname="com.example.SampleTest" name="works" time="0.01"/>
</testsuite>`;

describe('parseJUnitXml', () => {
  it('parses a Surefire-style report (single root testsuite)', () => {
    const results = parseJUnitXml(readFixture('junit/sample-surefire-report.xml'));

    expect(results).toHaveLength(3);

    const passed = results.find((r) => r.testName === 'addsTwoNumbers');
    expect(passed).toMatchObject({ status: 'PASSED', testSuite: 'com.example.CalculatorTest', durationMs: 12 });

    const failed = results.find((r) => r.testName === 'dividesByZero');
    expect(failed?.status).toBe('FAILED');
    expect(failed?.message).toContain('expected exception');
    expect(failed?.stackTrace).toContain('AssertionError');

    const skipped = results.find((r) => r.testName === 'ignoredForNow');
    expect(skipped?.status).toBe('SKIPPED');
  });

  it('names a test case that has no name, rather than letting it sink the submission', () => {
    const [result] = parseJUnitXml('<testsuite name="s"><testcase classname="s"/></testsuite>');

    expect(result.testName).toBe('(unnamed test)');
  });

  it('keeps a numeric-looking failure body as text', () => {
    const [result] = parseJUnitXml(`<testsuite name="s">
      <testcase classname="s" name="t"><failure message="7">42</failure></testcase>
    </testsuite>`);

    expect(result.message).toBe('7');
    expect(result.stackTrace).toBe('42');
  });

  it('parses a pytest-style report (testsuites wrapper, includes an error case)', () => {
    const results = parseJUnitXml(readFixture('junit/sample-pytest-junit.xml'));

    expect(results.map((r) => r.status).sort()).toEqual(['ERROR', 'FAILED', 'PASSED', 'SKIPPED']);

    const errored = results.find((r) => r.testName === 'test_reads_missing_file');
    expect(errored?.message).toContain('FileNotFoundError');

    // The <testsuite> is named "pytest"; only the case carries the owning module.
    expect(new Set(results.map((r) => r.testSuite))).toEqual(new Set(['test_calculator']));
  });

  it('falls back to the suite name when a case has no classname', () => {
    const results = parseJUnitXml(`<?xml version="1.0"?>
<testsuite name="com.example.SampleTest">
  <testcase name="works" time="0.01"/>
</testsuite>`);

    expect(results[0].testSuite).toBe('com.example.SampleTest');
  });

  it('collects test cases from nested <testsuite> elements', () => {
    const xml = `<?xml version="1.0"?>
<testsuites>
  <testsuite name="outer">
    <testcase classname="outer" name="outer_test" time="0.01"/>
    <testsuite name="inner">
      <testcase classname="inner" name="inner_test" time="0.02"/>
    </testsuite>
  </testsuite>
</testsuites>`;
    const results = parseJUnitXml(xml);
    expect(results.map((r) => r.testName).sort()).toEqual(['inner_test', 'outer_test']);
  });
});

describe('parseJUnitXmlDirectory', () => {
  it('returns nothing for a directory that does not exist', async () => {
    expect(await parseJUnitXmlDirectory(join(tmpdir(), 'no-such-dir-xyz'))).toHaveLength(0);
  });

  it('recurses into subdirectories (multi-module layout)', async () => {
    const dir = await tempDir();
    await writeTree(dir, { 'module-a/TEST-a.xml': MINIMAL_XML, 'module-b/TEST-b.xml': MINIMAL_XML });

    expect(await parseJUnitXmlDirectory(dir)).toHaveLength(2);
  });

  it('parses reports sitting directly in the directory', async () => {
    const dir = await tempDir();
    await writeTree(dir, { 'TEST-com.example.SampleTest.xml': MINIMAL_XML });

    expect(await parseJUnitXmlDirectory(dir)).toHaveLength(1);
  });

  it('with reportDir, only parses reports inside a matching directory (reactor layout)', async () => {
    const root = await tempDir();
    await writeTree(root, {
      'mod-a/target/surefire-reports/TEST-a.xml': MINIMAL_XML,
      'mod-b/target/surefire-reports/TEST-b.xml': MINIMAL_XML,
      // Noise that must be ignored: an XML file outside a surefire-reports dir, and one under src/.
      'mod-a/target/other.xml': MINIMAL_XML,
      'src/test/TEST-nope.xml': MINIMAL_XML,
    });

    expect(await parseJUnitXmlDirectory(root, { reportDir: 'surefire-reports' })).toHaveLength(2);
  });

  it('with a multi-segment reportDir, finds per-module report dirs (Gradle layout)', async () => {
    const root = await tempDir();
    await writeTree(root, {
      'app/build/test-results/test/TEST-app.xml': MINIMAL_XML,
      'lib/build/test-results/test/TEST-lib.xml': MINIMAL_XML,
      // The binary-results sibling Gradle also writes, which must not match.
      'app/build/test-results/binary/TEST-app.xml': MINIMAL_XML,
    });

    expect(await parseJUnitXmlDirectory(root, { reportDir: 'build/test-results/test' })).toHaveLength(2);
  });

  // Clearing the report dirs before the run is what keeps old reports out: file times can come
  // from another machine's clock on a network share or a WSL path.
  it('reads a report whatever its timestamp says', async () => {
    const dir = await tempDir();
    await writeTree(dir, { 'TEST-skewed.xml': MINIMAL_XML });
    const longAgo = new Date(Date.now() - 60 * 60_000);
    await utimes(join(dir, 'TEST-skewed.xml'), longAgo, longAgo);

    expect(await parseJUnitXmlDirectory(dir)).toHaveLength(1);
  });

  it('returns results in a stable order regardless of filesystem ordering', async () => {
    const root = await tempDir();
    for (const name of ['c', 'a', 'b']) {
      await writeTree(root, { [`${name}/TEST.xml`]: MINIMAL_XML.replace('name="works"', `name="works_${name}"`) });
    }

    const results = await parseJUnitXmlDirectory(root);
    expect(results.map((r) => r.testName)).toEqual(['works_a', 'works_b', 'works_c']);
  });

  it('skips an unparseable report but keeps the rest, warning once', async () => {
    const root = await tempDir();
    await writeTree(root, { 'TEST-good.xml': MINIMAL_XML, 'TEST-bad.xml': '' });

    const warnings: string[] = [];
    const results = await parseJUnitXmlDirectory(root, { onWarning: (m) => warnings.push(m) });

    expect(results).toHaveLength(1);
    expect(warnings).toEqual([expect.stringContaining('TEST-bad.xml')]);
  });
});

describe('parseJUnitXmlFile', () => {
  it('reports a missing report rather than returning nothing', async () => {
    const path = join(tmpdir(), 'no-such-report-xyz.xml');
    await expect(parseJUnitXmlFile(path)).rejects.toBeInstanceOf(ReportUnavailableError);
    await expect(parseJUnitXmlFile(path)).rejects.toThrow('no report was written');
  });

  it('reports a file that is not a JUnit report rather than returning nothing', async () => {
    const dir = await tempDir();
    await writeTree(dir, { 'TEST-broken.xml': '' });

    await expect(parseJUnitXmlFile(join(dir, 'TEST-broken.xml'))).rejects.toThrow('could not be parsed');
  });

  it('still accepts a valid report that genuinely collected no tests', async () => {
    const dir = await tempDir();
    await writeTree(dir, { 'TEST-empty.xml': '<?xml version="1.0"?><testsuites/>' });

    await expect(parseJUnitXmlFile(join(dir, 'TEST-empty.xml'))).resolves.toEqual([]);
  });
});

describe('clearReportDirs', () => {
  it('removes matching report dirs in every module, leaving everything else', async () => {
    const root = await tempDir();
    for (const module of ['mod-a', 'mod-b']) {
      await writeTree(root, {
        [`${module}/target/surefire-reports/TEST-old.xml`]: MINIMAL_XML,
        [`${module}/target/keep.xml`]: MINIMAL_XML,
      });
    }

    await clearReportDirs(root, 'surefire-reports');

    expect(await parseJUnitXmlDirectory(root, { reportDir: 'surefire-reports' })).toHaveLength(0);
    expect(await pathExists(join(root, 'mod-a', 'target', 'keep.xml'))).toBe(true);
  });

  it('refuses to clear the whole tree when given no directory to match', async () => {
    const root = await tempDir();
    await expect(clearReportDirs(root, '')).rejects.toThrow('refusing to clear');
    expect(await pathExists(root)).toBe(true);
  });
});
