import * as vscode from 'vscode';
import type { AuthService } from '../auth/authService';
import { CancelledError, describeError } from '../core/errors';
import { COMMANDS } from './ids';

export function registerAccountCommands(context: vscode.ExtensionContext, authService: AuthService): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(COMMANDS.login, async () => {
      try {
        await authService.login();
        void vscode.window.showInformationMessage('Signed in with Microsoft.');
      } catch (error) {
        if (error instanceof CancelledError) return;
        void vscode.window.showErrorMessage(`Sign-in failed: ${describeError(error)}`);
      }
    }),

    // An extension can't end an authentication session; only the user can, from the Accounts menu.
    vscode.commands.registerCommand(COMMANDS.logout, async () => {
      await vscode.window.showInformationMessage(
        'To sign out, open the Accounts menu (bottom-left of VS Code) and remove the Microsoft account used for Moodle Submit.',
      );
    }),
  );
}
