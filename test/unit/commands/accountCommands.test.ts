import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthService } from '../../../src/auth/authService';
import { registerLoginCommand } from '../../../src/commands/login';
import { registerLogoutCommand } from '../../../src/commands/logout';
import { registerShowOutputCommand } from '../../../src/commands/showOutput';
import { getOutputChannel } from '../../../src/ui/outputChannel';
import {
  asContext,
  fakeExtensionContext,
  invokeCommand,
  resetVscodeStub,
  window,
} from '../helpers/vscodeStub';

function fakeAuth() {
  return { login: vi.fn(async () => ({})), logout: vi.fn(async () => {}) };
}

function asAuth(auth: ReturnType<typeof fakeAuth>): AuthService {
  return auth as unknown as AuthService;
}

beforeEach(() => {
  resetVscodeStub();
});

describe('login command', () => {
  it('signs in and confirms it', async () => {
    const auth = fakeAuth();
    registerLoginCommand(asContext(fakeExtensionContext()), asAuth(auth));

    await invokeCommand('moodleSubmit.login');

    expect(auth.login).toHaveBeenCalledOnce();
    expect(window.showInformationMessage).toHaveBeenCalledWith('Signed in with Microsoft.');
  });

  it('shows why sign-in failed', async () => {
    const auth = fakeAuth();
    auth.login.mockRejectedValue(new Error('User did not consent'));
    registerLoginCommand(asContext(fakeExtensionContext()), asAuth(auth));

    await invokeCommand('moodleSubmit.login');

    expect(window.showErrorMessage).toHaveBeenCalledWith('Sign-in failed: User did not consent');
    expect(window.showInformationMessage).not.toHaveBeenCalled();
  });
});

describe('logout command', () => {
  it('delegates to the auth service', async () => {
    const auth = fakeAuth();
    const context = fakeExtensionContext();
    registerLogoutCommand(asContext(context), asAuth(auth));

    await invokeCommand('moodleSubmit.logout');

    expect(auth.logout).toHaveBeenCalledOnce();
    expect(context.subscriptions).toHaveLength(1);
  });
});

describe('showOutput command', () => {
  it('reveals the output channel', async () => {
    registerShowOutputCommand(asContext(fakeExtensionContext()));

    await invokeCommand('moodleSubmit.showOutput');

    expect(getOutputChannel().show).toHaveBeenCalledOnce();
  });
});
