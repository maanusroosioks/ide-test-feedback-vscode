import { MoodleSubmitError } from './errors';
import { WORKSPACE_CONFIG_FILE_NAME, type WorkspaceConfigFile } from './workspaceConfig';

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
