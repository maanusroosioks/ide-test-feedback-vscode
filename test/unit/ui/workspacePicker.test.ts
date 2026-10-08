import { describe, expect, it } from 'vitest';
import { MoodleSubmitError } from '../../../src/core/errors';
import {
  NoWorkspaceFolderError,
  pickAdapter,
  pickWorkspaceFolder,
  resolveWorkspaceFolder,
} from '../../../src/ui/workspacePicker';
import { stubAdapter } from '../helpers/fakes';
import { Uri, window, workspace, workspaceFolder } from '../helpers/vscodeStub';

const api = workspaceFolder('/work/api', 'api', 0);
const web = workspaceFolder('/work/web', 'web', 1);

type FolderPick = { label: string; description: string; folder: typeof api };

describe('pickWorkspaceFolder', () => {
  it('returns undefined when no folder is open', async () => {
    expect(await pickWorkspaceFolder('Which?')).toBeUndefined();
    expect(window.showQuickPick).not.toHaveBeenCalled();
  });

  it('returns the only folder without asking', async () => {
    workspace.workspaceFolders = [api];

    expect(await pickWorkspaceFolder('Which?')).toBe(api);
    expect(window.showQuickPick).not.toHaveBeenCalled();
  });

  it('asks when there are several folders', async () => {
    workspace.workspaceFolders = [api, web];
    window.showQuickPick.mockImplementationOnce(async (items) => (items as FolderPick[])[1]);

    expect(await pickWorkspaceFolder('Which?')).toBe(web);
    const [items, options] = window.showQuickPick.mock.calls[0];
    expect(items).toEqual([
      { label: 'api', description: '/work/api', folder: api },
      { label: 'web', description: '/work/web', folder: web },
    ]);
    expect(options).toEqual({ placeHolder: 'Which?' });
  });

  it('returns undefined when the user backs out', async () => {
    workspace.workspaceFolders = [api, web];

    expect(await pickWorkspaceFolder('Which?')).toBeUndefined();
  });
});

describe('resolveWorkspaceFolder', () => {
  it('fails when no folder is open', async () => {
    await expect(resolveWorkspaceFolder()).rejects.toBeInstanceOf(NoWorkspaceFolderError);
  });

  it("uses the active editor's folder without asking", async () => {
    workspace.workspaceFolders = [api, web];
    const uri = Uri.file('/work/web/tests/test_app.py');
    window.activeTextEditor = { document: { uri } };
    workspace.getWorkspaceFolder.mockReturnValueOnce(web);

    expect(await resolveWorkspaceFolder()).toBe(web);
    expect(workspace.getWorkspaceFolder).toHaveBeenCalledWith(uri);
    expect(window.showQuickPick).not.toHaveBeenCalled();
  });

  it('asks when the active editor is outside every folder', async () => {
    workspace.workspaceFolders = [api, web];
    window.activeTextEditor = { document: { uri: Uri.file('/elsewhere/notes.md') } };
    window.showQuickPick.mockImplementationOnce(async (items) => (items as FolderPick[])[0]);

    expect(await resolveWorkspaceFolder()).toBe(api);
  });

  it('uses the single folder when no editor is open', async () => {
    workspace.workspaceFolders = [api];

    expect(await resolveWorkspaceFolder()).toBe(api);
  });

  it('fails when the user dismisses the folder picker', async () => {
    workspace.workspaceFolders = [api, web];

    await expect(resolveWorkspaceFolder()).rejects.toBeInstanceOf(NoWorkspaceFolderError);
  });
});

describe('pickAdapter', () => {
  const adapter = (id: string) => stubAdapter(id, { displayName: `Display ${id}` });

  it('offers each candidate by display name and returns the chosen one', async () => {
    const maven = adapter('maven');
    const gradle = adapter('gradle');
    window.showQuickPick.mockImplementationOnce(async (items) => (items as { adapter: unknown }[])[1]);

    expect(await pickAdapter([maven, gradle])).toBe(gradle);
    expect(window.showQuickPick.mock.calls[0][0]).toEqual([
      { label: 'Display maven', adapter: maven },
      { label: 'Display gradle', adapter: gradle },
    ]);
  });

  it('fails when the user picks nothing', async () => {
    await expect(pickAdapter([adapter('a'), adapter('b')])).rejects.toThrow(
      new MoodleSubmitError('No test adapter selected.'),
    );
  });
});
