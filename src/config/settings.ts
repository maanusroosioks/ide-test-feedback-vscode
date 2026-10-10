import * as vscode from 'vscode';
import type { CaptureOptions } from '../capture/evidence';

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('moodleSubmit');
}

/** For `resource`-scoped settings: without the folder, a multi-root workspace's per-folder values are skipped. */
function folderConfig(folderPath: string | undefined): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('moodleSubmit', folderPath ? vscode.Uri.file(folderPath) : undefined);
}

/** Defaults live here and in package.json; a non-numeric or non-positive setting falls back to them. */
function boundedNumber(
  settings: vscode.WorkspaceConfiguration,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = settings.get<number>(key, fallback);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.max(Math.floor(value), min), max);
}

export function getServiceUrl(): string {
  return config().get<string>('serviceUrl', '');
}

export function getRequestTimeoutMs(): number {
  return boundedNumber(config(), 'requestTimeoutMs', 15_000, 1_000, 120_000);
}

export function getAuthScopes(): string[] {
  return config().get<string[]>('authScopes', ['User.Read']);
}

/** Blank or non-string entries are dropped: the report flags appended to `""` would be the whole command. */
export function getTestCommandOverrides(folderPath?: string): Record<string, string> {
  const raw: unknown = folderConfig(folderPath).get('testCommandOverrides', {});
  if (typeof raw !== 'object' || raw === null) return {};
  return Object.fromEntries(
    Object.entries(raw)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim() !== '')
      .map(([adapterId, command]) => [adapterId, command.trim()]),
  );
}

export function getPreferredAdapterId(folderPath?: string): string | undefined {
  return folderConfig(folderPath).get<string>('preferredAdapter');
}

// Hard ceiling so a student can't set a huge value and use submissions to hammer the gateway.
const MAX_TOTAL_CHARS_CEILING = 1_000_000;

export function getSourceCaptureSettings(folderPath?: string): CaptureOptions {
  const settings = folderConfig(folderPath);
  return {
    captureSource: settings.get<boolean>('submitTestSource', true),
    maxTotalChars: boundedNumber(settings, 'maxTotalSourceChars', 500_000, 1, MAX_TOTAL_CHARS_CEILING),
  };
}

export function getWarnOnSuspiciousTests(folderPath?: string): boolean {
  return folderConfig(folderPath).get<boolean>('warnOnSuspiciousTests', true);
}

/** Machine-scoped, so VS Code only accepts it in user settings. */
export async function setServiceUrl(value: string): Promise<void> {
  await config().update('serviceUrl', value, vscode.ConfigurationTarget.Global);
}
