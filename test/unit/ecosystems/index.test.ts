import { posix } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALL_ADAPTERS, ECOSYSTEMS } from '../../../src/ecosystems';
import { tempDir, writeTree } from '../helpers/fs';
import { packageJson } from '../helpers/project';

describe('ALL_ADAPTERS', () => {
  it('gives every adapter its own id', () => {
    const ids = ALL_ADAPTERS.map((adapter) => adapter.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('matches the preferredAdapter setting offered in package.json', () => {
    const setting = packageJson.contributes.configuration.find((section) => 'moodleSubmit.preferredAdapter' in section.properties)!
      .properties['moodleSubmit.preferredAdapter'];
    expect(setting.enum).toEqual(ALL_ADAPTERS.map((adapter) => adapter.id));
  });

  describe('activation', () => {
    // One file per way an adapter recognises a project.
    const LAYOUTS = [
      'pom.xml',
      'build.gradle',
      'build.gradle.kts',
      'settings.gradle',
      'settings.gradle.kts',
      'pytest.ini',
      'pyproject.toml',
      'setup.cfg',
      'conftest.py',
      'test_calc.py',
      'calc_test.py',
      'tests/test_calc.py',
      'tests/calc_test.py',
      'test/test_calc.py',
      'test/calc_test.py',
      'App.csproj',
      'App.sln',
      'App.slnx',
      'App.Tests/App.Tests.csproj',
    ];
    const PATTERNS = packageJson.activationEvents
      .filter((event) => event.startsWith('workspaceContains:'))
      .map((event) => event.slice('workspaceContains:'.length));

    it.each(LAYOUTS)('activates in a folder holding %s, which an adapter detects', async (file) => {
      const folder = await tempDir();
      await writeTree(folder, { [file]: '' });

      const detected = await Promise.all(ALL_ADAPTERS.map((adapter) => adapter.detect(folder)));
      expect(detected).toContain(true);
      expect(PATTERNS.some((pattern) => posix.matchesGlob(file, pattern))).toBe(true);
    });

    it('activates for no layout an adapter would not run, beyond the config file', () => {
      const unused = PATTERNS.filter(
        (pattern) => pattern !== '.moodle-submit.json' && !LAYOUTS.some((file) => posix.matchesGlob(file, pattern)),
      );
      expect(unused).toEqual([]);
    });
  });
});

describe('ECOSYSTEMS', () => {
  // An adapter's platform decides which stack-frame rules and source roots its results are read with.
  it('holds only adapters that run on its own platform', () => {
    for (const [platform, ecosystem] of Object.entries(ECOSYSTEMS)) {
      for (const adapter of ecosystem.adapters) expect(adapter.platform, adapter.id).toBe(platform);
    }
  });

  // SOURCE_LANGUAGES merges them, so a second claim would silently replace the first.
  it('gives each source language to one ecosystem', () => {
    const languages = Object.values(ECOSYSTEMS).flatMap((ecosystem) => Object.keys(ecosystem.languages));
    expect(new Set(languages).size).toBe(languages.length);
  });

  it('hosts its own default source language', () => {
    for (const [platform, ecosystem] of Object.entries(ECOSYSTEMS)) {
      expect(Object.keys(ecosystem.languages), platform).toContain(ecosystem.platform.defaultSourceLanguage);
    }
  });
});
