import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { AuthService } from '../../../src/auth/authService';
import { registerConfigureAssignmentCommand } from '../../../src/commands/configureAssignment';
import { pathExists } from '../../../src/util/shell';
import {
  ConfigurationTarget,
  asContext,
  commands,
  configUpdate,
  configValues,
  fakeExtensionContext,
  invokeCommand,
  resetVscodeStub,
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
  resetVscodeStub();
  authService = { isSignedIn: vi.fn(async () => true) };
  fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  registerConfigureAssignmentCommand(asContext(fakeExtensionContext()), authService as unknown as AuthService);
});

afterEach(() => {
  vi.unstubAllGlobals();
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

  it('pre-fills both prompts with the current settings', async () => {
    configValues.set('serviceUrl', 'https://old.example.edu');
    configValues.set('assignmentKey', 'old-key');
    enterInputs('https://old.example.edu', 'old-key');

    await invokeCommand(COMMAND);

    expect(inputBoxOptions(0).value).toBe('https://old.example.edu');
    expect(inputBoxOptions(1).value).toBe('old-key');
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

  it('validates the assignment key but allows leaving it blank', async () => {
    enterInputs('https://bridge.example.edu', undefined);
    await invokeCommand(COMMAND);
    const validate = inputBoxOptions(1).validateInput;

    expect(validate('')).toBeUndefined();
    expect(validate('   ')).toBeUndefined();
    expect(validate('assignment-7')).toBeUndefined();
    expect(validate('has spaces')).toContain('may only contain');
  });

  it('saves the trimmed URL and key', async () => {
    enterInputs('  https://bridge.example.edu  ', '  assignment-7 ');

    await invokeCommand(COMMAND);

    expect(configUpdate).toHaveBeenCalledWith('serviceUrl', 'https://bridge.example.edu', ConfigurationTarget.Global);
    expect(configUpdate).toHaveBeenCalledWith('assignmentKey', 'assignment-7', ConfigurationTarget.Global);
    expect(messagesShown(window.showInformationMessage)).toContain('Moodle Submit configuration saved.');
  });

  it('leaves the assignment key alone when that prompt is cancelled', async () => {
    enterInputs('https://bridge.example.edu', undefined);

    await invokeCommand(COMMAND);

    expect(configUpdate).toHaveBeenCalledTimes(1);
    expect(configUpdate.mock.calls[0][0]).toBe('serviceUrl');
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

    expect(messagesShown(window.showInformationMessage).some((m) => m.includes('Sign in'))).toBe(false);
  });
});

describe('configureAssignment command — per-project config file', () => {
  let folderPath: string;
  let target: string;

  beforeEach(async () => {
    folderPath = await mkdtemp(join(tmpdir(), 'moodle-configure-'));
    target = join(folderPath, '.moodle-submit.json');
    workspace.workspaceFolders = [workspaceFolder(folderPath, 'calculator')];
    enterInputs('https://bridge.example.edu', undefined);
  });

  it('creates a placeholder file and opens it on "Create"', async () => {
    answerMessages(window.showInformationMessage, { 'Add a .moodle-submit.json': 'Create' });

    await invokeCommand(COMMAND);

    expect(messagesShown(window.showInformationMessage)).toContain(
      'Add a .moodle-submit.json to "calculator" for a per-project assignment key?',
    );
    expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({
      assignmentKey: 'REPLACE_WITH_YOUR_ASSIGNMENT_KEY',
    });
    expect(workspace.openTextDocument).toHaveBeenCalledWith(target);
    expect(window.showTextDocument).toHaveBeenCalledOnce();
  });

  it('writes nothing on "Skip"', async () => {
    answerMessages(window.showInformationMessage, { 'Add a .moodle-submit.json': 'Skip' });

    await invokeCommand(COMMAND);

    expect(await pathExists(target)).toBe(false);
  });

  it('never offers to replace an existing file', async () => {
    await writeFile(target, '{"assignmentKey":"mine"}', 'utf8');
    answerMessages(window.showInformationMessage, { 'Add a .moodle-submit.json': 'Create' });

    await invokeCommand(COMMAND);

    expect(messagesShown(window.showInformationMessage).some((m) => m.startsWith('Add a'))).toBe(false);
    expect(await readFile(target, 'utf8')).toBe('{"assignmentKey":"mine"}');
  });

  it('warns instead of failing when the file cannot be written', async () => {
    workspace.workspaceFolders = [workspaceFolder(join(folderPath, 'missing-dir'), 'gone')];
    answerMessages(window.showInformationMessage, { 'Add a .moodle-submit.json': 'Create' });

    await invokeCommand(COMMAND);

    expect(messagesShown(window.showWarningMessage)[0]).toMatch(/^Could not create .*\.moodle-submit\.json\.$/);
    expect(workspace.openTextDocument).not.toHaveBeenCalled();
    expect(messagesShown(window.showInformationMessage)).toContain('Moodle Submit configuration saved.');
  });

  it('skips the offer when no folder is open', async () => {
    workspace.workspaceFolders = undefined;

    await invokeCommand(COMMAND);

    expect(messagesShown(window.showInformationMessage).some((m) => m.startsWith('Add a'))).toBe(false);
  });
});
