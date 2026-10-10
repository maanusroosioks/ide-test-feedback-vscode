import * as vscode from 'vscode';
import { CancelledError, describeError } from '../core/errors';
import type { Logger, StatusReporter } from '../core/ports';
import { COMMANDS } from '../commands/ids';

export function handleCommandError(error: unknown, logger: Logger, status: StatusReporter): void {
  if (error instanceof CancelledError) {
    logger.log(error.message);
    status.idle();
    return;
  }

  const message = describeError(error);
  logger.log(`Error: ${message}`);
  status.error(message);
  void vscode.window.showErrorMessage(message, 'Show Output').then((choice) => {
    if (choice === 'Show Output') {
      void vscode.commands.executeCommand(COMMANDS.showOutput);
    }
  });
}
