import * as vscode from 'vscode';
import { describeError } from '../core/errors';
import {
  readWorkspaceConfigFile,
  WORKSPACE_CONFIG_FILE_NAME,
  writeWorkspaceAssignmentKey,
} from '../core/submissionMetadata';
import { assignmentKeyProblem } from '../services/httpTypes';

/**
 * Asks for the folder's key and saves it to its `.moodle-submit.json`. `false` if the user backed
 * out or the file could not be written.
 */
export async function promptAndSaveAssignmentKey(folder: vscode.WorkspaceFolder): Promise<boolean> {
  try {
    const saved = (await readWorkspaceConfigFile(folder.uri.fsPath))?.assignmentKey;
    const entered = await vscode.window.showInputBox({
      prompt: `Assignment key for "${folder.name}" (saved to its ${WORKSPACE_CONFIG_FILE_NAME})`,
      value: saved ?? '',
      ignoreFocusOut: true,
      validateInput: (value) => assignmentKeyProblem(value.trim()),
    });
    if (entered === undefined) return false;

    const assignmentKey = entered.trim();
    // Rewriting an unchanged key would only reformat a file the student may have laid out by hand.
    if (assignmentKey !== saved) {
      await writeWorkspaceAssignmentKey(folder.uri.fsPath, assignmentKey);
    }
    return true;
  } catch (error) {
    void vscode.window.showWarningMessage(
      `Could not save the assignment key for "${folder.name}": ${describeError(error)}`,
    );
    return false;
  }
}

/**
 * Just-in-time guard before a submitting run, so a missing key is caught before the tests run
 * rather than after. `false` means the user backed out — abort quietly, no error.
 */
export async function ensureAssignmentKey(folder: vscode.WorkspaceFolder): Promise<boolean> {
  const file = await readWorkspaceConfigFile(folder.uri.fsPath);
  if (file?.assignmentKey) return true;

  const pick = await vscode.window.showWarningMessage(
    `"${folder.name}" has no assignment key. Add one to its ${WORKSPACE_CONFIG_FILE_NAME}?`,
    'Add key',
  );
  return pick === 'Add key' && (await promptAndSaveAssignmentKey(folder));
}
