import type { TestStatus } from '../core/types';

export type TestResultStatus = TestStatus;

export type Ide = 'VSCODE';

/** Mirrors the gateway's bean validation on `TestRunRequest` and its nested DTOs. */
export const REQUEST_LIMITS = {
  assignmentKey: 100,
  projectName: 255,
  commitHash: 100,
  repoUrl: 1024,
  testSuite: 255,
  testName: 1024,
  path: 1024,
  results: 5000,
  testFiles: 200,
  /** `durationMs` is a Java `Integer`. */
  durationMs: 2_147_483_647,
} as const;

const ASSIGNMENT_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Why the gateway would reject `assignmentKey`, or `undefined` if it is acceptable. */
export function assignmentKeyProblem(assignmentKey: string): string | undefined {
  if (!assignmentKey.trim()) {
    return 'The assignment key must not be blank.';
  }
  if (assignmentKey.length > REQUEST_LIMITS.assignmentKey) {
    return `The assignment key must be at most ${REQUEST_LIMITS.assignmentKey} characters.`;
  }
  if (!ASSIGNMENT_KEY_PATTERN.test(assignmentKey)) {
    return "The assignment key may only contain letters, digits, '_' and '-'.";
  }
  return undefined;
}

/**
 * Omitted entirely when the test was not found in the project's source. `filePath` alone means the
 * file was found but the test could not be picked out of it — read the whole file from `testFiles`.
 */
export interface TestSourceRequest {
  /** Workspace-relative, forward slashes. Never absolute. */
  filePath: string;
  /** 1-based, in the original file: slice this range out of the matching `testFiles` content. */
  startLine?: number;
  endLine?: number;
}

/** Each distinct test file once, rather than one copy of its code per test. */
export interface TestSourceFileRequest {
  /** Workspace-relative, forward slashes. Matches `TestSourceRequest.filePath`. */
  path: string;
  /** LF-normalized. Absent when capture is off or the per-submission budget ran out. */
  content?: string;
  /** Cut at a character boundary, so line numbers still hold for what remains. */
  truncated?: boolean;
}

export interface TestResultRequest {
  testSuite?: string;
  testName: string;
  status: TestResultStatus;
  durationMs?: number;
  message?: string;
  source?: TestSourceRequest;
}

export interface TestRunRequest {
  assignmentKey: string;
  ide: Ide;
  projectName?: string;
  commitHash?: string;
  /** Normalized to a browsable HTTPS URL — never carries embedded credentials or the SSH form. */
  repoUrl?: string;
  startedAt?: number;
  finishedAt?: number;
  results: TestResultRequest[];
  testFiles?: TestSourceFileRequest[];
  /** Present only when true. Distinguishes "capture off" from "sources could not be resolved". */
  captureDisabled?: boolean;
}
