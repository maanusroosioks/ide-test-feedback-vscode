import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALL_ADAPTERS, ECOSYSTEMS } from '../../../src/ecosystems';

const packageJson = JSON.parse(readFileSync(join(__dirname, '../../../package.json'), 'utf8'));

describe('ALL_ADAPTERS', () => {
  it('gives every adapter its own id', () => {
    const ids = ALL_ADAPTERS.map((adapter) => adapter.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('matches the preferredAdapter setting offered in package.json', () => {
    const setting = packageJson.contributes.configuration.properties['moodleSubmit.preferredAdapter'];
    expect(setting.enum).toEqual(ALL_ADAPTERS.map((adapter) => adapter.id));
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
