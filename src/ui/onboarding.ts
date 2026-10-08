import * as vscode from 'vscode';
import { getServiceUrl } from '../config/settings';
import { serviceUrlProblem } from '../services/moodleApiClient';

const WALKTHROUGH_ID = 'setup';
const NUDGE_DISMISSED_KEY = 'moodleSubmit.onboardingDismissed';

export function isConfigured(): boolean {
  return getServiceUrl().trim().length > 0;
}

/**
 * Keeps the `moodleSubmit.configured` context key in sync with settings so the
 * walkthrough's first step ticks itself off and `when` clauses can react.
 */
export function refreshConfiguredContext(): void {
  void vscode.commands.executeCommand('setContext', 'moodleSubmit.configured', isConfigured());
}

export async function openSetupWalkthrough(context: vscode.ExtensionContext): Promise<void> {
  await vscode.commands.executeCommand(
    'workbench.action.openWalkthrough',
    `${context.extension.id}#${WALKTHROUGH_ID}`,
    false,
  );
}

/** One-time nudge on startup; silent once configured or dismissed. */
export async function maybePromptOnboarding(context: vscode.ExtensionContext): Promise<void> {
  if (isConfigured()) return;
  if (context.globalState.get<boolean>(NUDGE_DISMISSED_KEY)) return;

  const choice = await vscode.window.showInformationMessage(
    'Moodle Test Submit needs a one-time setup before you can submit results.',
    'Start setup',
    "Don't ask again",
  );

  if (choice === 'Start setup') {
    await openSetupWalkthrough(context);
  } else if (choice === "Don't ask again") {
    await context.globalState.update(NUDGE_DISMISSED_KEY, true);
  }
}

/** Why the configured URL can't be submitted to, so a submitting run can stop before the tests rather than after. */
function configuredUrlProblem(): string | undefined {
  return isConfigured() ? serviceUrlProblem(getServiceUrl()) : undefined;
}

/** Offers to finish setup before a submitting run. `false` means abort quietly, no error. */
export async function ensureConfigured(context: vscode.ExtensionContext): Promise<boolean> {
  const problem = configuredUrlProblem();
  if (isConfigured() && !problem) return true;

  const pick = await vscode.window.showWarningMessage(
    problem
      ? `The Moodle submission service URL can't be used: ${problem}`
      : 'Set the Moodle submission service URL before submitting.',
    'Configure now',
    'Open setup',
  );

  if (pick === 'Configure now') {
    await vscode.commands.executeCommand('moodleSubmit.configureAssignment');
  } else if (pick === 'Open setup') {
    await openSetupWalkthrough(context);
  }

  return isConfigured() && !configuredUrlProblem();
}
