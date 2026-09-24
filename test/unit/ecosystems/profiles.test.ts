import { describe, expect, it } from 'vitest';
import { PLATFORMS, SOURCE_LANGUAGES } from '../../../src/ecosystems';

const sourceProfiles = Object.entries(SOURCE_LANGUAGES);
const platformProfiles = Object.entries(PLATFORMS);

describe('language profiles', () => {
  it('claims each file extension for at most one source language', () => {
    const extensions = sourceProfiles.flatMap(([, profile]) => profile.extensions);
    expect(new Set(extensions).size).toBe(extensions.length);
  });

  it('writes extensions lower-case with the dot, as languageForFile looks them up', () => {
    const all = [
      ...sourceProfiles.flatMap(([, profile]) => profile.extensions),
      ...platformProfiles.flatMap(([, profile]) => profile.sourceExtensions),
    ];
    for (const extension of all) {
      expect(extension).toMatch(/^\.[a-z0-9]+$/);
    }
  });

  // Otherwise the location resolver could never find that language's files to scan.
  it('hosts every source language on a platform that looks for its files', () => {
    for (const [language, profile] of sourceProfiles) {
      const hosts = platformProfiles.filter(([, run]) =>
        profile.extensions.every((extension) => run.sourceExtensions.includes(extension)),
      );
      expect(hosts, `no platform covers ${language}`).not.toHaveLength(0);
    }
  });

  it("covers the default source language's own files", () => {
    for (const [, run] of platformProfiles) {
      for (const extension of SOURCE_LANGUAGES[run.defaultSourceLanguage].extensions) {
        expect(run.sourceExtensions).toContain(extension);
      }
    }
  });

  it('marks every regex that is run in a loop as global', () => {
    for (const [, run] of platformProfiles) {
      for (const rule of run.stackFrames) expect(rule.pattern.global).toBe(true);
    }
    for (const [, profile] of sourceProfiles) {
      expect(profile.assertions.global).toBe(true);
      for (const pattern of profile.noopPatterns) expect(pattern.global).toBe(true);
    }
  });
});
