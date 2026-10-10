import { describe, expect, it, vi } from 'vitest';
import { COMMANDS } from '../../../src/commands/ids';
import { registerRunCommands } from '../../../src/commands/run';
import { CancelledError, MoodleSubmitError } from '../../../src/core/errors';
import type { PerformRunOptions } from '../../../src/ui/runFolder';
import type { MoodleTestControl } from '../../../src/ui/testController';
import { fakeStatus, recordingLogger } from '../helpers/fakes';
import {
  asContext,
  fakeExtensionContext,
  invokeCommand,
  progress,
  window,
  workspace,
  workspaceFolder,
} from '../helpers/vscodeStub';

const COMMAND = COMMANDS.runAndSubmit;
const folder = workspaceFolder('/work/calculator', 'calculator');

function setup() {
  const control = {
    folderFor: vi.fn<MoodleTestControl['folderFor']>(() => undefined),
    performRun: vi.fn<MoodleTestControl['performRun']>(async () => {}),
  };
  const status = fakeStatus();
  const logger = recordingLogger();
  const context = fakeExtensionContext();
  registerRunCommands(asContext(context), { control, logger, status });
  return { control, status, logger, context };
}

function runOptions(control: ReturnType<typeof setup>['control']): PerformRunOptions {
  return control.performRun.mock.calls[0][0];
}

describe('run command', () => {
  it('registers the submitting and the run-only command', () => {
    const { context } = setup();

    expect(context.subscriptions).toHaveLength(2);
  });

  it('runs the folder of the Testing view item it was invoked on', async () => {
    const { control } = setup();
    const target = { id: 'item', children: {} };
    control.folderFor.mockReturnValue(folder);

    await invokeCommand(COMMAND, target);

    expect(control.folderFor).toHaveBeenCalledWith(target);
    expect(runOptions(control).folder).toBe(folder);
  });

  it('falls back to the workspace folder when invoked from the palette', async () => {
    const { control } = setup();
    workspace.workspaceFolders = [folder];

    await invokeCommand(COMMAND);

    expect(runOptions(control).folder).toBe(folder);
  });

  it.each([
    [COMMANDS.runAndSubmit, true],
    [COMMANDS.runTestsOnly, false],
  ])('%s passes submit=%s through', async (command, submit) => {
    const { control } = setup();
    workspace.workspaceFolders = [folder];

    await invokeCommand(command);

    expect(runOptions(control).submit).toBe(submit);
  });

  it('runs inside a cancellable progress notification', async () => {
    const { control } = setup();
    workspace.workspaceFolders = [folder];
    let abortedOnCancel: boolean | undefined;
    control.performRun.mockImplementation(async ({ report, signal }) => {
      report?.('Running tests…');
      progress.cancel();
      abortedOnCancel = signal?.aborted;
    });

    await invokeCommand(COMMAND);

    expect(window.withProgress).toHaveBeenCalledOnce();
    expect(progress.report).toHaveBeenCalledWith({ message: 'Running tests…' });
    expect(abortedOnCancel).toBe(true);
  });

  it('reports failures instead of throwing out of the command', async () => {
    const { control, status } = setup();
    workspace.workspaceFolders = [folder];
    control.performRun.mockRejectedValue(new MoodleSubmitError('No test adapter detected.'));

    await expect(invokeCommand(COMMAND)).resolves.toBeUndefined();

    expect(status.error).toHaveBeenCalledWith('No test adapter detected.');
    expect(window.showErrorMessage).toHaveBeenCalledWith('No test adapter detected.', 'Show Output');
  });

  it('reports a missing workspace folder', async () => {
    const { control, status } = setup();

    await invokeCommand(COMMAND);

    expect(control.performRun).not.toHaveBeenCalled();
    expect(status.error).toHaveBeenCalledWith('Open a folder or workspace before running tests.');
  });

  it('treats cancellation as a return to idle, not an error', async () => {
    const { control, status } = setup();
    workspace.workspaceFolders = [folder];
    control.performRun.mockRejectedValue(new CancelledError());

    await invokeCommand(COMMAND);

    expect(status.idle).toHaveBeenCalledOnce();
    expect(window.showErrorMessage).not.toHaveBeenCalled();
  });
});
