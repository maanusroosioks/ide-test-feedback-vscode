import type { GetAccessTokenOptions } from '../auth/authService';
import type { TestRunRequest } from './httpTypes';
import { HttpError, InvalidServiceUrlError, MissingServiceUrlError, NetworkError, TimeoutError } from './errors';

export interface MoodleApiClientOptions {
  getBaseUrl: () => string;
  getTimeoutMs: () => number;
  getAccessToken: (opts?: GetAccessTokenOptions) => Promise<string>;
}

export interface SubmitResult {
  status: number;
  body: unknown;
}

const SUBMISSION_PATH = '/api/v1/idetestfeedback/runs';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Why `value` can't be used as the service URL, or `undefined` if it can. */
export function serviceUrlProblem(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return 'The service URL is required.';
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return 'Enter a full URL, e.g. https://moodle-bridge.example.edu';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'The URL must start with https://';
  }
  // The sign-in token travels with every submission, so plain HTTP is only for a local service.
  if (url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname)) {
    return 'The URL must use https:// (http:// is only allowed for localhost).';
  }
  // The submission path is appended to the URL, so it would land inside a query or fragment.
  // The raw text, since `url.search` is empty for a bare trailing `?`.
  if (/[?#]/.test(trimmed)) {
    return 'Enter just the base URL, without a ?query or #fragment.';
  }
  // fetch refuses a URL carrying credentials; sign-in supplies them.
  if (url.username || url.password) {
    return 'Leave the user name and password out of the URL.';
  }
  return undefined;
}

type Attempt = { kind: 'unauthorized' } | { kind: 'done'; status: number; ok: boolean; bodyText: string };

export class MoodleApiClient {
  constructor(private readonly options: MoodleApiClientOptions) {}

  async submitResults(payload: TestRunRequest): Promise<SubmitResult> {
    return this.postWithRetry(payload, false);
  }

  private async postWithRetry(payload: TestRunRequest, isRetry: boolean): Promise<SubmitResult> {
    const baseUrl = this.options.getBaseUrl().trim().replace(/\/+$/, '');
    if (!baseUrl) {
      throw new MissingServiceUrlError();
    }
    const problem = serviceUrlProblem(baseUrl);
    if (problem) {
      throw new InvalidServiceUrlError(problem);
    }

    const token = await this.options.getAccessToken({ forceRefresh: isRetry });
    const attempt = await this.post(baseUrl, token, payload, isRetry);

    if (attempt.kind === 'unauthorized') {
      return this.postWithRetry(payload, true);
    }

    const { status, ok, bodyText } = attempt;
    if (!ok) {
      throw new HttpError(status, bodyText);
    }

    let body: unknown = bodyText;
    if (bodyText) {
      try {
        body = JSON.parse(bodyText);
      } catch {
        // Not JSON: keep the raw text.
      }
    }
    return { status, body };
  }

  /** The timeout spans reading the body too: a server can send headers and then stall. */
  private async post(baseUrl: string, token: string, payload: TestRunRequest, isRetry: boolean): Promise<Attempt> {
    const controller = new AbortController();
    const timeoutMs = this.options.getTimeoutMs();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${baseUrl}${SUBMISSION_PATH}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (response.status === 401 && !isRetry) {
        // Releases the connection rather than leaving the unread body to the garbage collector.
        await response.body?.cancel().catch(() => {});
        return { kind: 'unauthorized' };
      }
      return { kind: 'done', status: response.status, ok: response.ok, bodyText: await response.text() };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new TimeoutError(`Request to ${baseUrl} timed out after ${timeoutMs}ms`);
      }
      throw new NetworkError(`Failed to reach ${baseUrl}`, error);
    } finally {
      clearTimeout(timeout);
    }
  }
}
