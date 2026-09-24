// Language-agnostic source analysis. Everything specific to one language is in `../languages`,
// which configures these and is what the rest of the extension calls.

export type { TestDeclaration } from './types';
export { maskWith, type LexicalRules } from './mask';
export { ANNOTATIONS, ATTRIBUTES, type MarkerSyntax } from './markers';
export { scanCLike, type CLikeDialect } from './scanCLike';
export { scanPython } from './scanPython';
export { sliceLines } from './text';
export { matchDeclaration, normalizeTestName } from './match';
