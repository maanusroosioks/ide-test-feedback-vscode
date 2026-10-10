import { readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CancelledError } from '../../../src/core/errors';
import { commandExists, killRunningCommands, runCommand } from '../../../src/util/shell';
import { tempDir } from '../helpers/fs';

// Double quotes outside, single inside: valid under both cmd.exe and sh.
const node = (script: string): string => `node -e "${script}"`;

/** Starts a node process that idles for 30s, and waits until it has reported its own pid. */
async function startSleeper(signal?: AbortSignal) {
  const pidFile = join(await tempDir(), 'pid').split(sep).join('/');
  const run = runCommand(
    node(`require('fs').writeFileSync('${pidFile}', String(process.pid)); setTimeout(() => {}, 30000)`),
    { cwd: process.cwd(), signal },
  );
  const pid = await waitFor(async () => Number(await readFile(pidFile, 'utf8').catch(() => '')) || undefined);
  return { run, pid };
}

describe('runCommand', () => {
  it('captures stdout, stderr and the exit code', async () => {
    const result = await runCommand(
      node("process.stdout.write('out'); process.stderr.write('err'); process.exit(3)"),
      { cwd: process.cwd() },
    );

    expect(result).toEqual({ exitCode: 3, stdout: 'out', stderr: 'err' });
  });

  it("gives the command an empty stdin, so a test that reads input doesn't wait forever", async () => {
    const result = await runCommand(
      node("let n = 0; process.stdin.on('data', (d) => (n += d.length)); process.stdin.on('end', () => process.stdout.write('eof ' + n))"),
      { cwd: process.cwd() },
    );

    expect(result.stdout).toBe('eof 0');
  }, 10_000);

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

  // The command runs under a shell; killing only the shell would orphan it, as cmd.exe does to mvn.
  it("kills the command, shell's child included, and rejects with CancelledError when aborted", async () => {
    const controller = new AbortController();
    const { run, pid } = await startSleeper(controller.signal);
    const abortedAt = Date.now();

    controller.abort();

    await expect(run).rejects.toBeInstanceOf(CancelledError);
    // Well inside the 5s test timeout, which would otherwise fire first and hide a slow kill.
    expect(Date.now() - abortedAt).toBeLessThan(3_000);
    expect(await waitFor(async () => (isAlive(pid) ? undefined : true))).toBe(true);
  });

  it('stops passing output on once cancelled, since the run it belongs to has ended', async () => {
    const controller = new AbortController();
    const chunks: string[] = [];

    const run = runCommand(node("setInterval(() => process.stdout.write('tick'), 20)"), {
      cwd: process.cwd(),
      signal: controller.signal,
      onOutput: (chunk) => chunks.push(chunk),
    });
    await waitFor(async () => (chunks.length > 0 ? true : undefined));
    controller.abort();
    await expect(run).rejects.toBeInstanceOf(CancelledError);
    const seenAtCancel = chunks.length;

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
    expect(chunks).toHaveLength(seenAtCancel);
  });

  it('stops every running command on request, as on deactivation', async () => {
    const { run, pid } = await startSleeper();

    await killRunningCommands();

    expect((await run).exitCode).not.toBe(0);
    expect(await waitFor(async () => (isAlive(pid) ? undefined : true))).toBe(true);
  });

  it('reports a command that cannot be started as a failure, not a crash', async () => {
    const result = await runCommand(node('0'), { cwd: join(process.cwd(), 'no-such-dir') });

    expect(result.exitCode).not.toBe(0);
  });
});

describe('commandExists', () => {
  it('finds a command on PATH without running it', async () => {
    expect(await commandExists('node')).toBe(true);
    expect(await commandExists('no-such-command-moodle-submit')).toBe(false);
  });
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs = 3_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
}
