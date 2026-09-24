// Everything language-specific lives in a profile here. Adding a language means adding its
// profiles to these two maps; the compiler rejects a union member left without one.

import type { RunLanguage } from '../core/types';
import type { SourceLanguage } from '../source/language';
import { csharpSource, dotnetRun } from './csharp';
import { javaSource } from './java';
import { jvmRun } from './jvm';
import { kotlinSource } from './kotlin';
import { pythonRun, pythonSource } from './python';
import type { RunLanguageProfile, SourceLanguageProfile } from './types';

export type { RunLanguageProfile, SourceLanguageProfile, StackFrame, StackFrameRule } from './types';

export const SOURCE_LANGUAGES: Record<SourceLanguage, SourceLanguageProfile> = {
  python: pythonSource,
  java: javaSource,
  kotlin: kotlinSource,
  csharp: csharpSource,
};

export const RUN_LANGUAGES: Record<RunLanguage, RunLanguageProfile> = {
  java: jvmRun,
  python: pythonRun,
  csharp: dotnetRun,
};

const LANGUAGE_BY_EXTENSION = new Map<string, SourceLanguage>(
  (Object.entries(SOURCE_LANGUAGES) as [SourceLanguage, SourceLanguageProfile][]).flatMap(
    ([language, profile]) => profile.extensions.map((extension) => [extension, language] as const),
  ),
);

/** A run's source extensions are wider than its languages' (`.kt` under `java`), so the file decides. */
export function languageForFile(filePath: string, runLanguage: RunLanguage): SourceLanguage {
  const dot = filePath.lastIndexOf('.');
  const extension = dot >= 0 ? filePath.slice(dot).toLowerCase() : '';
  return LANGUAGE_BY_EXTENSION.get(extension) ?? RUN_LANGUAGES[runLanguage].defaultSourceLanguage;
}
