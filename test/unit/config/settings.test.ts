import { beforeEach, describe, expect, it } from 'vitest';
import {
  getAuthScopes,
  getPreferredAdapterId,
  getRequestTimeoutMs,
  getServiceUrl,
  getSourceCaptureSettings,
  getTestCommandOverrides,
  getWarnOnSuspiciousTests,
  setServiceUrl,
} from '../../../src/config/settings';
import {
  ConfigurationTarget,
  configUpdate,
  configValues,
  resetVscodeStub,
  workspace,
  workspaceFolder,
} from '../helpers/vscodeStub';

beforeEach(() => {
  resetVscodeStub();
});

describe('settings getters', () => {
  it('read from the moodleSubmit section', () => {
    configValues.set('serviceUrl', 'https://bridge.example.edu');

    expect(getServiceUrl()).toBe('https://bridge.example.edu');
    expect(workspace.getConfiguration).toHaveBeenCalledWith('moodleSubmit');
  });

  it('fall back to defaults when nothing is set', () => {
    expect(getServiceUrl()).toBe('');
    expect(getRequestTimeoutMs()).toBe(15000);
    expect(getAuthScopes()).toEqual(['User.Read']);
    expect(getTestCommandOverrides()).toEqual({});
    expect(getPreferredAdapterId()).toBeUndefined();
    expect(getWarnOnSuspiciousTests()).toBe(true);
    expect(getSourceCaptureSettings()).toEqual({ captureSource: true, maxTotalChars: 500_000 });
  });

  it('return configured values', () => {
    configValues.set('requestTimeoutMs', 3000);
    configValues.set('authScopes', ['api://bridge/.default']);
    configValues.set('testCommandOverrides', { pytest: 'pytest -q' });
    configValues.set('preferredAdapter', 'pytest');
    configValues.set('warnOnSuspiciousTests', false);

    expect(getRequestTimeoutMs()).toBe(3000);
    expect(getAuthScopes()).toEqual(['api://bridge/.default']);
    expect(getTestCommandOverrides()).toEqual({ pytest: 'pytest -q' });
    expect(getPreferredAdapterId()).toBe('pytest');
    expect(getWarnOnSuspiciousTests()).toBe(false);
  });
});

describe('getSourceCaptureSettings', () => {
  it('respects turning source capture off', () => {
    configValues.set('submitTestSource', false);
    expect(getSourceCaptureSettings().captureSource).toBe(false);
  });

  it('rounds a fractional limit down', () => {
    configValues.set('maxTotalSourceChars', 1234.9);
    expect(getSourceCaptureSettings().maxTotalChars).toBe(1234);
  });

  it('caps the limit so a huge setting cannot inflate submissions', () => {
    configValues.set('maxTotalSourceChars', 10_000_000);
    expect(getSourceCaptureSettings().maxTotalChars).toBe(1_000_000);
  });

  it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY, 'lots'])(
    'falls back to the default for %s',
    (value) => {
      configValues.set('maxTotalSourceChars', value);
      expect(getSourceCaptureSettings().maxTotalChars).toBe(500_000);
    },
  );
});

describe('getRequestTimeoutMs', () => {
  it('clamps the timeout into its allowed range', () => {
    configValues.set('requestTimeoutMs', 50);
    expect(getRequestTimeoutMs()).toBe(1_000);

    configValues.set('requestTimeoutMs', 10_000_000);
    expect(getRequestTimeoutMs()).toBe(120_000);
  });

  it.each([0, -5, Number.NaN, 'soon'])('falls back to the default for %s', (value) => {
    configValues.set('requestTimeoutMs', value);
    expect(getRequestTimeoutMs()).toBe(15_000);
  });
});

describe('setServiceUrl', () => {
  it('writes to user settings even when a folder is open', async () => {
    workspace.workspaceFolders = [workspaceFolder('/work/project')];

    await setServiceUrl('https://bridge.example.edu');

    expect(configUpdate).toHaveBeenCalledWith('serviceUrl', 'https://bridge.example.edu', ConfigurationTarget.Global);
  });
});
