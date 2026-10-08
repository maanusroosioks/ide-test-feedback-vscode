import * as vscode from 'vscode';
import type { TestRunnerAdapter } from '../runner/types';
import { CancelledError, MoodleSubmitError } from '../core/errors';

export class NoWorkspaceFolderError extends MoodleSubmitError {
  constructor() {
    super('Open a folder or workspace before running tests.');
  }
}

export async function resolveWorkspaceFolder(): Promise<vscode.WorkspaceFolder> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    throw new NoWorkspaceFolderError();
  }

  const activeFolder = vscode.window.activeTextEditor
    ? vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri)
    : undefined;
  if (activeFolder) {
    return activeFolder;
  }
  const picked = await pickWorkspaceFolder('Which folder holds the tests to run?');
  if (!picked) {
    throw new CancelledError();
  }
  return picked;
}

/** Asks only when there is more than one folder; `undefined` if there are none or the user backs out. */
export async function pickWorkspaceFolder(placeHolder: string): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length <= 1) {
    return folders[0];
  }
  const pick = await vscode.window.showQuickPick(
    folders.map((folder) => ({ label: folder.name, description: folder.uri.fsPath, folder })),
    { placeHolder },
  );
  return pick?.folder;
}

export async function pickAdapter(candidates: TestRunnerAdapter[]): Promise<TestRunnerAdapter> {
  const pick = await vscode.window.showQuickPick(
    candidates.map((candidate) => ({ label: candidate.displayName, adapter: candidate })),
    { placeHolder: 'Multiple test frameworks detected — choose one' },
  );
  if (!pick) {
    throw new CancelledError();
  }
  return pick.adapter;
}

