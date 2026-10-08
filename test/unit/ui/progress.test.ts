import { describe, expect, it } from 'vitest';
import { withProgress } from '../../../src/ui/progress';
import { ProgressLocation, progress, window } from '../helpers/vscodeStub';

describe('withProgress', () => {
  it('shows a cancellable notification and returns the task result', async () => {
    const result = await withProgress('Moodle Submit', async () => 42);

    expect(result).toBe(42);
    expect(window.withProgress.mock.calls[0][0]).toEqual({
      location: ProgressLocation.Notification,
      title: 'Moodle Submit',
      cancellable: true,
    });
  });

  it('forwards report messages to the notification', async () => {
    await withProgress('Moodle Submit', async (handle) => {
      handle.report('Running tests…');
    });

    expect(progress.report).toHaveBeenCalledWith({ message: 'Running tests…' });
  });

  it('aborts the signal when the user cancels the notification', async () => {
    let signal: AbortSignal | undefined;

    await withProgress('Moodle Submit', async (handle) => {
      signal = handle.signal;
      expect(signal.aborted).toBe(false);
      progress.cancel();
    });

    expect(signal?.aborted).toBe(true);
  });

  it('stops listening for cancellation once the task settles, even on failure', async () => {
    let signal: AbortSignal | undefined;

    await expect(
      withProgress('Moodle Submit', async (handle) => {
        signal = handle.signal;
        throw new Error('task failed');
      }),
    ).rejects.toThrow('task failed');
    progress.cancel();

    expect(signal?.aborted).toBe(false);
  });
});
