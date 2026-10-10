import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { UNNAMED_TEST, type NormalizedTestCase } from '../../core/types';
import { describeError } from '../../core/errors';
import { removeDir } from '../../util/fs';
import { isWalkableDir } from '../../util/paths';
import { createReportParser, parseReportFile } from './report-file';

interface JUnitFailureXml {
  '@_message'?: string;
  '#text'?: string;
}

interface JUnitTestCaseXml {
  '@_classname'?: string;
  '@_name'?: string;
  '@_time'?: string;
  failure?: JUnitFailureXml | JUnitFailureXml[] | string;
  error?: JUnitFailureXml | JUnitFailureXml[] | string;
  skipped?: unknown;
}

interface JUnitTestSuiteXml {
  '@_name'?: string;
  testcase?: JUnitTestCaseXml[];
  testsuite?: JUnitTestSuiteXml[];
}

const parser = createReportParser(['testsuite', 'testcase']);

function toMillis(seconds?: string): number | undefined {
  if (seconds === undefined) return undefined;
  const value = Number.parseFloat(seconds);
  return Number.isFinite(value) ? Math.round(value * 1000) : undefined;
}

function firstOf<T>(value: T | T[] | undefined): T | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function extractFailure(node: JUnitFailureXml | JUnitFailureXml[] | string | undefined): {
  message?: string;
  stackTrace?: string;
} {
  // Several <failure> elements can appear; the first is the one that aborted the test.
  const failure = firstOf(node);
  if (failure === undefined) return {};
  if (typeof failure === 'string') return { stackTrace: failure };
  return { message: failure['@_message'], stackTrace: failure['#text'] };
}

function outcomeOf(testcase: JUnitTestCaseXml): Pick<NormalizedTestCase, 'status' | 'message' | 'stackTrace'> {
  if (testcase.failure !== undefined) return { status: 'FAILED', ...extractFailure(testcase.failure) };
  if (testcase.error !== undefined) return { status: 'ERROR', ...extractFailure(testcase.error) };
  if (testcase.skipped !== undefined) return { status: 'SKIPPED' };
  return { status: 'PASSED' };
}

function collectSuite(suite: JUnitTestSuiteXml, into: NormalizedTestCase[]): void {
  for (const testcase of suite.testcase ?? []) {
    into.push({
      // pytest names every suite "pytest"; only the case carries the owning module.
      testSuite: testcase['@_classname'] ?? suite['@_name'],
      testName: testcase['@_name'] || UNNAMED_TEST,
      durationMs: toMillis(testcase['@_time']),
      ...outcomeOf(testcase),
    });
  }

  // Aggregated reports can nest <testsuite> elements.
  for (const nested of suite.testsuite ?? []) {
    collectSuite(nested, into);
  }
}

export function parseJUnitXml(xml: string): NormalizedTestCase[] {
  const doc = parser.parse(xml);
  // fast-xml-parser doesn't throw on garbage, so an empty file would read as a run with no tests.
  if (doc.testsuites === undefined && doc.testsuite === undefined) {
    throw new Error('no <testsuite> element found — this is not a JUnit XML report');
  }
  const suites: JUnitTestSuiteXml[] = doc.testsuites?.testsuite ?? doc.testsuite ?? [];

  const results: NormalizedTestCase[] = [];
  for (const suite of suites) {
    collectSuite(suite, results);
  }
  return results;
}

export function parseJUnitXmlFile(path: string): Promise<NormalizedTestCase[]> {
  return parseReportFile(path, parseJUnitXml);
}

/** Large or irrelevant trees that never contain report directories. Hidden ones are skipped too. */
const PRUNE_DIRS = new Set([
  'node_modules',
  'src',
  'bin',
  'obj',
  'classes',
  'test-classes',
  'generated-sources',
  'generated-test-sources',
  'maven-status',
  'maven-archiver',
]);

export interface CollectReportsOptions {
  /**
   * Only use files in a directory whose trailing path segments match this, e.g.
   * `surefire-reports` or `build/test-results/test`. Unset means any directory.
   */
  reportDir?: string;
  /** Called per unusable report file; the rest are still parsed. */
  onWarning?(message: string): void;
}

interface ScannedDir {
  dir: string;
  entries: Dirent[];
}

function segmentsOf(reportDir: string | undefined): string[] {
  return reportDir === undefined ? [] : reportDir.split(/[\\/]/).filter(Boolean);
}

function endsWithSegments(root: string, dir: string, suffix: string[]): boolean {
  if (suffix.length === 0) return true;
  const segments = relative(root, dir).split(sep).filter(Boolean);
  const offset = segments.length - suffix.length;
  return offset >= 0 && suffix.every((want, i) => segments[offset + i] === want);
}

function isWalkable(entry: Dirent): boolean {
  // `isDirectory()` is false for symlinks, so the walk cannot loop.
  return entry.isDirectory() && isWalkableDir(entry.name, PRUNE_DIRS);
}

/** Every readable directory at or under `root`, in a stable order. */
async function scanTree(root: string, into: ScannedDir[]): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  into.push({ dir: root, entries });

  const subdirs = entries
    .filter(isWalkable)
    .map((entry) => entry.name)
    .sort();
  for (const name of subdirs) {
    await scanTree(join(root, name), into);
  }
}

async function findReportDirs(root: string, suffix: string[]): Promise<ScannedDir[]> {
  const scanned: ScannedDir[] = [];
  await scanTree(root, scanned);
  return scanned.filter(({ dir }) => endsWithSegments(root, dir, suffix));
}

/**
 * Clears previous results, so whatever is there after the run is from it. Walks rather than taking
 * a fixed path: one dir per module. (Not file timestamps: on a network share or a WSL path those
 * come from another machine's clock.)
 */
export async function clearReportDirs(root: string, reportDir: string): Promise<void> {
  const suffix = segmentsOf(reportDir);
  if (suffix.length === 0) {
    throw new Error('clearReportDirs needs a directory to match; refusing to clear the whole tree.');
  }
  const dirs = await findReportDirs(root, suffix);
  await Promise.all(dirs.map(({ dir }) => removeDir(dir)));
}

export async function parseJUnitXmlDirectory(
  root: string,
  opts: CollectReportsOptions = {},
): Promise<NormalizedTestCase[]> {
  const dirs = await findReportDirs(root, segmentsOf(opts.reportDir));
  const files = dirs.flatMap(({ dir, entries }) =>
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.xml'))
      .map((entry) => join(dir, entry.name))
      .sort(),
  );

  const perFile = await Promise.all(
    files.map(async (path) => {
      try {
        return await parseJUnitXmlFile(path);
      } catch (error) {
        opts.onWarning?.(describeError(error));
        return [];
      }
    }),
  );
  return perFile.flat();
}
