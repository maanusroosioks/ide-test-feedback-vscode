import * as vscode from 'vscode';
import { CancelledError } from '../core/errors';

const PROVIDER_ID = 'microsoft';

export interface GetAccessTokenOptions {
  forceRefresh?: boolean;
}

/**
 * Dismissing the sign-in dialog rejects with a plain Error ("User did not consent to login.") or,
 * on some versions, a `Canceled` error; neither is a failure worth an error popup.
 */
function isDismissal(error: unknown): boolean {
  return error instanceof Error && (error.name === 'Canceled' || /did not consent|cancel/i.test(error.message));
}

export class AuthService {
  constructor(private readonly getScopes: () => string[]) {}

  async login(): Promise<vscode.AuthenticationSession> {
    return this.interactiveSession({ createIfNone: true });
  }

  async isSignedIn(): Promise<boolean> {
    const session = await vscode.authentication.getSession(PROVIDER_ID, this.getScopes(), { silent: true });
    return session !== undefined;
  }

  async getAccessToken({ forceRefresh = false }: GetAccessTokenOptions = {}): Promise<string> {
    const session = await this.interactiveSession(forceRefresh ? { forceNewSession: true } : { createIfNone: true });
    return session.accessToken;
  }

  /** Throws CancelledError when the user dismisses the sign-in dialog. */
  private async interactiveSession(
    options: { createIfNone: true } | { forceNewSession: true },
  ): Promise<vscode.AuthenticationSession> {
    let session: vscode.AuthenticationSession | undefined;
    try {
      session = await vscode.authentication.getSession(PROVIDER_ID, this.getScopes(), options);
    } catch (error) {
      throw isDismissal(error) ? new CancelledError() : error;
    }
    // Neither option should let it come back empty, but the union picks the overload that may.
    if (!session) throw new CancelledError();
    return session;
  }
}
