import * as vscode from 'vscode';
import { CancelledError } from '../core/errors';
import { resolveWorkspaceFolder } from './workspacePicker';
import { handleCommandError } from './errorHandling';
import { TestItemTree } from './testItemTree';
import { registerTestDiscovery } from './testDiscovery';
import { runFolder, type PerformRunOptions, type RunDeps } from './runFolder';

export interface MoodleTestControl {
  performRun(options: PerformRunOptions): Promise<void>;
  folderFor(target: unknown): vscode.WorkspaceFolder | undefined;
}

function asTestItem(target: unknown): vscode.TestItem | undefined {
  if (typeof target !== 'object' || target === null) return undefined;
  const candidate = target as Partial<vscode.TestItem>;
  return typeof candidate.id === 'string' && candidate.children !== undefined
    ? (candidate as vscode.TestItem)
    : undefined;
}

export function registerTestController(context: vscode.ExtensionContext, deps: RunDeps): MoodleTestControl {
  const controller = vscode.tests.createTestController('ideTestFeedback.tests', 'IDE Test Feedback');
  context.subscriptions.push(controller);

  const tree = new TestItemTree(controller);
  registerTestDiscovery(context, controller, tree, deps);

  const env = { context, controller, tree, deps };
  const inFlight = new Set<string>();

  async function performRun(options: PerformRunOptions): Promise<void> {
    const { folder } = options;
    // A second build in the same folder would clear the first one's reports mid-run.
    if (inFlight.has(folder.uri.fsPath)) {
      void vscode.window.showInformationMessage(`Tests are already running in "${folder.name}".`);
      return;
    }
    inFlight.add(folder.uri.fsPath);
    try {
      await runFolder(env, options);
    } finally {
      inFlight.delete(folder.uri.fsPath);
    }
  }

  // One profile: submitting is the separate runAndSubmit command. Each folder's run shares the
  // request's cancellation and performRun listens on that; the handler token only stops the loop.
  const runHandler = async (request: vscode.TestRunRequest, token?: vscode.CancellationToken): Promise<void> => {
    let folders: vscode.WorkspaceFolder[];
    try {
      folders = await foldersForRequest(request);
    } catch (error) {
      handleCommandError(error, deps.logger, deps.status);
      return;
    }
    // One folder failing to build shouldn't keep the others from running.
    for (const folder of folders) {
      if (token?.isCancellationRequested) return;
      try {
        await performRun({ folder, submit: false, request });
      } catch (error) {
        handleCommandError(error, deps.logger, deps.status);
        if (error instanceof CancelledError) return;
      }
    }
  };

  controller.createRunProfile('Run Tests', vscode.TestRunProfileKind.Run, runHandler, true);

  /** Each folder the selection touches, once; with no selection, the active or picked one. */
  async function foldersForRequest(request: vscode.TestRunRequest): Promise<vscode.WorkspaceFolder[]> {
    const included = new Map<string, vscode.WorkspaceFolder>();
    for (const item of request.include ?? []) {
      const folder = tree.folderOf(item);
      if (folder) included.set(folder.uri.fsPath, folder);
    }
    return included.size > 0 ? [...included.values()] : [await resolveWorkspaceFolder()];
  }

  function folderFor(target: unknown): vscode.WorkspaceFolder | undefined {
    const item = asTestItem(target);
    return item ? tree.folderOf(item) : undefined;
  }

  return { performRun, folderFor };
}
