import { homedir } from 'node:os';
import type { MoodleApiClient, SubmitResult } from '../services/moodleApiClient';
import type { Logger } from './ports';
import { buildTestRunRequest } from './payload';
import { readGitCommitHash, readGitRemoteUrl } from './git';
import { resolveSubmissionMetadata } from './submissionMetadata';
import { readWorkspaceConfigFile } from './workspaceConfig';
import type { TestEvidencePayload } from '../capture/evidence';
import type { NormalizedTestRun } from './types';

export interface SubmitRunContext {
  folderPath: string;
  projectName: string;
  /** Absent when source capture was skipped or failed — submission goes ahead either way. */
  evidence?: TestEvidencePayload;
}

export interface SubmitRunDeps {
  apiClient: MoodleApiClient;
  logger: Logger;
}

export async function submitRun(
  run: NormalizedTestRun,
  { folderPath, projectName, evidence }: SubmitRunContext,
  { apiClient, logger }: SubmitRunDeps,
): Promise<SubmitResult> {
  const workspaceFile = await readWorkspaceConfigFile(folderPath);
  const [gitCommitHash, gitRemoteUrl] = await Promise.all([
    readGitCommitHash(folderPath),
    readGitRemoteUrl(folderPath),
  ]);
  const metadata = resolveSubmissionMetadata({
    workspaceFile,
    defaultProjectName: projectName,
    gitCommitHash,
    gitRemoteUrl,
  });

  const payload = buildTestRunRequest(run, metadata, evidence, { workspace: folderPath, home: homedir() });
  const response = await apiClient.submitResults(payload);
  logger.log(`Submission service responded ${response.status}: ${JSON.stringify(response.body)}`);
  return response;
}
