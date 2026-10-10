import { runCommand } from '../util/shell';

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
