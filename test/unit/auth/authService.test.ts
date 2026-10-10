import { beforeEach, describe, expect, it } from 'vitest';
import { AuthService } from '../../../src/auth/authService';
import { CancelledError } from '../../../src/core/errors';
import { authentication } from '../helpers/vscodeStub';

const SCOPES = ['User.Read'];

let service: AuthService;

beforeEach(() => {
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

  it.each([
    ['the consent refusal', new Error('User did not consent to login.')],
    ['a Canceled error', Object.assign(new Error('Canceled'), { name: 'Canceled' })],
  ])('turns %s from a dismissed sign-in dialog into a quiet cancel', async (_label, dismissal) => {
    authentication.getSession.mockRejectedValueOnce(dismissal);

    await expect(service.getAccessToken()).rejects.toBeInstanceOf(CancelledError);
  });

  it('stops waiting on a sign-in when the caller aborts', async () => {
    authentication.getSession.mockReturnValueOnce(new Promise(() => {}));
    const caller = new AbortController();

    const token = service.getAccessToken({ signal: caller.signal });
    caller.abort();

    await expect(token).rejects.toBeInstanceOf(CancelledError);
  });

  it('does not start waiting when the caller already aborted', async () => {
    await expect(service.getAccessToken({ signal: AbortSignal.abort() })).rejects.toBeInstanceOf(CancelledError);
  });

  it('passes other sign-in failures through', async () => {
    authentication.getSession.mockRejectedValueOnce(new Error('AADSTS50020: user account not in tenant'));

    await expect(service.login()).rejects.toThrow('AADSTS50020');
  });

  it('forces a new session when asked to refresh', async () => {
    authentication.getSession.mockResolvedValueOnce({ accessToken: 'fresh-token' });

    expect(await service.getAccessToken({ forceRefresh: true })).toBe('fresh-token');
    expect(authentication.getSession).toHaveBeenCalledWith('microsoft', SCOPES, { forceNewSession: true });
  });
});
