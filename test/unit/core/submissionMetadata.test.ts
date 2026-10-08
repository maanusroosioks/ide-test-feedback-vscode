import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  InvalidWorkspaceConfigError,
  MissingAssignmentKeyError,
  WORKSPACE_CONFIG_FILE_NAME,
  normalizeRemoteUrl,
  readWorkspaceConfigFile,
  resolveSubmissionMetadata,
  writeWorkspaceAssignmentKey,
} from '../../../src/core/submissionMetadata';
import { tempDir } from '../helpers/fs';

describe('resolveSubmissionMetadata', () => {
  it('takes the key and project name from the workspace file, and the rest from git', () => {
    const metadata = resolveSubmissionMetadata({
      workspaceFile: { assignmentKey: 'from-file', projectName: 'file-project' },
      defaultProjectName: 'default-project',
      gitCommitHash: 'abc123',
      gitRemoteUrl: 'https://github.com/org/repo',
    });

    expect(metadata).toEqual({
      assignmentKey: 'from-file',
      projectName: 'file-project',
      commitHash: 'abc123',
      repoUrl: 'https://github.com/org/repo',
    });
  });

  it('falls back to the folder name when the file names no project', () => {
    const metadata = resolveSubmissionMetadata({
      workspaceFile: { assignmentKey: 'from-file' },
      defaultProjectName: 'default-project',
    });

    expect(metadata.projectName).toBe('default-project');
  });

  it.each([undefined, {}])('throws MissingAssignmentKeyError when the file has no key (%o)', (workspaceFile) => {
    expect(() => resolveSubmissionMetadata({ workspaceFile })).toThrow(MissingAssignmentKeyError);
  });
});

describe('workspace config file', () => {
  async function folderWith(content?: string): Promise<{ folderPath: string; target: string }> {
    const folderPath = await tempDir();
    const target = join(folderPath, WORKSPACE_CONFIG_FILE_NAME);
    if (content !== undefined) await writeFile(target, content, 'utf8');
    return { folderPath, target };
  }

  it('reads only the assignment key and project name', async () => {
    const { folderPath } = await folderWith(
      '{"assignmentKey":"a-1","projectName":"p","commitHash":"forged","repoUrl":"https://example.com/x"}',
    );

    expect(await readWorkspaceConfigFile(folderPath)).toEqual({ assignmentKey: 'a-1', projectName: 'p' });
  });

  it('reads a file saved with a byte-order mark, as Windows PowerShell writes it', async () => {
    const { folderPath } = await folderWith(`${String.fromCharCode(0xfeff)}{"assignmentKey":"a-1"}`);

    expect(await readWorkspaceConfigFile(folderPath)).toEqual({ assignmentKey: 'a-1' });
  });

  it('is undefined when the file does not exist', async () => {
    const { folderPath } = await folderWith();
    expect(await readWorkspaceConfigFile(folderPath)).toBeUndefined();
  });

  it.each(['{ not json', '[]', '"key"'])('rejects %s', async (content) => {
    const { folderPath } = await folderWith(content);
    await expect(readWorkspaceConfigFile(folderPath)).rejects.toBeInstanceOf(InvalidWorkspaceConfigError);
  });

  it('writes a new file with just the key', async () => {
    const { folderPath, target } = await folderWith();

    await writeWorkspaceAssignmentKey(folderPath, 'a-1');

    expect(await readFile(target, 'utf8')).toBe('{\n  "assignmentKey": "a-1"\n}\n');
  });

  it('replaces the key in an existing file and keeps its other fields', async () => {
    const { folderPath, target } = await folderWith('{"assignmentKey":"old","projectName":"p"}');

    await writeWorkspaceAssignmentKey(folderPath, 'new');

    expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({ assignmentKey: 'new', projectName: 'p' });
  });

  it('refuses to overwrite a file it cannot parse', async () => {
    const { folderPath, target } = await folderWith('{ not json');

    await expect(writeWorkspaceAssignmentKey(folderPath, 'a-1')).rejects.toBeInstanceOf(InvalidWorkspaceConfigError);
    expect(await readFile(target, 'utf8')).toBe('{ not json');
  });
});

describe('normalizeRemoteUrl', () => {
  it('converts the SCP-like SSH form to HTTPS', () => {
    expect(normalizeRemoteUrl('git@github.com:org/repo.git')).toBe('https://github.com/org/repo');
  });

  it('converts an explicit ssh:// remote to HTTPS', () => {
    expect(normalizeRemoteUrl('ssh://git@github.com/org/repo.git')).toBe('https://github.com/org/repo');
  });

  it('drops the SSH port, which is no part of the web URL', () => {
    expect(normalizeRemoteUrl('ssh://git@gitlab.example.edu:2222/group/repo.git')).toBe(
      'https://gitlab.example.edu/group/repo',
    );
  });

  it.each([
    ['git@ssh.dev.azure.com:v3/org/My%20Project/repo'],
    ['ssh://git@ssh.dev.azure.com/v3/org/My%20Project/repo'],
    ['org@vs-ssh.visualstudio.com:v3/org/My%20Project/repo'],
  ])('maps the Azure DevOps SSH remote %s to its web URL', (remote) => {
    expect(normalizeRemoteUrl(remote)).toBe('https://dev.azure.com/org/My%20Project/_git/repo');
  });

  it('keeps an Azure DevOps HTTPS remote, minus the username', () => {
    expect(normalizeRemoteUrl('https://org@dev.azure.com/org/project/_git/repo')).toBe(
      'https://dev.azure.com/org/project/_git/repo',
    );
  });

  it('strips embedded credentials from an HTTPS remote', () => {
    expect(normalizeRemoteUrl('https://user:token@github.com/org/repo.git')).toBe(
      'https://github.com/org/repo',
    );
  });

  it('upgrades a plain http remote to https', () => {
    expect(normalizeRemoteUrl('http://github.com/org/repo')).toBe('https://github.com/org/repo');
  });

  it('drops a local file path remote', () => {
    expect(normalizeRemoteUrl('/home/student/other-clone')).toBeUndefined();
  });

  it('drops a blank remote', () => {
    expect(normalizeRemoteUrl('  ')).toBeUndefined();
  });
});
