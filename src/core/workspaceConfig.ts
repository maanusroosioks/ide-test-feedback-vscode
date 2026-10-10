import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MoodleSubmitError } from './errors';

export const WORKSPACE_CONFIG_FILE_NAME = '.moodle-submit.json';

export class InvalidWorkspaceConfigError extends MoodleSubmitError {
  constructor(reason: string) {
    super(`${WORKSPACE_CONFIG_FILE_NAME} could not be read: ${reason}.`);
  }
}

/** The project's identity only: the commit and repository always come from git. */
export interface WorkspaceConfigFile {
  assignmentKey?: string;
  projectName?: string;
}

/** Trimmed: stray spaces in a hand-edited file would otherwise fail validation only at submit time. */
function optionalString(value: unknown): string | undefined {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || undefined;
}

/** `undefined` when the file doesn't exist; throws when it exists but isn't a JSON object. */
async function readConfigRecord(folderPath: string): Promise<Record<string, unknown> | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(folderPath, WORKSPACE_CONFIG_FILE_NAME), 'utf8');
  } catch {
    return undefined;
  }

  let parsed: unknown;
  try {
    // Windows PowerShell's `-Encoding utf8` and some editors write a BOM, which JSON.parse rejects.
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch {
    throw new InvalidWorkspaceConfigError('it is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new InvalidWorkspaceConfigError('the top level must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

export async function readWorkspaceConfigFile(folderPath: string): Promise<WorkspaceConfigFile | undefined> {
  const record = await readConfigRecord(folderPath);
  if (!record) return undefined;
  return {
    assignmentKey: optionalString(record.assignmentKey),
    projectName: optionalString(record.projectName),
  };
}

/** Creates the file, or sets the key in an existing one while keeping its other fields. */
export async function writeWorkspaceAssignmentKey(folderPath: string, assignmentKey: string): Promise<void> {
  const record = (await readConfigRecord(folderPath)) ?? {};
  const body = `${JSON.stringify({ ...record, assignmentKey }, null, 2)}\n`;
  await writeFile(join(folderPath, WORKSPACE_CONFIG_FILE_NAME), body, 'utf8');
}
