// The one door into ecosystem knowledge: the rest of the extension imports from here, never from an
// ecosystem's own files. Adding an ecosystem means adding its folder, its entry in ECOSYSTEMS, and
// its names to the Platform and SourceLanguage unions; the compiler rejects a name left without a
// profile.

import type { Platform } from '../core/types';
import type { TestRunnerAdapter } from '../runner/types';
import { maskWith, type TestDeclaration } from '../scanning';
import { dotnetEcosystem } from './dotnet';
import { jvmEcosystem } from './jvm';
import { pythonEcosystem } from './python';
import type { Ecosystem, PlatformProfile, SourceLanguage, SourceLanguageProfile } from './types';

export type {
  Ecosystem,
  PlatformProfile,
  SourceLanguage,
  SourceLanguageProfile,
  StackFrame,
  StackFrameRule,
} from './types';

/** In adapter detection priority order. */
export const ECOSYSTEMS = {
  jvm: jvmEcosystem,
  python: pythonEcosystem,
  dotnet: dotnetEcosystem,
} satisfies Record<Platform, Ecosystem>;

type HostedLanguage = { [P in Platform]: keyof (typeof ECOSYSTEMS)[P]['languages'] }[Platform];

/**
 * The first match wins when there is no picker. Each id must also be listed in
 * `moodleSubmit.preferredAdapter`'s enum in package.json — a unit test checks that.
 */
export const ALL_ADAPTERS: readonly TestRunnerAdapter[] = Object.values(ECOSYSTEMS).flatMap(
  (ecosystem) => ecosystem.adapters,
);

export const PLATFORMS = Object.fromEntries(
  Object.entries(ECOSYSTEMS).map(([platform, ecosystem]) => [platform, ecosystem.platform]),
) as Record<Platform, PlatformProfile>;

// Casting to the hosted languages, not to SourceLanguage, keeps the assignment checked: a
// SourceLanguage no ecosystem hosts is a missing property.
export const SOURCE_LANGUAGES: Record<SourceLanguage, SourceLanguageProfile> = Object.assign(
  {},
  ...Object.values(ECOSYSTEMS).map((ecosystem) => ecosystem.languages),
) as Record<HostedLanguage, SourceLanguageProfile>;

/** The languages a platform's tests may be written in. */
export function languagesOf(platform: Platform): SourceLanguage[] {
  return Object.keys(ECOSYSTEMS[platform].languages) as SourceLanguage[];
}

const LANGUAGE_BY_EXTENSION = new Map<string, SourceLanguage>(
  (Object.entries(SOURCE_LANGUAGES) as [SourceLanguage, SourceLanguageProfile][]).flatMap(
    ([language, profile]) => profile.extensions.map((extension) => [extension, language] as const),
  ),
);

/** A platform's source extensions are wider than its languages' (`.scala` on the JVM), so the file decides. */
export function languageForFile(filePath: string, platform: Platform): SourceLanguage {
  const dot = filePath.lastIndexOf('.');
  const extension = dot >= 0 ? filePath.slice(dot).toLowerCase() : '';
  return LANGUAGE_BY_EXTENSION.get(extension) ?? PLATFORMS[platform].defaultSourceLanguage;
}

export function maskCommentsAndStrings(text: string, language: SourceLanguage): string {
  return maskWith(text, SOURCE_LANGUAGES[language].lexer);
}

/**
 * Scans for test *declarations* rather than using the line TestLocationResolver reports: that
 * line comes from a stack trace, so only failing tests have one.
 */
export function scanTestDeclarations(text: string, language: SourceLanguage): TestDeclaration[] {
  const profile = SOURCE_LANGUAGES[language];
  return profile.scanDeclarations(text, maskWith(text, profile.lexer));
}
