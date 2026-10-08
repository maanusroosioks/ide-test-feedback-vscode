import * as vscode from 'vscode';
import type { AuthService } from '../auth/authService';
import { getRequestTimeoutMs, getServiceUrl, setServiceUrl } from '../config/settings';
import { WORKSPACE_CONFIG_FILE_NAME } from '../core/submissionMetadata';
import { serviceUrlProblem } from '../services/moodleApiClient';
import { promptAndSaveAssignmentKey } from '../ui/assignmentKey';
import { pickWorkspaceFolder } from '../ui/workspacePicker';

async function reportReachability(baseUrl: string): Promise<void> {
  const url = baseUrl.replace(/\/+$/, '');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.min(getRequestTimeoutMs(), 5000));
  try {
    await fetch(url, { method: 'HEAD', signal: controller.signal });
    void vscode.window.showInformationMessage(`Reached ${url}.`);
  } catch {
    void vscode.window.showWarningMessage(
      `Couldn't reach ${url}. Saved anyway — re-check the URL if submissions fail.`,
    );
  } finally {
    clearTimeout(timeout);
  }
}

export function registerConfigureAssignmentCommand(
  context: vscode.ExtensionContext,
  authService: AuthService,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('moodleSubmit.configureAssignment', async () => {
      const serviceUrl = await vscode.window.showInputBox({
        prompt: 'Moodle submission service URL',
        placeHolder: 'https://moodle-bridge.example.edu',
        value: getServiceUrl(),
        ignoreFocusOut: true,
        validateInput: serviceUrlProblem,
      });
      if (serviceUrl === undefined) {
        return;
      }
      const trimmedUrl = serviceUrl.trim();
      await setServiceUrl(trimmedUrl);
      await reportReachability(trimmedUrl);

      const folder = await pickWorkspaceFolder(
        `Which project's ${WORKSPACE_CONFIG_FILE_NAME} should get the assignment key?`,
      );
      const keySaved = folder ? await promptAndSaveAssignmentKey(folder) : false;

      if (!(await authService.isSignedIn())) {
        const choice = await vscode.window.showInformationMessage(
          'Sign in with Microsoft now to finish setup?',
          'Sign in',
          'Later',
        );
        if (choice === 'Sign in') {
          await vscode.commands.executeCommand('moodleSubmit.login');
        }
      }

      void vscode.window.showInformationMessage(
        keySaved
          ? 'Moodle Submit configuration saved.'
          : `Service URL saved. Add an assignment key to the project's ${WORKSPACE_CONFIG_FILE_NAME} before submitting.`,
      );
    }),
  );
}
