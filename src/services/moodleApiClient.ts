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
    return 'Enter a full URL, e.g. https://ide-feedback-gateway.example.edu';
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

interface Reply {
  status: number;
  ok: boolean;
  bodyText: string;
}

/** The parsed JSON, or the raw text when the body isn't JSON. */
function parseBody(bodyText: string): unknown {
  if (!bodyText) return bodyText;
  try {
    return JSON.parse(bodyText);
  } catch {
    return bodyText;
  }
}

export class MoodleApiClient {
  constructor(private readonly options: MoodleApiClientOptions) {}

  async submitResults(payload: TestRunRequest): Promise<SubmitResult> {
    const baseUrl = this.baseUrl();
    let reply = await this.post(baseUrl, payload, { forceRefresh: false });
    if (reply.status === 401) {
      // The cached token may have expired: one retry with a fresh one, whose 401 is final.
      reply = await this.post(baseUrl, payload, { forceRefresh: true });
    }
    if (!reply.ok) {
      throw new HttpError(reply.status, reply.bodyText);
    }
    return { status: reply.status, body: parseBody(reply.bodyText) };
  }

  private baseUrl(): string {
    const baseUrl = this.options.getBaseUrl().trim().replace(/\/+$/, '');
    if (!baseUrl) {
      throw new MissingServiceUrlError();
    }
    const problem = serviceUrlProblem(baseUrl);
    if (problem) {
      throw new InvalidServiceUrlError(problem);
    }
    return baseUrl;
  }

  /** The timeout spans reading the body too: a server can send headers and then stall. */
  private async post(
    baseUrl: string,
    payload: TestRunRequest,
    { forceRefresh }: GetAccessTokenOptions,
  ): Promise<Reply> {
    const token = await this.options.getAccessToken({ forceRefresh });
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

      if (response.status === 401 && !forceRefresh) {
        // About to be retried, so its body goes unread: cancelling releases the connection rather
        // than leaving it to the garbage collector.
        await response.body?.cancel().catch(() => {});
        return { status: response.status, ok: false, bodyText: '' };
      }
      return { status: response.status, ok: response.ok, bodyText: await response.text() };
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
