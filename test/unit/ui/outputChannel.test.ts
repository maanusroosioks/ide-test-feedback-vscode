import { describe, expect, it, vi } from 'vitest';

// The channel is a module-level singleton, so each test loads fresh modules — the stub included,
// so the test and the module under test share one instance.
async function loadModules() {
  vi.resetModules();
  const vscode = await vi.importActual<typeof import('../helpers/vscodeStub')>('../helpers/vscodeStub');
  const outputChannel = await vi.importActual<typeof import('../../../src/ui/outputChannel')>(
    '../../../src/ui/outputChannel',
  );
  return { window: vscode.window, ...outputChannel };
}

describe('getOutputChannel', () => {
  it('creates the channel once and reuses it', async () => {
    const { getOutputChannel, window } = await loadModules();

    const first = getOutputChannel();
    const second = getOutputChannel();

    expect(first).toBe(second);
    expect(window.createOutputChannel).toHaveBeenCalledOnce();
    expect(window.createOutputChannel).toHaveBeenCalledWith('IDE Test Feedback');
  });
});

describe('createOutputChannelLogger', () => {
  it('appends timestamped lines', async () => {
    const { createOutputChannelLogger, getOutputChannel } = await loadModules();

    createOutputChannelLogger().log('Detected adapter: pytest');

    const appendLine = vi.mocked(getOutputChannel().appendLine);
    expect(appendLine).toHaveBeenCalledOnce();
    expect(appendLine.mock.calls[0][0]).toMatch(/^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] Detected adapter: pytest$/);
  });

  it('skips empty messages, such as a tool that printed nothing', async () => {
    const { createOutputChannelLogger, window } = await loadModules();

    createOutputChannelLogger().log('');

    expect(window.createOutputChannel).not.toHaveBeenCalled();
  });
});
