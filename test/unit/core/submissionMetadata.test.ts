import { describe, expect, it } from 'vitest';
import { MissingAssignmentKeyError, resolveSubmissionMetadata } from '../../../src/core/submissionMetadata';

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
