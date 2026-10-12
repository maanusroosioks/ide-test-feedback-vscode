import { beforeEach, describe, expect, it } from 'vitest';
import { CancelledError, MoodleSubmitError } from '../../../src/core/errors';
import { HttpError } from '../../../src/services/errors';
import { handleCommandError } from '../../../src/ui/errorHandling';
import { fakeStatus, recordingLogger, type RecordingLogger } from '../helpers/fakes';
import { commands, window } from '../helpers/vscodeStub';

/** Lets the `.then` on the popup's promise run, so a test can see what it did or didn't do. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

let logger: RecordingLogger;

beforeEach(() => {
  logger = recordingLogger();
});

describe('handleCommandError', () => {
  it('treats cancellation quietly: logged, status reset, no popup', () => {
    const status = fakeStatus();

    handleCommandError(new CancelledError(), logger, status);

    expect(logger.messages).toEqual(['Run cancelled.']);
    expect(status.idle).toHaveBeenCalledOnce();
    expect(status.error).not.toHaveBeenCalled();
    expect(window.showErrorMessage).not.toHaveBeenCalled();
  });

  it('logs, flags the status bar and shows the user-facing message', () => {
    const status = fakeStatus();

    handleCommandError(new HttpError(503, 'maintenance'), logger, status);

    const message = 'Submission service returned 503: maintenance';
    expect(logger.messages).toEqual([`Error: ${message}`]);
    expect(status.error).toHaveBeenCalledWith(message);
    expect(window.showErrorMessage).toHaveBeenCalledWith(message, 'Show Output');
  });

  it('handles non-Error throws', () => {
    const status = fakeStatus();

    handleCommandError('plain string', logger, status);

    expect(status.error).toHaveBeenCalledWith('plain string');
  });

  it('opens the log when the user picks Show Output', async () => {
    window.showErrorMessage.mockResolvedValueOnce('Show Output');

    handleCommandError(new MoodleSubmitError('bad'), logger, fakeStatus());

    await settle();

    expect(commands.executeCommand).toHaveBeenCalledWith('ideTestFeedback.showOutput');
  });

  it('does nothing more when the popup is dismissed', async () => {
    handleCommandError(new MoodleSubmitError('bad'), logger, fakeStatus());
    await settle();

    expect(commands.executeCommand).not.toHaveBeenCalled();
  });
});
