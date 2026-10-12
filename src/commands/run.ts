import * as vscode from 'vscode';
import { resolveWorkspaceFolder } from '../ui/workspacePicker';
import type { Logger, StatusReporter } from '../core/ports';
import type { MoodleTestControl } from '../ui/testController';
import { withProgress } from '../ui/progress';
import { handleCommandError } from '../ui/errorHandling';
import { COMMANDS } from './ids';

export interface RunCommandDeps {
  control: MoodleTestControl;
  logger: Logger;
  status: StatusReporter;
}

/** "Run & Submit" and "Run Tests Only": the same run, with and without the submission. */
export function registerRunCommands(context: vscode.ExtensionContext, deps: RunCommandDeps): void {
  context.subscriptions.push(
    registerRunCommand(COMMANDS.runAndSubmit, { submit: true }, deps),
    registerRunCommand(COMMANDS.runTestsOnly, { submit: false }, deps),
  );
}

function registerRunCommand(
  commandId: string,
  { submit }: { submit: boolean },
  { control, logger, status }: RunCommandDeps,
): vscode.Disposable {
  // `target` is the clicked item when invoked from the Testing view's context
  // menu; the palette and walkthrough pass nothing.
  return vscode.commands.registerCommand(commandId, async (target?: unknown) => {
    try {
      await withProgress('IDE Test Feedback', async (progress) => {
        const folder = control.folderFor(target) ?? (await resolveWorkspaceFolder());
        await control.performRun({
          folder,
          submit,
          signal: progress.signal,
          report: progress.report,
        });
      });
    } catch (error) {
      handleCommandError(error, logger, status);
    }
  });
}
