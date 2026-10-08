import { describe, expect, it, vi, type Mock } from 'vitest';
import { MoodleApiClient } from '../../../src/services/moodleApiClient';
import { HttpError, MissingServiceUrlError, NetworkError, TimeoutError } from '../../../src/services/errors';
import type { TestRunRequest } from '../../../src/services/httpTypes';

const samplePayload: TestRunRequest = {
  assignmentKey: 'assignment-1',
  ide: 'VSCODE',
  results: [{ testName: 'test_one', status: 'PASSED' }],
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Replaces `fetch` with one that answers each call with the next outcome: a response, or an error to throw. */
function stubFetch(...outcomes: Array<Response | Error>): Mock {
  const fetchMock = vi.fn();
  for (const outcome of outcomes) {
    if (outcome instanceof Error) fetchMock.mockRejectedValueOnce(outcome);
    else fetchMock.mockResolvedValueOnce(outcome);
  }
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function client(overrides: Partial<{ baseUrl: string; token: () => Promise<string> }> = {}) {
  return new MoodleApiClient({
    getBaseUrl: () => overrides.baseUrl ?? 'https://moodle-bridge.example.edu',
    getTimeoutMs: () => 5000,
    getAccessToken: overrides.token ?? (async () => 'token-abc'),
  });
}

describe('MoodleApiClient', () => {
  it('POSTs to the submission endpoint with a bearer token and returns the parsed response', async () => {
    const fetchMock = stubFetch(jsonResponse(200, { received: true }));

    const result = await client().submitResults(samplePayload);

    expect(result).toEqual({ status: 200, body: { received: true } });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe('https://moodle-bridge.example.edu/api/v1/idetestfeedback/runs');
    expect(init.headers.Authorization).toBe('Bearer token-abc');
    expect(JSON.parse(init.body as string)).toEqual(samplePayload);
  });

  it('throws HttpError on a non-2xx response', async () => {
    stubFetch(new Response('bad request', { status: 400 }));

    await expect(client().submitResults(samplePayload)).rejects.toMatchObject({
      status: 400,
      body: 'bad request',
    } satisfies Partial<HttpError>);
  });

  it('retries exactly once on a 401, forcing a fresh token on the retry', async () => {
    const getAccessToken = vi.fn().mockResolvedValue('token-abc');
    const fetchMock = stubFetch(new Response('unauthorized', { status: 401 }), jsonResponse(200, {}));

    const result = await client({ token: getAccessToken }).submitResults(samplePayload);

    expect(result.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getAccessToken).toHaveBeenCalledTimes(2);
    expect(getAccessToken).toHaveBeenNthCalledWith(1, { forceRefresh: false });
    expect(getAccessToken).toHaveBeenNthCalledWith(2, { forceRefresh: true });
  });

  it('surfaces a 401 as HttpError if the retry also fails', async () => {
    stubFetch(new Response('unauthorized', { status: 401 }), new Response('unauthorized', { status: 401 }));

    await expect(client().submitResults(samplePayload)).rejects.toBeInstanceOf(HttpError);
  });

  it('wraps a network failure in NetworkError', async () => {
    stubFetch(new Error('ECONNREFUSED'));

    await expect(client().submitResults(samplePayload)).rejects.toBeInstanceOf(NetworkError);
  });

  it('wraps an aborted request in TimeoutError', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    stubFetch(abortError);

    await expect(client().submitResults(samplePayload)).rejects.toBeInstanceOf(TimeoutError);
  });

  it('throws MissingServiceUrlError immediately when no serviceUrl is configured', async () => {
    const fetchMock = stubFetch();

    await expect(client({ baseUrl: '' }).submitResults(samplePayload)).rejects.toBeInstanceOf(MissingServiceUrlError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
