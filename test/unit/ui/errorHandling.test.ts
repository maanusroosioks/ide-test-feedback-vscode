import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CancelledError, MoodleSubmitError } from '../../../src/core/errors';
import { HttpError } from '../../../src/services/errors';
import { handleCommandError } from '../../../src/ui/errorHandling';
import { commands, resetVscodeStub, window } from '../helpers/vscodeStub';

function fakeStatus() {
  return { running: vi.fn(), result: vi.fn(), error: vi.fn(), idle: vi.fn() };
}

let logged: string[];
const logger = { log: (message: string) => void logged.push(message) };

beforeEach(() => {
  resetVscodeStub();
  logged = [];
});

describe('handleCommandError', () => {
  it('treats cancellation quietly: logged, status reset, no popup', () => {
    const status = fakeStatus();

    handleCommandError(new CancelledError(), logger, status);

    expect(logged).toEqual(['Run cancelled.']);
    expect(status.idle).toHaveBeenCalledOnce();
    expect(status.error).not.toHaveBeenCalled();
    expect(window.showErrorMessage).not.toHaveBeenCalled();
  });

  it('logs, flags the status bar and shows the user-facing message', () => {
    const status = fakeStatus();

    handleCommandError(new HttpError(503, 'maintenance'), logger, status);

    const message = 'Submission service returned 503: maintenance';
    expect(logged).toEqual([`Error: ${message}`]);
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

    await vi.waitFor(() => expect(commands.executeCommand).toHaveBeenCalledWith('moodleSubmit.showOutput'));
  });

  it('does nothing more when the popup is dismissed', async () => {
    handleCommandError(new MoodleSubmitError('bad'), logger, fakeStatus());
    await Promise.resolve();

    expect(commands.executeCommand).not.toHaveBeenCalled();
  });
});
