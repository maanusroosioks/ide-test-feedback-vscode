import { describe, expect, it, vi } from 'vitest';
import type { AuthService } from '../../../src/auth/authService';
import { registerAccountCommands } from '../../../src/commands/account';
import { CancelledError } from '../../../src/core/errors';
import { registerShowOutputCommand } from '../../../src/commands/showOutput';
import { getOutputChannel } from '../../../src/ui/outputChannel';
import {
  asContext,
  fakeExtensionContext,
  invokeCommand,
  window,
} from '../helpers/vscodeStub';

function fakeAuth() {
  return { login: vi.fn(async () => ({})) };
}

function asAuth(auth: ReturnType<typeof fakeAuth>): AuthService {
  return auth as unknown as AuthService;
}

describe('login command', () => {
  it('signs in and confirms it', async () => {
    const auth = fakeAuth();
    registerAccountCommands(asContext(fakeExtensionContext()), asAuth(auth));

    await invokeCommand('moodleSubmit.login');

    expect(auth.login).toHaveBeenCalledOnce();
    expect(window.showInformationMessage).toHaveBeenCalledWith('Signed in with Microsoft.');
  });

  it('shows why sign-in failed', async () => {
    const auth = fakeAuth();
    auth.login.mockRejectedValue(new Error('User did not consent'));
    registerAccountCommands(asContext(fakeExtensionContext()), asAuth(auth));

    await invokeCommand('moodleSubmit.login');

    expect(window.showErrorMessage).toHaveBeenCalledWith('Sign-in failed: User did not consent');
    expect(window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('says nothing when the user dismisses the sign-in dialog', async () => {
    const auth = fakeAuth();
    auth.login.mockRejectedValue(new CancelledError());
    registerAccountCommands(asContext(fakeExtensionContext()), asAuth(auth));

    await invokeCommand('moodleSubmit.login');

    expect(window.showErrorMessage).not.toHaveBeenCalled();
    expect(window.showInformationMessage).not.toHaveBeenCalled();
  });
});

describe('logout command', () => {
  it('points the user at the Accounts menu to sign out', async () => {
    const context = fakeExtensionContext();
    registerAccountCommands(asContext(context), asAuth(fakeAuth()));

    await invokeCommand('moodleSubmit.logout');

    expect(window.showInformationMessage).toHaveBeenCalledOnce();
    expect(window.showInformationMessage.mock.calls[0][0]).toContain('Accounts menu');
    expect(context.subscriptions).toHaveLength(2);
  });
});

describe('showOutput command', () => {
  it('reveals the output channel', async () => {
    registerShowOutputCommand(asContext(fakeExtensionContext()));

    await invokeCommand('moodleSubmit.showOutput');

    expect(getOutputChannel().show).toHaveBeenCalledOnce();
  });
});
