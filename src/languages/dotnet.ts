import { ATTRIBUTES, scanCLike, type CLikeDialect } from '../source';
import type { PlatformProfile, SourceLanguageProfile } from './types';

// ------------------------------------------------------------- source languages ----

// Anchored to the start of a line, on the mask, so array/indexer syntax can't pose as an attribute.
const TEST_ATTRIBUTE =
  /^[ \t]*\[[ \t]*(?:[A-Za-z_]\w*[ \t]*\.[ \t]*)*(DataTestMethod|TestMethod|TestCase|Theory|Fact|Test)\b/gm;

const CSHARP_DIALECT: CLikeDialect = {
  typeKeywords: ['class', 'interface', 'record', 'struct', 'enum'],
  markers: ATTRIBUTES,
  testMarker: TEST_ATTRIBUTE,
  expressionBodyEnd: ';',
};

export const csharpSource: SourceLanguageProfile = {
  extensions: ['.cs'],
  lexer: {
    lineComment: '//',
    blockComment: ['/*', '*/'],
    // Raw string literals (`"""…"""`) take backslashes literally.
    tripleQuoteEscapes: false,
    stringPrefixes: { '@': 'verbatim', $: 'plain' },
  },
  scanDeclarations: (text, masked) => scanCLike(text, masked, CSHARP_DIALECT),
  // The optional `<...>` keeps `Assert.Throws<DivideByZeroException>(…)` from slipping through.
  assertions:
    /\bAssert\s*\.\s*\w+\s*(?:<[^>()]*>)?\s*\(|\.\s*Should\s*\(\s*\)|\bMock\w*\s*\.\s*Verify\b|\bRecord\s*\.\s*Exception\s*\(/g,
  skipMarkers: [/\[\s*(?:[\w.]*\.)?Ignore\b/, /\bSkip\s*=\s*"/],
  skipInBody: [/\bAssert\s*\.\s*Ignore\s*\(/],
  noopPatterns: [/\bTask\s*\.\s*(?:CompletedTask|FromResult\s*\(\s*\))/g, /\bnull\b/g],
};

// ---------------------------------------------------------------------- platform ----

/** `at Ns.FooTests.Bar() in C:\src\FooTests.cs:line 42`. */
const FRAME = /\bin\s+(.+?):line\s+(\d+)/g;

export const dotnetPlatform: PlatformProfile = {
  defaultSourceLanguage: 'csharp',
  sourceExtensions: ['.cs'],
  sourceRoots: ['', 'src'],
  stackFrames: [{ pattern: FRAME, toFrame: (match) => ({ file: match[1].trim(), line: Number(match[2]) }) }],
};
