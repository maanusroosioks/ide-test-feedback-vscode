import * as vscode from 'vscode';
import { getOutputChannel } from '../ui/outputChannel';
import { COMMANDS } from './ids';

export function registerShowOutputCommand(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(COMMANDS.showOutput, () => {
      getOutputChannel().show();
    }),
  );
}
