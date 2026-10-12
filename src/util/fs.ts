import type { Dirent } from 'node:fs';
import { tmpdir } from 'node:os';
import { access, mkdtemp, readdir, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** True when any of `names` exists directly inside `folderPath`. */
export async function anyExists(folderPath: string, names: string[]): Promise<boolean> {
  const found = await Promise.all(names.map((name) => pathExists(join(folderPath, name))));
  return found.includes(true);
}

/** Empty when the directory can't be read: a missing or locked folder holds nothing to find. */
export async function readDirSafe(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Retries ride out the brief locks Windows antivirus and indexers put on freshly written files. */
const RM_OPTIONS = { recursive: true, force: true, maxRetries: 3 } as const;

export async function removeDir(path: string): Promise<void> {
  await rm(path, RM_OPTIONS);
}

export function makeReportDir(adapterId: string): Promise<string> {
  return mkdtemp(join(resolve(tmpdir()), `ide-test-feedback-${adapterId}-`));
}

export async function cleanupReport(path: string): Promise<void> {
  const normalized = resolve(path);
  // Segment-wise: a bare prefix would also accept `<tmp>2/...` and tmpdir itself.
  if (!normalized.startsWith(resolve(tmpdir()) + sep)) {
    return;
  }
  await rm(normalized, RM_OPTIONS);
}
