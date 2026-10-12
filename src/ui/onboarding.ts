import * as vscode from 'vscode';
import { getServiceUrl } from '../config/settings';
import { serviceUrlProblem } from '../services/moodleApiClient';
import { COMMANDS } from '../commands/ids';

const WALKTHROUGH_ID = 'setup';
const NUDGE_DISMISSED_KEY = 'ideTestFeedback.onboardingDismissed';

export function isConfigured(): boolean {
  return getServiceUrl().trim().length > 0;
}

/**
 * Keeps the `ideTestFeedback.configured` context key in sync with settings so the
 * walkthrough's first step ticks itself off and `when` clauses can react.
 */
export function refreshConfiguredContext(): void {
  void vscode.commands.executeCommand('setContext', 'ideTestFeedback.configured', isConfigured());
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
    'IDE Test Feedback needs a one-time setup before you can submit results.',
    'Start setup',
    "Don't ask again",
  );

  if (choice === 'Start setup') {
    await openSetupWalkthrough(context);
  } else if (choice === "Don't ask again") {
    await context.globalState.update(NUDGE_DISMISSED_KEY, true);
  }
}

/**
 * Offers to finish setup before a submitting run, so it stops before the tests rather than after.
 * `false` means abort quietly, no error.
 */
export async function ensureConfigured(context: vscode.ExtensionContext): Promise<boolean> {
  const problem = serviceUrlProblem(getServiceUrl());
  if (!problem) return true;

  const pick = await vscode.window.showWarningMessage(
    isConfigured()
      ? `The Moodle submission service URL can't be used: ${problem}`
      : 'Set the Moodle submission service URL before submitting.',
    'Configure now',
    'Open setup',
  );

  if (pick === 'Configure now') {
    await vscode.commands.executeCommand(COMMANDS.configureAssignment);
  } else if (pick === 'Open setup') {
    await openSetupWalkthrough(context);
  }

  return serviceUrlProblem(getServiceUrl()) === undefined;
}
