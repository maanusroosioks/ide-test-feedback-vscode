import * as vscode from 'vscode';

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('moodleSubmit');
}

/** Defaults live here and in package.json; a non-numeric or non-positive setting falls back to them. */
function boundedNumber(key: string, fallback: number, min: number, max: number): number {
  const value = config().get<number>(key, fallback);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.max(Math.floor(value), min), max);
}

export function getServiceUrl(): string {
  return config().get<string>('serviceUrl', '');
}

export function getRequestTimeoutMs(): number {
  return boundedNumber('requestTimeoutMs', 15_000, 1_000, 120_000);
}

export function getAuthScopes(): string[] {
  return config().get<string[]>('authScopes', ['User.Read']);
}

export function getTestCommandOverrides(): Record<string, string> {
  return config().get<Record<string, string>>('testCommandOverrides', {});
}

export function getPreferredAdapterId(): string | undefined {
  return config().get<string>('preferredAdapter');
}

export interface SourceCaptureSettings {
  captureSource: boolean;
  maxTotalChars: number;
}

// Hard ceiling so a student can't set a huge value and use submissions to hammer the gateway.
const MAX_TOTAL_CHARS_CEILING = 1_000_000;

export function getSourceCaptureSettings(): SourceCaptureSettings {
  return {
    captureSource: config().get<boolean>('submitTestSource', true),
    maxTotalChars: boundedNumber('maxTotalSourceChars', 500_000, 1, MAX_TOTAL_CHARS_CEILING),
  };
}

export function getWarnOnSuspiciousTests(): boolean {
  return config().get<boolean>('warnOnSuspiciousTests', true);
}

/** Machine-scoped, so VS Code only accepts it in user settings. */
export async function setServiceUrl(value: string): Promise<void> {
  await config().update('serviceUrl', value, vscode.ConfigurationTarget.Global);
}
