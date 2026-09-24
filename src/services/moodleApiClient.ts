import type { GetAccessTokenOptions } from '../auth/authService';
import type { TestRunRequest } from './httpTypes';
import { HttpError, MissingServiceUrlError, NetworkError, TimeoutError } from './errors';

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

export class MoodleApiClient {
  constructor(private readonly options: MoodleApiClientOptions) {}

  async submitResults(payload: TestRunRequest): Promise<SubmitResult> {
    return this.postWithRetry(payload, false);
  }

  private async postWithRetry(payload: TestRunRequest, isRetry: boolean): Promise<SubmitResult> {
    const baseUrl = this.options.getBaseUrl().replace(/\/+$/, '');
    if (!baseUrl) {
      throw new MissingServiceUrlError();
    }

    const token = await this.options.getAccessToken({ forceRefresh: isRetry });
    const controller = new AbortController();
    const timeoutMs = this.options.getTimeoutMs();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(`${baseUrl}${SUBMISSION_PATH}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new TimeoutError(`Request to ${baseUrl} timed out after ${timeoutMs}ms`);
      }
      throw new NetworkError(`Failed to reach ${baseUrl}`, error);
    } finally {
      clearTimeout(timeout);
    }

    if (response.status === 401 && !isRetry) {
      return this.postWithRetry(payload, true);
    }

    const bodyText = await response.text();
    if (!response.ok) {
      throw new HttpError(response.status, bodyText);
    }

    let body: unknown = bodyText;
    if (bodyText) {
      try {
        body = JSON.parse(bodyText);
      } catch {
        // Not JSON: keep the raw text.
      }
    }
    return { status: response.status, body };
  }
}
