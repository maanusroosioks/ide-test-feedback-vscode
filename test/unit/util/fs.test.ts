import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { anyExists, cleanupReport, makeReportDir, pathExists } from '../../../src/util/fs';
import { tempDir, writeTree } from '../helpers/fs';

describe('anyExists', () => {
  it('is true when at least one of the names is present', async () => {
    const dir = await tempDir();
    await writeTree(dir, { 'build.gradle.kts': '' });

    expect(await anyExists(dir, ['build.gradle', 'build.gradle.kts'])).toBe(true);
    expect(await anyExists(dir, ['pom.xml', 'pytest.ini'])).toBe(false);
    expect(await anyExists(dir, [])).toBe(false);
  });
});

describe('cleanupReport', () => {
  let sandbox: string;
  let fakeTmp: string;

  // A regressed guard deletes recursively, so the temp dir it guards must be one we can lose.
  beforeEach(async () => {
    sandbox = await tempDir();
    fakeTmp = join(sandbox, 'tmp');
    await mkdir(fakeTmp);
    for (const name of ['TMPDIR', 'TMP', 'TEMP']) vi.stubEnv(name, fakeTmp);
  });

  it('removes a report directory it created under the temp directory', async () => {
    const dir = await makeReportDir('test');
    await writeFile(join(dir, 'report.xml'), '<testsuites/>', 'utf8');

    await cleanupReport(dir);
    expect(await pathExists(dir)).toBe(false);
  });

  it('refuses paths outside the temp directory, including a same-prefix sibling', async () => {
    // `<tmp>-sibling` shares a string prefix with `<tmp>` but is not inside it.
    await writeTree(sandbox, { 'tmp-sibling/not-ours.xml': 'keep me' });
    const path = join(sandbox, 'tmp-sibling', 'not-ours.xml');

    await cleanupReport(path);
    expect(await pathExists(path)).toBe(true);
  });

  it('refuses the temp directory itself', async () => {
    await cleanupReport(fakeTmp);
    expect(await pathExists(fakeTmp)).toBe(true);
  });
});

describe('makeReportDir', () => {
  it('creates a fresh directory under the temp directory on every call', async () => {
    const dirs = await Promise.all(Array.from({ length: 50 }, () => makeReportDir('pytest')));
    try {
      expect(new Set(dirs).size).toBe(50);
      expect(dirname(dirs[0])).toBe(resolve(tmpdir()));
      expect(await pathExists(dirs[0])).toBe(true);
    } finally {
      await Promise.all(dirs.map(cleanupReport));
    }
  });
});
