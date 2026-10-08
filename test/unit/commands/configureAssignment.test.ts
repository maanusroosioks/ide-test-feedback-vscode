import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { AuthService } from '../../../src/auth/authService';
import { registerConfigureAssignmentCommand } from '../../../src/commands/configureAssignment';
import { WORKSPACE_CONFIG_FILE_NAME } from '../../../src/core/submissionMetadata';
import { pathExists } from '../../../src/util/shell';
import { tempDir } from '../helpers/fs';
import {
  ConfigurationTarget,
  asContext,
  commands,
  configUpdate,
  configValues,
  fakeExtensionContext,
  invokeCommand,
  window,
  workspace,
  workspaceFolder,
} from '../helpers/vscodeStub';

const COMMAND = 'moodleSubmit.configureAssignment';

type Validator = (value: string) => string | undefined;
type InputBoxOptions = { value?: string; validateInput: Validator };

/** Answers each message by the first key its text contains; anything else is dismissed. */
function answerMessages(mock: Mock, answers: Record<string, string>): void {
  mock.mockImplementation(async (message: unknown) => {
    const match = Object.keys(answers).find((key) => String(message).includes(key));
    return match ? answers[match] : undefined;
  });
}

function messagesShown(mock: Mock): string[] {
  return mock.mock.calls.map((call) => String(call[0]));
}

function inputBoxOptions(index: number): InputBoxOptions {
  return window.showInputBox.mock.calls[index][0] as InputBoxOptions;
}

function enterInputs(url: string | undefined, assignmentKey?: string): void {
  window.showInputBox.mockResolvedValueOnce(url).mockResolvedValueOnce(assignmentKey);
}

let authService: { isSignedIn: Mock<() => Promise<boolean>> };
let fetchMock: Mock;

beforeEach(() => {
  authService = { isSignedIn: vi.fn(async () => true) };
  fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  registerConfigureAssignmentCommand(asContext(fakeExtensionContext()), authService as unknown as AuthService);
});

