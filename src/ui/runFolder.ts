import * as vscode from 'vscode';
import type { AdapterRegistry } from '../runner/registry';
import type { AuthService } from '../auth/authService';
import {
  getPreferredAdapterId,
  getSourceCaptureSettings,
  getTestCommandOverrides,
  getWarnOnSuspiciousTests,
} from '../config/settings';
import { TestLocationResolver } from '../capture/location';
import { collectTestEvidence, type TestEvidence } from '../capture/evidence';
import { locateResults, SourceFileCache, type LocatedResult } from '../capture/sourceFiles';
import { describeSuspiciousTests } from '../capture/integrity';
import { runTests, type TestRunOutcome } from '../core/testRunner';
import { submitRun } from '../core/submitRun';
import type { NormalizedTestRun } from '../core/types';
import { describeError } from '../core/errors';
import type { Logger, StatusReporter } from '../core/ports';
import type { MoodleApiClient } from '../services/moodleApiClient';
import { pickAdapter } from './workspacePicker';
import { ensureConfigured } from './onboarding';
import { ensureAssignmentKey } from './assignmentKey';
import { confirmDegradedRun, describeFinding } from './degradedRunPrompt';
import type { TestItemTree } from './testItemTree';
import { applyResults } from './testResults';

export interface RunDeps {
  registry: AdapterRegistry;
  authService: AuthService;
  apiClient: MoodleApiClient;
  logger: Logger;
  status: StatusReporter;
}

/** What a run needs from the test controller that owns it. */
export interface RunEnv {
  context: vscode.ExtensionContext;
  controller: vscode.TestController;
  tree: TestItemTree;
  deps: RunDeps;
}

export interface PerformRunOptions {
  folder: vscode.WorkspaceFolder;
  submit: boolean;
  request?: vscode.TestRunRequest;
  signal?: AbortSignal;
  report?: (message: string) => void;
}

/** The Testing terminal renders raw bytes, so bare LF would stair-step. */
function toCrlf(text: string): string {
  return text.replace(/\r?\n/g, '\r\n');
}

/** One signal for both ways to stop a run: the command's progress notification and the Testing view. */
function linkAbort(
  signal: AbortSignal | undefined,
  token: vscode.CancellationToken,
): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const subscription = token.onCancellationRequested(abort);
  return {
    signal: controller.signal,
    dispose: () => {
      signal?.removeEventListener('abort', abort);
      subscription.dispose();
    },
  };
}

/** One folder's run in progress: what every step after starting it works with. */
interface RunScope {
  folder: vscode.WorkspaceFolder;
  testRun: vscode.TestRun;
  deps: RunDeps;
  report?: (message: string) => void;
}

async function traceResults(
  { folder, deps }: RunScope,
  run: NormalizedTestRun,
  resolver: TestLocationResolver,
): Promise<LocatedResult[] | undefined> {
  try {
    return await locateResults(run, resolver, new SourceFileCache(folder.uri.fsPath, run.platform));
  } catch (error) {
    // Tracing results into the source must never be able to break a run or a submission:
    // without it the results are still shown and sent, just not tied to their code.
    deps.logger.log(`Could not trace the results to the source: ${describeError(error)}`);
    return undefined;
  }
}

function gatherEvidence(
  { folder, deps }: RunScope,
  run: NormalizedTestRun,
  located: LocatedResult[],
): TestEvidence | undefined {
  try {
    const evidence = collectTestEvidence(run, located, getSourceCaptureSettings(folder.uri.fsPath));
    const { sources, files } = evidence.payload;
    const found = sources.filter((source) => source.kind === 'TEST').length;
    const fileChars = files.reduce((total, file) => total + (file.content?.length ?? 0), 0);
    deps.logger.log(
      `Located ${found}/${run.results.length} tests in ${files.length} file(s) (${fileChars} chars).`,
    );
    return evidence;
  } catch (error) {
    // Capturing source must never be able to break a submission.
    deps.logger.log(`Could not capture test source: ${describeError(error)}`);
    return undefined;
  }
}

/** Logs every finding, but asks only when the warning is on. `false` means the student backed out. */
async function confirmIntegrity({ folder, deps }: RunScope, evidence: TestEvidence, total: number): Promise<boolean> {
  const findings = describeSuspiciousTests(evidence.integrity);
  for (const finding of findings) {
    deps.logger.log(`Integrity warning: ${describeFinding(finding)}`);
  }
  if (findings.length === 0 || !getWarnOnSuspiciousTests(folder.uri.fsPath)) return true;
  return confirmDegradedRun(findings, total);
}

async function submitResults(
  scope: RunScope,
  { run, summary }: TestRunOutcome,
  located: LocatedResult[] | undefined,
): Promise<void> {
  const { folder, testRun, deps, report } = scope;
  // Untraced, every test would look missing from the source and set off the tampering warning.
  const evidence = located && gatherEvidence(scope, run, located);
  if (evidence && !(await confirmIntegrity(scope, evidence, summary.total))) {
    deps.logger.log('Submission cancelled at the integrity warning.');
    testRun.appendOutput(toCrlf('\nSubmission cancelled.\n'));
    return;
  }

  report?.('Submitting to Moodle…');
  await submitRun(
    run,
    {
      folderPath: folder.uri.fsPath,
      projectName: folder.name,
      evidence: evidence?.payload,
    },
    { apiClient: deps.apiClient, logger: deps.logger },
  );
  deps.logger.log('Submitted successfully.');
  testRun.appendOutput(toCrlf(`\nSubmitted ${summary.total} test result(s) to Moodle.\n`));
  void vscode.window.showInformationMessage(
    `Submitted ${summary.total} test result(s) to Moodle (${summary.passed} passed).`,
  );
}

/** Runs one folder's tests, shows the results in the tree, and submits them when asked to. */
export async function runFolder(
  { context, controller, tree, deps }: RunEnv,
  { folder, submit, request, signal, report }: PerformRunOptions,
): Promise<void> {
  if (submit && !((await ensureConfigured(context)) && (await ensureAssignmentKey(folder)))) {
    return;
  }

  const testRun = controller.createTestRun(
    request ?? new vscode.TestRunRequest(),
    submit ? 'Run & Submit to Moodle' : 'Run Tests',
    true,
  );
  const abort = linkAbort(signal, testRun.token);
  const scope: RunScope = { folder, testRun, deps, report };

  try {
    if (submit) {
      report?.('Signing in…');
      await deps.authService.getAccessToken();
    }

    deps.status.running();
    report?.('Running tests…');
    const outcome = await runTests(deps.registry, folder.uri.fsPath, {
      logger: deps.logger,
      signal: abort.signal,
      onOutput: (chunk) => testRun.appendOutput(toCrlf(chunk)),
      pickFromMultiple: pickAdapter,
      preferredAdapterId: getPreferredAdapterId(folder.uri.fsPath),
      commandOverrides: getTestCommandOverrides(folder.uri.fsPath),
    });
    const { run, summary } = outcome;

    // Read and scanned once, for both the tree and the submission.
    const resolver = new TestLocationResolver(folder.uri.fsPath, run.platform);
    const located = await traceResults(scope, run, resolver);
    await applyResults(tree, testRun, folder, run, located ?? run.results.map(() => ({})), resolver);
    deps.status.result(summary);

    if (submit) {
      await submitResults(scope, outcome, located);
    } else {
      deps.logger.log('Run complete (not submitted).');
    }
  } catch (error) {
    testRun.appendOutput(toCrlf(`\n${describeError(error)}\n`));
    throw error;
  } finally {
    abort.dispose();
    testRun.end();
  }
}
