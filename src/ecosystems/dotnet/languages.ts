import { ATTRIBUTES, scanCLike, type CLikeDialect } from '../../scanning';
import type { SourceLanguageProfile } from '../types';

// Anchored to the start of a line, on the mask, so array/indexer syntax can't pose as an attribute.
// The test attribute may follow others in its list (`[Trait("a", "b"), Fact]`) and may be spelled
// out (`[FactAttribute]`). NUnit's `[TestCaseSource]` makes a test without `[Test]`.
const TEST_ATTRIBUTE =
  /^[ \t]*\[(?:[^\]\n]*,)?[ \t]*(?:[A-Za-z_]\w*[ \t]*\.[ \t]*)*(DataTestMethod|TestMethod|TestCaseSource|TestCase|Theory|Fact|Test)(?:Attribute)?\b/gm;

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
    tripleQuoteEscapes: false,
    stringPrefixes: { '@': 'verbatim', $: 'interpolated' },
  },
  scanDeclarations: (text, masked) => scanCLike(text, masked, CSHARP_DIALECT),
  // The optional `<...>` keeps `Assert.Throws<DivideByZeroException>(…)` from slipping through.
  assertions:
    /\bAssert\s*\.\s*\w+\s*(?:<[^>()]*>)?\s*\(|\.\s*Should\s*\(\s*\)|\bMock\w*\s*\.\s*Verify\b|\bRecord\s*\.\s*Exception\s*\(/g,
  skipMarkers: [/\[\s*(?:[\w.]*\.)?Ignore\b/, /\bSkip\s*=\s*"/],
  skipInBody: [/\bAssert\s*\.\s*Ignore\s*\(/],
  noopPatterns: [/\bTask\s*\.\s*(?:CompletedTask|FromResult\s*\(\s*\))/g, /\bnull\b/g],
};
