import { describe, expect, it } from 'vitest';
import { activate } from '../../src/extension';
import { getOutputChannel } from '../../src/ui/outputChannel';
import { packageJson } from './helpers/project';
import {
  asContext,
  commands,
  configValues,
  fakeExtensionContext,
  registeredCommands,
  tests,
  window,
  workspace,
} from './helpers/vscodeStub';

const DECLARED_COMMANDS = packageJson.contributes.commands.map((entry) => entry.command);

type ConfigListener = (event: { affectsConfiguration(section: string): boolean }) => void;

function configChanged(section: string): void {
  const listener = workspace.onDidChangeConfiguration.mock.calls[0][0] as ConfigListener;
  listener({ affectsConfiguration: (changed) => changed === section });
}

function contextKeyUpdates(): unknown[] {
  return commands.executeCommand.mock.calls.filter(([id]) => id === 'setContext').map((call) => call[2]);
}

describe('activate', () => {
  it('registers every command declared in package.json', () => {
    activate(asContext(fakeExtensionContext()));

    expect([...registeredCommands.keys()].sort()).toEqual([...DECLARED_COMMANDS].sort());
  });

  it('sets up the test controller, output channel and status bar', () => {
    const context = fakeExtensionContext();

    activate(asContext(context));

    expect(tests.createTestController).toHaveBeenCalledOnce();
    expect(window.createStatusBarItem).toHaveBeenCalledOnce();
    // Everything it creates is handed to VS Code to dispose on deactivation.
    const created = [
      getOutputChannel(),
      tests.createTestController.mock.results[0].value,
      workspace.onDidChangeConfiguration.mock.results[0].value,
      ...commands.registerCommand.mock.results.map((result) => result.value),
    ];
    for (const disposable of created) {
      expect(context.subscriptions).toContain(disposable);
    }
  });

  it('publishes the configured state and keeps it in sync with the service URL', () => {
    activate(asContext(fakeExtensionContext()));
    expect(contextKeyUpdates()).toEqual([false]);

    configValues.set('serviceUrl', 'https://bridge.example.edu');
    configChanged('moodleSubmit.requestTimeoutMs');
    expect(contextKeyUpdates()).toEqual([false]);

    configChanged('moodleSubmit.serviceUrl');
    expect(contextKeyUpdates()).toEqual([false, true]);
  });

  it('nudges an unconfigured install towards setup', () => {
    activate(asContext(fakeExtensionContext()));

    expect(window.showInformationMessage).toHaveBeenCalledWith(
      'Moodle Test Submit needs a one-time setup before you can submit results.',
      'Start setup',
      "Don't ask again",
    );
  });

  it('stays quiet once configured', () => {
    configValues.set('serviceUrl', 'https://bridge.example.edu');

    activate(asContext(fakeExtensionContext()));

    expect(window.showInformationMessage).not.toHaveBeenCalled();
  });
});
