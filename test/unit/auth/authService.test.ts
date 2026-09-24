import { beforeEach, describe, expect, it } from 'vitest';
import { AuthService } from '../../../src/auth/authService';
import { authentication, resetVscodeStub, window } from '../helpers/vscodeStub';

const SCOPES = ['User.Read'];

let service: AuthService;

beforeEach(() => {
  resetVscodeStub();
  service = new AuthService(() => SCOPES);
});

describe('AuthService', () => {
  it('signs in interactively with the Microsoft provider', async () => {
    const session = await service.login();

    expect(session).toEqual({ accessToken: 'token-abc' });
    expect(authentication.getSession).toHaveBeenCalledWith('microsoft', SCOPES, { createIfNone: true });
  });

  it('reads the scopes on every call, so a settings change applies without a reload', async () => {
    let scopes = ['User.Read'];
    service = new AuthService(() => scopes);

    await service.login();
    scopes = ['api://bridge/.default'];
    await service.login();

    expect(authentication.getSession.mock.calls[1][1]).toEqual(['api://bridge/.default']);
  });

  it('checks sign-in silently', async () => {
    expect(await service.isSignedIn()).toBe(true);
    expect(authentication.getSession).toHaveBeenCalledWith('microsoft', SCOPES, { silent: true });

    authentication.getSession.mockResolvedValueOnce(undefined);
    expect(await service.isSignedIn()).toBe(false);
  });

  it('returns the session token, prompting to sign in if needed', async () => {
    expect(await service.getAccessToken()).toBe('token-abc');
    expect(authentication.getSession).toHaveBeenCalledWith('microsoft', SCOPES, { createIfNone: true });
  });

  it('forces a new session when asked to refresh', async () => {
    authentication.getSession.mockResolvedValueOnce({ accessToken: 'fresh-token' });

    expect(await service.getAccessToken({ forceRefresh: true })).toBe('fresh-token');
    expect(authentication.getSession).toHaveBeenCalledWith('microsoft', SCOPES, { forceNewSession: true });
  });

  it('points the user at the Accounts menu to sign out', async () => {
    await service.logout();

    expect(window.showInformationMessage).toHaveBeenCalledOnce();
    expect(window.showInformationMessage.mock.calls[0][0]).toContain('Accounts menu');
  });
});
