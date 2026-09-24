import { beforeEach, describe, expect, it } from 'vitest';
import {
  getAssignmentKeySetting,
  getAuthScopes,
  getPreferredAdapterId,
  getRequestTimeoutMs,
  getServiceUrl,
  getSourceCaptureSettings,
  getTestCommandOverrides,
  getWarnOnSuspiciousTests,
  setAssignmentKey,
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
    expect(getAssignmentKeySetting()).toBeUndefined();
    expect(getAuthScopes()).toEqual([]);
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

  it('trim the assignment key and treat a blank one as unset', () => {
    configValues.set('assignmentKey', '  assignment-7  ');
    expect(getAssignmentKeySetting()).toBe('assignment-7');

    configValues.set('assignmentKey', '   ');
    expect(getAssignmentKeySetting()).toBeUndefined();
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

describe('settings setters', () => {
  it('write to the workspace when a folder is open', async () => {
    workspace.workspaceFolders = [workspaceFolder('/work/project')];

    await setServiceUrl('https://bridge.example.edu');
    await setAssignmentKey('assignment-7');

    expect(configUpdate).toHaveBeenCalledWith('serviceUrl', 'https://bridge.example.edu', ConfigurationTarget.Workspace);
    expect(configUpdate).toHaveBeenCalledWith('assignmentKey', 'assignment-7', ConfigurationTarget.Workspace);
  });

  it('write to user settings when no folder is open', async () => {
    await setServiceUrl('https://bridge.example.edu');
    expect(configUpdate).toHaveBeenCalledWith('serviceUrl', 'https://bridge.example.edu', ConfigurationTarget.Global);

    workspace.workspaceFolders = [];
    await setAssignmentKey('assignment-7');
    expect(configUpdate).toHaveBeenCalledWith('assignmentKey', 'assignment-7', ConfigurationTarget.Global);
  });
});
