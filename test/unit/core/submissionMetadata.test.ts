import { describe, expect, it } from 'vitest';
import {
  MissingAssignmentKeyError,
  normalizeRemoteUrl,
  resolveSubmissionMetadata,
} from '../../../src/core/submissionMetadata';

describe('resolveSubmissionMetadata', () => {
  it('prefers the workspace file over the settings fallback', () => {
    const metadata = resolveSubmissionMetadata({
      workspaceFile: { assignmentKey: 'from-file', projectName: 'file-project' },
      assignmentKeySetting: 'from-settings',
      defaultProjectName: 'default-project',
    });

    expect(metadata).toEqual({
      assignmentKey: 'from-file',
      projectName: 'file-project',
      commitHash: undefined,
      repoUrl: undefined,
    });
  });

  it('falls back to the settings value and derived defaults when no workspace file is present', () => {
    const metadata = resolveSubmissionMetadata({
      assignmentKeySetting: 'from-settings',
      defaultProjectName: 'default-project',
      gitCommitHash: 'abc123',
      gitRemoteUrl: 'https://github.com/org/repo',
    });

    expect(metadata).toEqual({
      assignmentKey: 'from-settings',
      projectName: 'default-project',
      commitHash: 'abc123',
      repoUrl: 'https://github.com/org/repo',
    });
  });

  it('throws MissingAssignmentKeyError when no assignmentKey is available anywhere', () => {
    expect(() => resolveSubmissionMetadata({})).toThrow(MissingAssignmentKeyError);
  });
});

describe('normalizeRemoteUrl', () => {
  it('converts the SCP-like SSH form to HTTPS', () => {
    expect(normalizeRemoteUrl('git@github.com:org/repo.git')).toBe('https://github.com/org/repo');
  });

  it('converts an explicit ssh:// remote to HTTPS', () => {
    expect(normalizeRemoteUrl('ssh://git@github.com/org/repo.git')).toBe('https://github.com/org/repo');
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
