import { UNNAMED_TEST, type NormalizedTestCase, type NormalizedTestRun } from './types';
import type { SubmissionMetadata } from './submissionMetadata';
import { redactLocalPaths, type LocalRoots } from './redactPaths';
import type { TestEvidencePayload, TestSource, TestSourceFile } from '../capture/evidence';
import {
  assignmentKeyProblem,
  REQUEST_LIMITS,
  type TestResultRequest,
  type TestRunRequest,
  type TestSourceFileRequest,
  type TestSourceRequest,
} from '../services/httpTypes';
import { MoodleSubmitError } from './errors';

export class InvalidPayloadError extends MoodleSubmitError {
  get userMessage(): string {
    return `Invalid submission: ${this.message}`;
  }
}

/**
 * Not a gateway limit: the one free-text field a test controls, capped so a huge assertion diff
 * can't push the whole run past the request size limit.
 */
const MAX_MESSAGE_CHARS = 4000;

function truncate(value: string, max: number): string;
function truncate(value: string | undefined, max: number): string | undefined;
function truncate(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  return value.length > max ? value.slice(0, max) : value;
}

function sanitizeForParamText(value: string | undefined): string | undefined {
  return value === undefined ? undefined : value.replace(/[<>]/g, '');
}

function textField(value: string, max: number): string;
function textField(value: string | undefined, max: number): string | undefined;
function textField(value: string | undefined, max: number): string | undefined {
  return truncate(sanitizeForParamText(value), max);
}

/** A cut-off URL points somewhere else entirely, so one that doesn't fit is dropped instead. */
function repoUrlField(value: string | undefined): string | undefined {
  return value !== undefined && value.length <= REQUEST_LIMITS.repoUrl ? value : undefined;
}

function durationField(durationMs: number | undefined): number | undefined {
  if (durationMs === undefined || !Number.isFinite(durationMs)) return undefined;
  return Math.min(Math.max(0, Math.round(durationMs)), REQUEST_LIMITS.durationMs);
}

/** The gateway rejects a whole run over bad timing, and timing is the least important part of it. */
function timingFields(run: NormalizedTestRun): Pick<TestRunRequest, 'startedAtMs' | 'finishedAtMs'> {
  const { startedAt, finishedAt } = run;
  if (startedAt < 0 || finishedAt < startedAt) return {};
  return { startedAtMs: startedAt, finishedAtMs: finishedAt };
}

/** Catches what the gateway would reject the whole run for, with a message the student can act on. */
function assertSubmittable(run: NormalizedTestRun, metadata: SubmissionMetadata): void {
  if (run.results.length === 0) {
    throw new InvalidPayloadError('Test run produced no results — nothing to submit.');
  }
  if (run.results.length > REQUEST_LIMITS.results) {
    throw new InvalidPayloadError(
      `Test run produced ${run.results.length} results; at most ${REQUEST_LIMITS.results} can be submitted.`,
    );
  }
  const problem = assignmentKeyProblem(metadata.assignmentKey);
  if (problem) {
    throw new InvalidPayloadError(problem);
  }
}

function toResultRequest(
  testCase: NormalizedTestCase,
  source: TestSource | undefined,
  localRoots: LocalRoots | undefined,
): TestResultRequest {
  return {
    testSuite: textField(testCase.testSuite, REQUEST_LIMITS.testSuite)?.trim() || undefined,
    // Sanitizing can empty a name, e.g. `<>`.
    testName: textField(testCase.testName, REQUEST_LIMITS.testName).trim() || UNNAMED_TEST,
    status: testCase.status,
    durationMs: durationField(testCase.durationMs),
    message: textField(redactLocalPaths(testCase.message, localRoots), MAX_MESSAGE_CHARS),
    source: source ? toSourceRequest(source) : undefined,
  };
}

function toSourceRequest(source: TestSource): TestSourceRequest | undefined {
  if (source.kind === 'NONE') return undefined;

  const path = truncate(source.filePath, REQUEST_LIMITS.path);
  if (source.kind === 'FILE') return { path };
  return { path, startLine: source.startLine, endLine: source.endLine };
}

function toSourceFileRequest(file: TestSourceFile): TestSourceFileRequest {
  return {
    path: truncate(file.path, REQUEST_LIMITS.path),
    content: file.content,
    truncated: file.truncated,
  };
}

export function buildTestRunRequest(
  run: NormalizedTestRun,
  metadata: SubmissionMetadata,
  evidence?: TestEvidencePayload,
  localRoots?: LocalRoots,
): TestRunRequest {
  assertSubmittable(run, metadata);

  const results = run.results.map((testCase, index) =>
    toResultRequest(testCase, evidence?.sources[index], localRoots),
  );
  // Already capped at REQUEST_LIMITS.testFiles by the evidence collector.
  const testFiles = evidence?.files.map(toSourceFileRequest);

  return {
    assignmentKey: metadata.assignmentKey,
    ide: 'VSCODE',
    projectName: truncate(metadata.projectName, REQUEST_LIMITS.projectName),
    commitHash: truncate(metadata.commitHash, REQUEST_LIMITS.commitHash),
    repoUrl: repoUrlField(metadata.repoUrl),
    ...timingFields(run),
    results,
    testFiles: testFiles && testFiles.length > 0 ? testFiles : undefined,
    captureDisabled: evidence?.captureDisabled,
  };
}
