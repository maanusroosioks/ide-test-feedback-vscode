import { describe, expect, it } from 'vitest';
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
  Uri,
  configUpdate,
  configValues,
  workspace,
  workspaceFolder,
} from '../helpers/vscodeStub';

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

describe('getTestCommandOverrides', () => {
  it('drops blank and non-string commands, which would leave only the report flags to run', () => {
    configValues.set('testCommandOverrides', { pytest: '  ', 'maven-junit': 42, 'gradle-junit': ' gradle test ' });

    expect(getTestCommandOverrides()).toEqual({ 'gradle-junit': 'gradle test' });
  });

  it('ignores a value that is not an object', () => {
    configValues.set('testCommandOverrides', 'mvn test');

    expect(getTestCommandOverrides()).toEqual({});
  });
});

describe('folder-scoped settings', () => {
  it.each([
    ['getPreferredAdapterId', () => getPreferredAdapterId('/work/api')],
    ['getTestCommandOverrides', () => getTestCommandOverrides('/work/api')],
    ['getSourceCaptureSettings', () => getSourceCaptureSettings('/work/api')],
    ['getWarnOnSuspiciousTests', () => getWarnOnSuspiciousTests('/work/api')],
  ])("%s reads the folder's own value in a multi-root workspace", (_name, read) => {
    read();

    expect(workspace.getConfiguration).toHaveBeenCalledWith('moodleSubmit', Uri.file('/work/api'));
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
