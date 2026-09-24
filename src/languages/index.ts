// Everything language-specific lives in a profile here. Adding a language means adding its
// profiles to these two maps; the compiler rejects a union member left without one.

import type { Platform } from '../core/types';
import { maskWith, type TestDeclaration } from '../source';
import { csharpSource, dotnetPlatform } from './dotnet';
import { javaSource, jvmPlatform, kotlinSource } from './jvm';
import { pythonPlatform, pythonSource } from './python';
import type { PlatformProfile, SourceLanguage, SourceLanguageProfile } from './types';

export type {
  PlatformProfile,
  SourceLanguage,
  SourceLanguageProfile,
  StackFrame,
  StackFrameRule,
} from './types';

export const SOURCE_LANGUAGES: Record<SourceLanguage, SourceLanguageProfile> = {
  python: pythonSource,
  java: javaSource,
  kotlin: kotlinSource,
  csharp: csharpSource,
};

export const PLATFORMS: Record<Platform, PlatformProfile> = {
  jvm: jvmPlatform,
  python: pythonPlatform,
  dotnet: dotnetPlatform,
};

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
