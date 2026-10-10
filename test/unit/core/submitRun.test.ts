import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { MissingAssignmentKeyError } from '../../../src/core/submissionMetadata';
import { submitRun } from '../../../src/core/submitRun';
import type { MoodleApiClient } from '../../../src/services/moodleApiClient';
import type { TestRunRequest } from '../../../src/services/httpTypes';
import { recordingLogger, testRun, writeWorkspaceConfig } from '../helpers/fakes';
import { tempDir } from '../helpers/fs';

const run = testRun([{ testSuite: 'test_calculator', testName: 'test_adds', status: 'PASSED', durationMs: 5 }]);

let folderPath: string;
let sent: TestRunRequest[];

function submit() {
  const apiClient = {
    async submitResults(payload: TestRunRequest) {
      sent.push(payload);
      return { status: 202, body: { ok: true } };
    },
  } as unknown as MoodleApiClient;
  return submitRun(run, { folderPath, projectName: 'my-project' }, { apiClient, logger: recordingLogger() });
}

beforeEach(async () => {
  folderPath = await tempDir();
  sent = [];
});

describe('submitRun', () => {
  it('submits a payload built from the workspace config file', async () => {
    await writeWorkspaceConfig(folderPath, { assignmentKey: 'assignment-101' });

    const response = await submit();

    expect(response.status).toBe(202);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      assignmentKey: 'assignment-101',
      ide: 'VSCODE',
      projectName: 'my-project',
      results: [{ testName: 'test_adds', status: 'PASSED' }],
    });
  });

  it('keeps the absolute project path out of failure messages', async () => {
    await writeWorkspaceConfig(folderPath, { assignmentKey: 'assignment-101' });
    const failing = testRun([
      { testName: 'reads', status: 'FAILED', message: `FileNotFoundException: ${join(folderPath, 'data', 'in.txt')}` },
    ]);
    const apiClient = {
      async submitResults(payload: TestRunRequest) {
        sent.push(payload);
        return { status: 202, body: {} };
      },
    } as unknown as MoodleApiClient;

    await submitRun(failing, { folderPath, projectName: 'p' }, { apiClient, logger: recordingLogger() });

    expect(sent[0].results[0].message).toBe(`FileNotFoundException: ${join('data', 'in.txt')}`);
  });

  it("uses the file's project name over the folder name", async () => {
    await writeWorkspaceConfig(folderPath, { assignmentKey: 'from-file', projectName: 'from-file-project' });

    await submit();

    expect(sent[0]).toMatchObject({ assignmentKey: 'from-file', projectName: 'from-file-project' });
  });

  it('ignores a commit and repository claimed by the config file', async () => {
    await writeWorkspaceConfig(folderPath, {
      assignmentKey: 'from-file',
      commitHash: 'forged',
      repoUrl: 'https://example.com/other',
    });

    await submit();

    expect(sent[0].commitHash).toBeUndefined();
    expect(sent[0].repoUrl).toBeUndefined();
  });

  it('refuses to submit with no assignment key configured anywhere', async () => {
    await expect(submit()).rejects.toBeInstanceOf(MissingAssignmentKeyError);
    expect(sent).toHaveLength(0);
  });
});
