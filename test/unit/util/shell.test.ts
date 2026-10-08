import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CancelledError } from '../../../src/core/errors';
import { anyExists, cleanupReport, pathExists, runCommand, tempReportPath } from '../../../src/util/shell';
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

  it('removes a report it created under the temp directory', async () => {
    const path = tempReportPath('test', 'xml');
    await writeFile(path, '<testsuites/>', 'utf8');

    await cleanupReport(path);
    expect(await pathExists(path)).toBe(false);
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

describe('tempReportPath', () => {
  it('never hands out the same path twice', () => {
    const paths = new Set(Array.from({ length: 50 }, () => tempReportPath('pytest', 'xml')));
    expect(paths.size).toBe(50);
    expect(dirname([...paths][0])).toBe(resolve(tmpdir()));
  });
});

describe('runCommand', () => {
  // Double quotes outside, single inside: valid under both cmd.exe and sh.
  const node = (script: string): string => `node -e "${script}"`;

  it('captures stdout, stderr and the exit code', async () => {
    const result = await runCommand(
      node("process.stdout.write('out'); process.stderr.write('err'); process.exit(3)"),
      { cwd: process.cwd() },
    );

    expect(result).toEqual({ exitCode: 3, stdout: 'out', stderr: 'err' });
  });

  it('reports exit code 0 on success', async () => {
    const result = await runCommand(node("process.stdout.write('ok')"), { cwd: process.cwd() });

    expect(result.exitCode).toBe(0);
  });

  it('runs in the given working directory', async () => {
    const dir = await tempDir();

    const { stdout } = await runCommand(node('process.stdout.write(process.cwd())'), { cwd: dir });

    expect(resolve(stdout)).toBe(resolve(dir));
  });

  it('streams output to the sink as it arrives, tagged by stream', async () => {
    const chunks: Array<[string, string]> = [];

    await runCommand(node("process.stdout.write('a'); process.stderr.write('b')"), {
      cwd: process.cwd(),
      onOutput: (chunk, stream) => chunks.push([chunk, stream]),
    });

    expect(chunks).toContainEqual(['a', 'stdout']);
    expect(chunks).toContainEqual(['b', 'stderr']);
  });

  it('kills the command and rejects with CancelledError when aborted mid-run', async () => {
    const controller = new AbortController();
    const started = Date.now();

    const run = runCommand(node('setTimeout(() => {}, 30000)'), { cwd: process.cwd(), signal: controller.signal });
    setTimeout(() => controller.abort(), 100);

    await expect(run).rejects.toBeInstanceOf(CancelledError);
    // Well inside the 5s test timeout, which would otherwise fire first and hide a slow kill.
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});
