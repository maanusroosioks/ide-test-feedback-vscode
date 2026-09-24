import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runCommand } from '../util/shell';
import { MoodleSubmitError } from './errors';

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
        'a .moodle-submit.json file in the workspace, or the moodleSubmit.assignmentKey setting.',
    );
  }
}

export class InvalidWorkspaceConfigError extends MoodleSubmitError {
  constructor(reason: string) {
    super(`${WORKSPACE_CONFIG_FILE_NAME} could not be read: ${reason}.`);
  }
}

export interface WorkspaceConfigFile {
  assignmentKey?: string;
  projectName?: string;
  commitHash?: string;
  repoUrl?: string;
}

export interface MetadataSources {
  workspaceFile?: WorkspaceConfigFile;
  assignmentKeySetting?: string;
  defaultProjectName?: string;
  gitCommitHash?: string;
  gitRemoteUrl?: string;
}

export function resolveSubmissionMetadata(sources: MetadataSources): SubmissionMetadata {
  const assignmentKey = sources.workspaceFile?.assignmentKey ?? sources.assignmentKeySetting;
  if (!assignmentKey) {
    throw new MissingAssignmentKeyError();
  }

  return {
    assignmentKey,
    projectName: sources.workspaceFile?.projectName ?? sources.defaultProjectName,
    commitHash: sources.workspaceFile?.commitHash ?? sources.gitCommitHash,
    repoUrl: sources.workspaceFile?.repoUrl ?? sources.gitRemoteUrl,
  };
}

const WORKSPACE_CONFIG_FILE_NAME = '.moodle-submit.json';

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export async function readWorkspaceConfigFile(folderPath: string): Promise<WorkspaceConfigFile | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(folderPath, WORKSPACE_CONFIG_FILE_NAME), 'utf8');
  } catch {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new InvalidWorkspaceConfigError('it is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new InvalidWorkspaceConfigError('the top level must be a JSON object');
  }

  const record = parsed as Record<string, unknown>;
  return {
    assignmentKey: optionalString(record.assignmentKey),
    projectName: optionalString(record.projectName),
    commitHash: optionalString(record.commitHash),
    repoUrl: optionalString(record.repoUrl),
  };
}

export async function readGitCommitHash(folderPath: string): Promise<string | undefined> {
  const { exitCode, stdout } = await runCommand('git rev-parse HEAD', { cwd: folderPath });
  if (exitCode !== 0) {
    return undefined;
  }
  const commitHash = stdout.trim();
  return commitHash.length > 0 ? commitHash : undefined;
}

/** SCP-like syntax (`git@host:owner/repo.git`), with or without an explicit `ssh://`. */
const SCP_LIKE_URL = /^(?:ssh:\/\/)?[^@/\s]+@([^:/\s]+)[:/](.+?)(?:\.git)?\/?$/;

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
 * Turns a git remote into a browsable HTTPS URL, or drops it. Strips embedded credentials (a
 * `https://user:token@host/...` remote is common in CI-style clones) since this goes into a
 * submission payload, not just a local config.
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
