import type { LexicalRules } from '../source/mask';
import { ATTRIBUTES, scanCLike, type CLikeDialect } from '../source/scanCLike';
import type { RunLanguageProfile, SourceLanguageProfile } from './types';

// Raw string literals (`"""…"""`) take backslashes literally.
const LEXER: LexicalRules = {
  lineComment: '//',
  blockComment: ['/*', '*/'],
  tripleQuoteEscapes: false,
  stringPrefixes: { '@': 'verbatim', $: 'plain' },
};

// Anchored to the start of a line, on the mask, so array/indexer syntax can't pose as an attribute.
const TEST_ATTRIBUTE =
  /^[ \t]*\[[ \t]*(?:[A-Za-z_]\w*[ \t]*\.[ \t]*)*(DataTestMethod|TestMethod|TestCase|Theory|Fact|Test)\b/gm;

const DIALECT: CLikeDialect = {
  lexer: LEXER,
  markers: ATTRIBUTES,
  testMarker: TEST_ATTRIBUTE,
  expressionBodyEnd: ';',
};

export const csharpSource: SourceLanguageProfile = {
  extensions: ['.cs'],
  lexer: LEXER,
  scanDeclarations: (text) => scanCLike(text, DIALECT),
  // The optional `<...>` keeps `Assert.Throws<DivideByZeroException>(…)` from slipping through.
  assertions:
    /\bAssert\s*\.\s*\w+\s*(?:<[^>()]*>)?\s*\(|\.\s*Should\s*\(\s*\)|\bMock\w*\s*\.\s*Verify\b|\bRecord\s*\.\s*Exception\s*\(/g,
  skipMarkers: [/\[\s*(?:[\w.]*\.)?Ignore\b/, /\bSkip\s*=\s*"/],
  skipInBody: [/\bAssert\s*\.\s*Ignore\s*\(/],
};

/** `at Ns.FooTests.Bar() in C:\src\FooTests.cs:line 42`. */
const FRAME = /\bin\s+(.+?):line\s+(\d+)/g;

export const dotnetRun: RunLanguageProfile = {
  defaultSourceLanguage: 'csharp',
  sourceExtensions: ['.cs'],
  sourceRoots: ['', 'src'],
  stackFrames: [{ pattern: FRAME, toFrame: (match) => ({ file: match[1].trim(), line: Number(match[2]) }) }],
};
