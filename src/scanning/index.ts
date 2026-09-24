// Shared engines and helpers for reading test source. Some serve only one language (scanPython) or
// carry harmless supersets (backtick names in scanCLike), but nothing here has to change to add a
// language: everything that varies is configured by a profile in `../ecosystems`, which is also
// what the rest of the extension calls.

export type { TestDeclaration } from './types';
export { maskWith, type LexicalRules } from './mask';
export { ANNOTATIONS, ATTRIBUTES, type MarkerSyntax } from './markers';
export { scanCLike, type CLikeDialect } from './scanCLike';
export { scanPython } from './scanPython';
export { sliceLines } from './text';
export { matchDeclaration, normalizeTestName } from './match';