describe('configureAssignment command', () => {
  it('registers itself on the extension context', () => {
    const context = fakeExtensionContext();
    registerConfigureAssignmentCommand(asContext(context), authService as unknown as AuthService);

    expect(context.subscriptions).toHaveLength(1);
    expect(commands.registerCommand).toHaveBeenCalledWith(COMMAND, expect.any(Function));
  });

  it('stops without saving anything when the URL prompt is cancelled', async () => {
    enterInputs(undefined);

    await invokeCommand(COMMAND);

    expect(configUpdate).not.toHaveBeenCalled();
    expect(window.showInputBox).toHaveBeenCalledOnce();
    expect(window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('pre-fills the URL prompt with the current setting', async () => {
    configValues.set('serviceUrl', 'https://old.example.edu');
    enterInputs('https://old.example.edu');

    await invokeCommand(COMMAND);

    expect(inputBoxOptions(0).value).toBe('https://old.example.edu');
  });

  it('validates the service URL', async () => {
    enterInputs(undefined);
    await invokeCommand(COMMAND);
    const validate = inputBoxOptions(0).validateInput;

    expect(validate('  ')).toBe('The service URL is required.');
    expect(validate('moodle-bridge')).toBe('Enter a full URL, e.g. https://moodle-bridge.example.edu');
    expect(validate('ftp://moodle-bridge.example.edu')).toBe('The URL must start with http:// or https://');
    expect(validate('https://moodle-bridge.example.edu')).toBeUndefined();
    expect(validate('  http://localhost:8080  ')).toBeUndefined();
  });

  it('saves the trimmed URL to user settings', async () => {
    enterInputs('  https://bridge.example.edu  ');

    await invokeCommand(COMMAND);

    expect(configUpdate).toHaveBeenCalledOnce();
    expect(configUpdate).toHaveBeenCalledWith('serviceUrl', 'https://bridge.example.edu', ConfigurationTarget.Global);
    expect(messagesShown(window.showInformationMessage)).toContain('Moodle Submit configuration saved.');
  });

  it('skips the assignment key when no folder is open', async () => {
    enterInputs('https://bridge.example.edu');

    await invokeCommand(COMMAND);

    expect(window.showInputBox).toHaveBeenCalledOnce();
  });

  it('checks the service is reachable, ignoring trailing slashes', async () => {
    enterInputs('https://bridge.example.edu//', undefined);

    await invokeCommand(COMMAND);

    expect(fetchMock).toHaveBeenCalledWith('https://bridge.example.edu', expect.objectContaining({ method: 'HEAD' }));
    expect(messagesShown(window.showInformationMessage)).toContain('Reached https://bridge.example.edu.');
  });

  it('saves anyway but warns when the service is unreachable', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    enterInputs('https://bridge.example.edu', undefined);

    await invokeCommand(COMMAND);

    expect(configUpdate).toHaveBeenCalledWith('serviceUrl', 'https://bridge.example.edu', ConfigurationTarget.Global);
    expect(messagesShown(window.showWarningMessage)[0]).toMatch(/^Couldn't reach https:\/\/bridge\.example\.edu\./);
  });

  it('offers to sign in when signed out', async () => {
    authService.isSignedIn.mockResolvedValue(false);
    answerMessages(window.showInformationMessage, { 'Sign in with Microsoft': 'Sign in' });
    enterInputs('https://bridge.example.edu', undefined);

    await invokeCommand(COMMAND);

    expect(commands.executeCommand).toHaveBeenCalledWith('moodleSubmit.login');
  });

  it('does not sign in when the user picks Later', async () => {
    authService.isSignedIn.mockResolvedValue(false);
    answerMessages(window.showInformationMessage, { 'Sign in with Microsoft': 'Later' });
    enterInputs('https://bridge.example.edu', undefined);

    await invokeCommand(COMMAND);

    expect(commands.executeCommand).not.toHaveBeenCalledWith('moodleSubmit.login');
  });

  it('skips the sign-in prompt when already signed in', async () => {
    enterInputs('https://bridge.example.edu', undefined);

    await invokeCommand(COMMAND);

    expect(messagesShown(window.showInformationMessage)).not.toContainEqual(expect.stringContaining('Sign in'));
  });
});

describe('configureAssignment command — assignment key', () => {
  let folderPath: string;
  let target: string;

  beforeEach(async () => {
    folderPath = await tempDir();
    target = join(folderPath, WORKSPACE_CONFIG_FILE_NAME);
    workspace.workspaceFolders = [workspaceFolder(folderPath, 'calculator')];
  });

  it('creates the file with the trimmed key', async () => {
    enterInputs('https://bridge.example.edu', '  assignment-7 ');

    await invokeCommand(COMMAND);

    expect(inputBoxOptions(1).value).toBe('');
    expect(await readFile(target, 'utf8')).toBe('{\n  "assignmentKey": "assignment-7"\n}\n');
  });

  it('requires a valid, non-blank key', async () => {
    enterInputs('https://bridge.example.edu', undefined);
    await invokeCommand(COMMAND);
    const validate = inputBoxOptions(1).validateInput;

    expect(validate('   ')).toBe('The assignment key must not be blank.');
    expect(validate('has spaces')).toContain('may only contain');
    expect(validate(' assignment-7 ')).toBeUndefined();
  });

  it('writes nothing when the key prompt is cancelled', async () => {
    enterInputs('https://bridge.example.edu', undefined);

    await invokeCommand(COMMAND);

    expect(await pathExists(target)).toBe(false);
  });

  it('pre-fills from the file and updates the key while keeping other fields', async () => {
    await writeFile(target, '{"projectName":"linked-list","assignmentKey":"old-key"}', 'utf8');
    enterInputs('https://bridge.example.edu', 'new-key');

    await invokeCommand(COMMAND);

    expect(inputBoxOptions(1).value).toBe('old-key');
    expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({ projectName: 'linked-list', assignmentKey: 'new-key' });
  });

  it('leaves the file untouched when the key is unchanged', async () => {
    const original = '{ "assignmentKey": "mine" }';
    await writeFile(target, original, 'utf8');
    enterInputs('https://bridge.example.edu', 'mine');

    await invokeCommand(COMMAND);

    expect(await readFile(target, 'utf8')).toBe(original);
  });

  it('warns and leaves an unreadable file alone', async () => {
    await writeFile(target, '{ not json', 'utf8');
    enterInputs('https://bridge.example.edu', 'assignment-7');

    await invokeCommand(COMMAND);

    expect(messagesShown(window.showWarningMessage)).toContain(
      'Could not save the assignment key for "calculator": .moodle-submit.json could not be read: it is not valid JSON.',
    );
    expect(await readFile(target, 'utf8')).toBe('{ not json');
    expect(messagesShown(window.showInformationMessage)).toContain('Moodle Submit configuration saved.');
  });

  it('warns instead of failing when the file cannot be written', async () => {
    workspace.workspaceFolders = [workspaceFolder(join(folderPath, 'missing-dir'), 'gone')];
    enterInputs('https://bridge.example.edu', 'assignment-7');

    await invokeCommand(COMMAND);

    expect(messagesShown(window.showWarningMessage)[0]).toMatch(/^Could not save the assignment key for "gone": /);
    expect(messagesShown(window.showInformationMessage)).toContain('Moodle Submit configuration saved.');
  });
});
