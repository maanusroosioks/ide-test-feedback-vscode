import { beforeEach, describe, expect, it } from 'vitest';
import {
  ensureConfigured,
  isConfigured,
  maybePromptOnboarding,
  openSetupWalkthrough,
  refreshConfiguredContext,
} from '../../../src/ui/onboarding';
import {
  asContext,
  commands,
  configValues,
  fakeExtensionContext,
  window,
  type FakeExtensionContext,
} from '../helpers/vscodeStub';

const DISMISSED_KEY = 'ideTestFeedback.onboardingDismissed';
const WALKTHROUGH = ['workbench.action.openWalkthrough', 'example.moodle-test-submit#setup', false];

let context: FakeExtensionContext;

beforeEach(() => {
  context = fakeExtensionContext();
});

describe('isConfigured', () => {
  it('requires a non-blank service URL', () => {
    expect(isConfigured()).toBe(false);
    configValues.set('serviceUrl', '   ');
    expect(isConfigured()).toBe(false);
    configValues.set('serviceUrl', 'https://bridge.example.edu');
    expect(isConfigured()).toBe(true);
  });
});

describe('refreshConfiguredContext', () => {
  it('mirrors the configured state into a context key', () => {
    refreshConfiguredContext();
    configValues.set('serviceUrl', 'https://bridge.example.edu');
    refreshConfiguredContext();

    expect(commands.executeCommand.mock.calls).toEqual([
      ['setContext', 'ideTestFeedback.configured', false],
      ['setContext', 'ideTestFeedback.configured', true],
    ]);
  });
});

describe('openSetupWalkthrough', () => {
  it("opens this extension's setup walkthrough", async () => {
    await openSetupWalkthrough(asContext(context));

    expect(commands.executeCommand).toHaveBeenCalledWith(...WALKTHROUGH);
  });
});

describe('maybePromptOnboarding', () => {
  it('stays silent once configured', async () => {
    configValues.set('serviceUrl', 'https://bridge.example.edu');

    await maybePromptOnboarding(asContext(context));

    expect(window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('stays silent once dismissed', async () => {
    await context.globalState.update(DISMISSED_KEY, true);

    await maybePromptOnboarding(asContext(context));

    expect(window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('opens the walkthrough on "Start setup"', async () => {
    window.showInformationMessage.mockResolvedValueOnce('Start setup');

    await maybePromptOnboarding(asContext(context));

    expect(commands.executeCommand).toHaveBeenCalledWith(...WALKTHROUGH);
    expect(context.globalState.get(DISMISSED_KEY)).toBeUndefined();
  });

  it('remembers "Don\'t ask again"', async () => {
    window.showInformationMessage.mockResolvedValueOnce("Don't ask again");

    await maybePromptOnboarding(asContext(context));

    expect(context.globalState.get(DISMISSED_KEY)).toBe(true);
    expect(commands.executeCommand).not.toHaveBeenCalled();
  });

  it('asks again next time when the prompt is just closed', async () => {
    await maybePromptOnboarding(asContext(context));

    expect(context.globalState.get(DISMISSED_KEY)).toBeUndefined();
  });
});

describe('ensureConfigured', () => {
  it('proceeds without asking when already configured', async () => {
    configValues.set('serviceUrl', 'https://bridge.example.edu');

    expect(await ensureConfigured(asContext(context))).toBe(true);
    expect(window.showWarningMessage).not.toHaveBeenCalled();
  });

  it('proceeds when "Configure now" leaves a service URL behind', async () => {
    window.showWarningMessage.mockResolvedValueOnce('Configure now');
    commands.executeCommand.mockImplementationOnce(async () => {
      configValues.set('serviceUrl', 'https://bridge.example.edu');
    });

    expect(await ensureConfigured(asContext(context))).toBe(true);
    expect(commands.executeCommand).toHaveBeenCalledWith('ideTestFeedback.configureAssignment');
  });

  it('stops when configuration was abandoned', async () => {
    window.showWarningMessage.mockResolvedValueOnce('Configure now');

    expect(await ensureConfigured(asContext(context))).toBe(false);
  });

  it('opens the walkthrough on "Open setup" and stops', async () => {
    window.showWarningMessage.mockResolvedValueOnce('Open setup');

    expect(await ensureConfigured(asContext(context))).toBe(false);
    expect(commands.executeCommand).toHaveBeenCalledWith(...WALKTHROUGH);
  });

  it('stops quietly when dismissed', async () => {
    expect(await ensureConfigured(asContext(context))).toBe(false);
    expect(commands.executeCommand).not.toHaveBeenCalled();
  });

  it('flags a URL that submission would refuse before any tests run', async () => {
    configValues.set('serviceUrl', 'http://bridge.example.edu');

    expect(await ensureConfigured(asContext(context))).toBe(false);
    expect(window.showWarningMessage).toHaveBeenCalledWith(
      "The Moodle submission service URL can't be used: The URL must use https:// (http:// is only allowed for localhost).",
      'Configure now',
      'Open setup',
    );
  });

  it('proceeds once "Configure now" has fixed an unusable URL', async () => {
    configValues.set('serviceUrl', 'http://bridge.example.edu');
    window.showWarningMessage.mockResolvedValueOnce('Configure now');
    commands.executeCommand.mockImplementationOnce(async () => {
      configValues.set('serviceUrl', 'https://bridge.example.edu');
    });

    expect(await ensureConfigured(asContext(context))).toBe(true);
  });
});
