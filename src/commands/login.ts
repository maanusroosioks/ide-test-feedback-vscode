import * as vscode from 'vscode';
import type { AuthService } from '../auth/authService';
import { CancelledError, describeError } from '../core/errors';

export function registerLoginCommand(context: vscode.ExtensionContext, authService: AuthService): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('moodleSubmit.login', async () => {
      try {
        await authService.login();
        void vscode.window.showInformationMessage('Signed in with Microsoft.');
      } catch (error) {
        if (error instanceof CancelledError) return;
        void vscode.window.showErrorMessage(`Sign-in failed: ${describeError(error)}`);
      }
    }),
  );
}
