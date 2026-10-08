import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runCommand } from '../util/shell';
import { MoodleSubmitError } from './errors';

export const WORKSPACE_CONFIG_FILE_NAME = '.moodle-submit.json';

export interface SubmissionMetadata {
  assignmentKey: string;
  projectName?: string;
  commitHash?: string;
  repoUrl?: string;
}

export class MissingAssignmentKeyError extends MoodleSubmitError {
  constructor() {
    super(
      'No assignmentKey configured. Add one via the "Moodle Submit: Configure Assignment" command, ' +
        `or add a ${WORKSPACE_CONFIG_FILE_NAME} file to the project.`,
    );
  }
}

export class InvalidWorkspaceConfigError extends MoodleSubmitError {
  constructor(reason: string) {
    super(`${WORKSPACE_CONFIG_FILE_NAME} could not be read: ${reason}.`);
  }
}

/** The project's identity only: the commit and repository always come from git. */
export type WorkspaceConfigFile = Partial<Pick<SubmissionMetadata, 'assignmentKey' | 'projectName'>>;

export interface MetadataSources {
  workspaceFile?: WorkspaceConfigFile;
  defaultProjectName?: string;
  gitCommitHash?: string;
  gitRemoteUrl?: string;
}

export function resolveSubmissionMetadata(sources: MetadataSources): SubmissionMetadata {
  const assignmentKey = sources.workspaceFile?.assignmentKey;
  if (!assignmentKey) {
    throw new MissingAssignmentKeyError();
  }

  return {
    assignmentKey,
    projectName: sources.workspaceFile?.projectName ?? sources.defaultProjectName,
    // A student-edited file could otherwise claim any commit or repository.
    commitHash: sources.gitCommitHash,
    repoUrl: sources.gitRemoteUrl,
  };
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

export async function readGitCommitHash(folderPath: string): Promise<string | undefined> {
  const { exitCode, stdout } = await runCommand('git rev-parse HEAD', { cwd: folderPath });
  if (exitCode !== 0) {
    return undefined;
  }
  const commitHash = stdout.trim();
  return commitHash.length > 0 ? commitHash : undefined;
}

/** SCP-like syntax, `git@host:owner/repo.git`. An explicit `ssh://` URL is parsed as a URL instead. */
const SCP_LIKE_URL = /^[^@/\s]+@([^:/\s]+):(.+?)(?:\.git)?\/?$/;

function repoPath(pathname: string): string {
  return pathname.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '');
}

/** Azure DevOps SSH hosts, current and legacy, whose `v3/org/project/repo` path isn't a web URL. */
const AZURE_SSH_HOSTS = new Set(['ssh.dev.azure.com', 'vs-ssh.visualstudio.com']);
const AZURE_SSH_PATH = /^v3\/([^/]+)\/([^/]+)\/([^/]+)$/;

function scpToHttps(host: string, path: string): string {
  const azure = AZURE_SSH_HOSTS.has(host.toLowerCase()) ? AZURE_SSH_PATH.exec(path) : null;
  if (azure) {
    const [, org, project, repo] = azure;
    return `https://dev.azure.com/${org}/${project}/_git/${repo}`;
  }
  return `https://${host}/${path}`;
}

/**
 * Turns a git remote into a browsable HTTPS URL, or drops it. Strips credentials, as in the
 * `https://user:token@host/...` remotes of CI-style clones, since the URL is submitted.
 */
export function normalizeRemoteUrl(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  const scpMatch = SCP_LIKE_URL.exec(trimmed);
  if (scpMatch) {
    const [, host, path] = scpMatch;
    return scpToHttps(host, path);
  }

  try {
    const url = new URL(trimmed);
    // `hostname`, not `host`: an SSH port (`ssh://git@host:2222/...`) is no part of the web URL.
    if (url.protocol === 'ssh:') return scpToHttps(url.hostname, repoPath(url.pathname));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return `https://${url.host}${url.pathname.replace(/\.git\/?$/, '')}`;
  } catch {
    return undefined;
  }
}

export async function readGitRemoteUrl(folderPath: string): Promise<string | undefined> {
  const { exitCode, stdout } = await runCommand('git remote get-url origin', { cwd: folderPath });
  if (exitCode !== 0) {
    return undefined;
  }
  return normalizeRemoteUrl(stdout.trim());
}
