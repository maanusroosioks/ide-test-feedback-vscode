import type { RunLanguageProfile } from './types';

// Shared by every JVM source language: they run the same test frameworks.

export const JVM_TEST_ANNOTATION =
  /@[ \t]*(?:[A-Za-z_]\w*[ \t]*\.[ \t]*)*(ParameterizedTest|RepeatedTest|TestFactory|TestTemplate|Test)\b/g;

export const JVM_ASSERTIONS = /\bassert[A-Z_]\w*\s*\(|\bassert\s*\(|\bfail\s*\(|\bverify\s*\(|\bshould[A-Z]\w*\b/g;

export const JVM_SKIP_MARKERS = [/@\s*(?:[\w.]*\.)?(?:Disabled|Ignore)\b/];

const SOURCE_EXTENSIONS = ['.java', '.kt', '.kts', '.scala', '.groovy'];

/** `at app//com.pkg.FooTest.bar(FooTest.java:42)` — the `app//` prefix is optional. */
const FRAME = /\bat\s+([^\s(]+)\(([^()]+):(\d+)\)/g;

function className(qualified: string): string | undefined {
  const afterModule = qualified.slice(qualified.lastIndexOf('/') + 1);
  const lastDot = afterModule.lastIndexOf('.');
  return lastDot > 0 ? afterModule.slice(0, lastDot) : undefined;
}

export const jvmRun: RunLanguageProfile = {
  defaultSourceLanguage: 'java',
  sourceExtensions: SOURCE_EXTENSIONS,
  sourceRoots: [
    'src/test/java',
    'src/main/java',
    'src/test/kotlin',
    'src/main/kotlin',
    'src/test/scala',
    'src/main/scala',
    'src',
    '',
  ],
  stackFrames: [
    {
      pattern: FRAME,
      toFrame(match) {
        const file = match[2];
        if (!SOURCE_EXTENSIONS.some((ext) => file.toLowerCase().endsWith(ext))) return undefined;
        return { className: className(match[1]), file, line: Number(match[3]) };
      },
    },
  ],
};
