import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  InvalidWorkspaceConfigError,
  WORKSPACE_CONFIG_FILE_NAME,
  readWorkspaceConfigFile,
  writeWorkspaceAssignmentKey,
} from '../../../src/core/workspaceConfig';
import { tempDir } from '../helpers/fs';

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
