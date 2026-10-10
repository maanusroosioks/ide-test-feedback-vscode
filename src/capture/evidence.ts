import { analyzeDeclaration, unlocatedIntegrity, type TestIntegrityEntry } from './integrity';
import type { LocatedResult, SourceFile } from './sourceFiles';
import type { NormalizedTestCase, NormalizedTestRun } from '../core/types';
import { REQUEST_LIMITS } from '../services/httpTypes';

/** Workspace-relative, forward slashes — never absolute, which would leak the student's username. */
type RelativePath = string;

export interface UnlocatedSource {
  kind: 'NONE';
}

/** The file was found but the test could not be picked out of it. */
export interface FileSource {
  kind: 'FILE';
  filePath: RelativePath;
}

export interface DeclaredSource {
  kind: 'TEST';
  filePath: RelativePath;
  /** 1-based, in the original file: the test is read by slicing this range out of its file. */
  startLine: number;
  endLine: number;
}

export type TestSource = UnlocatedSource | FileSource | DeclaredSource;

/** How far the test was resolved in the project's source, whether or not its file's content was captured. */
export type TestSourceKind = TestSource['kind'];

export interface TestSourceFile {
  /** Workspace-relative, forward slashes. The join key from `TestSource.filePath`. */
  path: string;
  /** Absent when capture is off or the per-submission budget ran out. */
  content?: string;
  truncated?: boolean;
}

/** The half sent to the grader, and all the payload builder may see. */
export interface TestEvidencePayload {
  /** Index-aligned with `run.results`. */
  sources: TestSource[];
  /** Each distinct test file once, and the source every located test is read from. */
  files: TestSourceFile[];
  /** Set only when the student switched source capture off. */
  captureDisabled?: boolean;
}

export interface TestEvidence {
  payload: TestEvidencePayload;
  /** Local only — feeds the pre-submit warning. Unreachable from `payload`, so it cannot be sent. */
  integrity: TestIntegrityEntry[];
}

export interface CaptureOptions {
  captureSource: boolean;
  maxTotalChars: number;
}

function truncationNotice(removed: number): string {
  return `\n… [truncated by moodle-test-submit: ${removed} more characters]`;
}

/** Reserved before capping, so content plus notice never exceeds the budget. */
function noticeReserve(text: string): number {
  return truncationNotice(text.length).length;
}

function capText(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  // Never between the halves of a surrogate pair, which would send half an emoji.
  const end = /[\uD800-\uDBFF]/.test(text[limit - 1] ?? '') ? limit - 1 : limit;
  const removed = text.length - end;
  return { text: `${text.slice(0, end)}${truncationNotice(removed)}`, truncated: true };
}

function sourceOf({ file, declaration }: LocatedResult): TestSource {
  if (!file) return { kind: 'NONE' };
  if (!declaration) return { kind: 'FILE', filePath: file.relativePath };
  return { kind: 'TEST', filePath: file.relativePath, startLine: declaration.startLine, endLine: declaration.endLine };
}

function integrityOf(testCase: NormalizedTestCase, { file, declaration }: LocatedResult): TestIntegrityEntry {
  return {
    testSuite: testCase.testSuite,
    testName: testCase.testName,
    integrity: file && declaration ? analyzeDeclaration(declaration, file.language) : unlocatedIntegrity(),
  };
}

/**
 * Each distinct test file once, up to the request's limit. Sorted before the budget is charged,
 * so which files keep their content does not depend on the order the tests ran in.
 */
function selectFiles(located: LocatedResult[]): SourceFile[] {
  const distinct = new Set(located.flatMap((entry): SourceFile[] => (entry.file ? [entry.file] : [])));
  return [...distinct]
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
    .slice(0, REQUEST_LIMITS.testFiles);
}

/** Fills in each file's content, in order, until the budget runs out; the rest go without. */
function captureContents(files: SourceFile[], options: CaptureOptions): TestSourceFile[] {
  let budget = Math.max(0, options.maxTotalChars);
  return files.map((file) => {
    const entry: TestSourceFile = { path: file.relativePath };
    const room = budget - noticeReserve(file.text);
    if (options.captureSource && room > 0) {
      const capped = capText(file.text, room);
      entry.content = capped.text;
      if (capped.truncated) entry.truncated = true;
      budget -= capped.text.length;
    }
    return entry;
  });
}

/** `located` is index-aligned with `run.results`, as `locateResults` returns it. */
export function collectTestEvidence(
  run: NormalizedTestRun,
  located: LocatedResult[],
  options: CaptureOptions,
): TestEvidence {
  const files = selectFiles(located);
  // A source must never name a file the payload leaves out, or the grader has nothing to join it to.
  const keptPaths = new Set(files.map((file) => file.relativePath));
  const sources = run.results.map((_, index): TestSource => {
    const source = sourceOf(located[index] ?? {});
    return source.kind === 'NONE' || keptPaths.has(source.filePath) ? source : { kind: 'NONE' };
  });

  return {
    payload: {
      sources,
      files: captureContents(files, options),
      captureDisabled: options.captureSource ? undefined : true,
    },
    integrity: run.results.map((testCase, index) => integrityOf(testCase, located[index] ?? {})),
  };
}
