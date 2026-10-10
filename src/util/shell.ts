import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { CancelledError } from '../core/errors';

export interface RunCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Receives output as the child process produces it, for live UI streaming. */
export type OutputSink = (chunk: string, stream: 'stdout' | 'stderr') => void;

export interface RunCommandOptions {
  cwd: string;
  signal?: AbortSignal;
  onOutput?: OutputSink;
}

/** Per stream. Output is streamed live, so only the tail is kept for the log; a chatty build is never killed over it. */
const MAX_CAPTURED_CHARS = 5_000_000;

class OutputTail {
  private text = '';
  private dropped = false;

  append(chunk: string): void {
    this.text += chunk;
    // Trimmed only at twice the limit, so a long build copies the tail now and then, not per chunk.
    if (this.text.length > 2 * MAX_CAPTURED_CHARS) {
      this.text = this.text.slice(-MAX_CAPTURED_CHARS);
      this.dropped = true;
    }
  }

  toString(): string {
    if (!this.dropped && this.text.length <= MAX_CAPTURED_CHARS) return this.text;
    return `[earlier output omitted]\n${this.text.slice(-MAX_CAPTURED_CHARS)}`;
  }
}

/**
 * Killing only the shell would orphan the build it started, which keeps running and writing
 * reports. Resolves once the kill has been carried out, so the next run doesn't race the old one.
 */
function killTree(child: ChildProcess): Promise<void> {
  const { pid } = child;
  if (pid === undefined) return Promise.resolve();
  if (process.platform === 'win32') {
    return new Promise((done) => {
      execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => done());
    });
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  return Promise.resolve();
}

/** Commands still running, so deactivation can stop them rather than leave builds behind a reload. */
const running = new Set<ChildProcess>();

export async function killRunningCommands(): Promise<void> {
  await Promise.all([...running].map(killTree));
}

export function runCommand(command: string, options: RunCommandOptions): Promise<RunCommandResult> {
  const { cwd, signal, onOutput } = options;
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) {
      reject(new CancelledError());
      return;
    }

    // Detached on POSIX so the command gets its own process group for killTree; on Windows that
    // would open a console window instead.
    // stdin ignored: nothing ever writes to it, and a test that reads input would wait on it forever.
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    running.add(child);
    const stdout = new OutputTail();
    const stderr = new OutputTail();
    let settled = false;

    /** `false` if already settled. Output stops being forwarded from here on: the caller has moved on. */
    const settle = (): boolean => {
      if (settled) return false;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      return true;
    };
    const onAbort = (): void => {
      if (!settle()) return;
      void killTree(child).then(() => reject(new CancelledError()));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (settled) return;
      stdout.append(chunk);
      onOutput?.(chunk, 'stdout');
    });
    child.stderr?.on('data', (chunk: string) => {
      if (settled) return;
      stderr.append(chunk);
      onOutput?.(chunk, 'stderr');
    });

    child.on('error', (error) => {
      running.delete(child);
      stderr.append(error.message);
      if (settle()) resolvePromise({ exitCode: 1, stdout: stdout.toString(), stderr: stderr.toString() });
    });
    child.on('close', (code) => {
      running.delete(child);
      if (settle()) resolvePromise({ exitCode: code ?? 1, stdout: stdout.toString(), stderr: stderr.toString() });
    });
  });
}

/** Whether `name` is on PATH, found without running it. */
export function commandExists(name: string): Promise<boolean> {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  return new Promise((done) => {
    execFile(finder, [name], { windowsHide: true }, (error) => done(!error));
  });
}
