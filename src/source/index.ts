// Scans for test *declarations* rather than using the line TestLocationResolver reports: that
// line comes from a stack trace, so only failing tests have one.

import { SOURCE_LANGUAGES } from '../languages';
import type { SourceLanguage, TestDeclaration } from './language';
import { maskWith } from './mask';

export type { SourceLanguage, TestDeclaration };
export { languageForFile } from '../languages';
export { sliceLines } from './text';
export { matchDeclaration, normalizeTestName } from './match';

export function scanTestDeclarations(text: string, language: SourceLanguage): TestDeclaration[] {
  return SOURCE_LANGUAGES[language].scanDeclarations(text);
}

export function maskCommentsAndStrings(text: string, language: SourceLanguage): string {
  return maskWith(text, SOURCE_LANGUAGES[language].lexer);
}
