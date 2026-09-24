// The UI layer hands in an already-constructed TestLocationResolver.

import { readFile } from 'node:fs/promises';
import { basename, isAbsolute, relative, sep } from 'node:path';
import type { TestLocationResolver } from './location';
import { analyzeDeclaration, unlocatedIntegrity, type TestIntegrity } from './integrity';
import {
  languageForFile,
  matchDeclaration,
  scanTestDeclarations,
  type SourceLanguage,
  type TestDeclaration,
} from '../source';
import type { NormalizedTestRun } from '../core/types';
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

export interface TestSourceFile {
  /** Workspace-relative, forward slashes. The join key from `TestSource.filePath`. */
  path: string;
  /** Absent when capture is off or the per-submission budget ran out. */
  content?: string;
  truncated?: boolean;
}

/** The half bound for the grader. Everything the payload builder is allowed to see. */
export interface TestEvidencePayload {
  /** Index-aligned with `run.results`. */
  sources: TestSource[];
  /** Each distinct test file once, and the source every located test is read from. */
  files: TestSourceFile[];
  /** Set only when the student switched source capture off. */
  captureDisabled?: boolean;
}

/** Names its own test, so the warning path never indexes back into the run to find out whose it is. */
export interface TestIntegrityEntry {
  testSuite?: string;
  testName: string;
  integrity: TestIntegrity;
}

export interface TestEvidence {
  payload: TestEvidencePayload;
  /** Local only — feeds the pre-submit warning. Unreachable from `payload`, so it cannot be sent. */
  integrity: TestIntegrityEntry[];
}

export interface CaptureOptions {
  folderPath: string;
  captureSource: boolean;
  maxTotalChars: number;
  readFile?: (path: string) => Promise<string>;
}

export interface SuspiciousTest {
  testSuite?: string;
  testName: string;
  reasons: string[];
}

interface SourceFile {
  relativePath: string;
  text: string;
  language?: SourceLanguage;
  declarations: TestDeclaration[];
}

/** Below this share of unlocatable tests it's an unusual project layout, not a signal. */
const UNLOCATED_SHARE = 0.3;

function toLf(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

function toRelative(folderPath: string, absolutePath: string): string {
  const path = relative(folderPath, absolutePath);
  if (!path || path.startsWith('..') || isAbsolute(path)) {
    return basename(absolutePath);
  }
  return path.split(sep).join('/');
}

function truncationNotice(removed: number): string {
  return `\n… [truncated by moodle-test-submit: ${removed} more characters]`;
}

/** The notice outruns a short file, so it is reserved from the budget rather than the cap. */
function noticeReserve(text: string): number {
  return truncationNotice(text.length).length;
}

function capText(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  const removed = text.length - limit;
  return { text: `${text.slice(0, limit)}${truncationNotice(removed)}`, truncated: true };
}

export async function collectTestEvidence(
  run: NormalizedTestRun,
  resolver: TestLocationResolver,
  options: CaptureOptions,
): Promise<TestEvidence> {
  const read = options.readFile ?? ((path: string): Promise<string> => readFile(path, 'utf8'));
  const loaded = new Map<string, SourceFile | undefined>();
  const sources: TestSource[] = [];
  const integrity: TestIntegrityEntry[] = [];

  // One read and one scan per file per run, however many of its tests ran.
  const loadFile = async (absolutePath: string): Promise<SourceFile | undefined> => {
    if (loaded.has(absolutePath)) return loaded.get(absolutePath);

    let file: SourceFile | undefined;
    try {
      const text = toLf(await read(absolutePath));
      const language = languageForFile(absolutePath, run.language);
      file = {
        relativePath: toRelative(options.folderPath, absolutePath),
        text,
        language,
        declarations: language ? scanTestDeclarations(text, language) : [],
      };
    } catch {
      file = undefined;
    }
    loaded.set(absolutePath, file);
    return file;
  };

  for (const testCase of run.results) {
    const record = (source: TestSource, signals: TestIntegrity): void => {
      sources.push(source);
      integrity.push({ testSuite: testCase.testSuite, testName: testCase.testName, integrity: signals });
    };

    const location = await resolver.resolveTestLocation(testCase.testSuite, testCase.stackTrace);
    const file = location ? await loadFile(location.file) : undefined;
    if (!file) {
      record({ kind: 'NONE' }, unlocatedIntegrity());
      continue;
    }

    // An unknown language means nothing was scanned, so there is nothing to match against.
    const language = file.language;
    let declaration: TestDeclaration | undefined;
    let signals = unlocatedIntegrity();
    if (language) {
      declaration = matchDeclaration(file.declarations, testCase.testName, testCase.testSuite, location?.line);
      if (declaration) signals = analyzeDeclaration(declaration, language);
    }

    record(
      declaration
        ? {
            kind: 'TEST',
            filePath: file.relativePath,
            startLine: declaration.startLine,
            endLine: declaration.endLine,
          }
        : { kind: 'FILE', filePath: file.relativePath },
      signals,
    );
  }

  // Sorted before the budget is charged, so which files keep their content does not depend on
  // the order the tests ran in.
  const sourceFiles = [...loaded.values()]
    .filter((file): file is SourceFile => file !== undefined)
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
    .slice(0, REQUEST_LIMITS.testFiles);

  let budget = Math.max(0, options.maxTotalChars);
  const files: TestSourceFile[] = [];
  for (const file of sourceFiles) {
    const entry: TestSourceFile = { path: file.relativePath };
    const room = budget - noticeReserve(file.text);
    if (options.captureSource && room > 0) {
      const capped = capText(file.text, room);
      entry.content = capped.text;
      if (capped.truncated) entry.truncated = true;
      budget -= capped.text.length;
    }
    files.push(entry);
  }

  return {
    payload: { sources, files, captureDisabled: options.captureSource ? undefined : true },
    integrity,
  };
}

/**
 * A framework-reported SKIPPED status is deliberately not a reason on its own: it is legitimate
 * and already visible in the results, and warning on it would train students to click through.
 */
export function describeSuspiciousTests(entries: TestIntegrityEntry[]): SuspiciousTest[] {
  const total = entries.length;
  const unlocated = entries.filter((entry) => !entry.integrity.located).length;
  const reportUnlocated = total > 0 && unlocated / total > UNLOCATED_SHARE;
  const findings: SuspiciousTest[] = [];

  for (const { testSuite, testName, integrity } of entries) {
    const reasons: string[] = [];
    if (integrity.empty) {
      reasons.push('has an empty body');
    } else if (integrity.located && integrity.assertionCount === 0) {
      reasons.push('makes no assertions');
    }
    if (integrity.skipMarker) {
      reasons.push(`is marked as skipped (${integrity.skipMarker})`);
    }
    if (!integrity.located && reportUnlocated) {
      reasons.push("could not be found in the project's source");
    }

    if (reasons.length > 0) {
      findings.push({ testSuite, testName, reasons });
    }
  }

  return findings;
}
