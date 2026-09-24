import { ANNOTATIONS, scanCLike, type CLikeDialect, type LexicalRules } from '../../scanning';
import type { SourceLanguageProfile } from '../types';

const TEST_ANNOTATION =
  /@[ \t]*(?:[A-Za-z_]\w*[ \t]*\.[ \t]*)*(ParameterizedTest|RepeatedTest|TestFactory|TestTemplate|Test)\b/g;

interface JvmSourceOptions {
  extensions: string[];
  typeKeywords: string[];
  /** Where the languages' strings and comments part ways. */
  lexer: Omit<LexicalRules, 'lineComment' | 'blockComment'>;
  expressionBodyEnd: string;
  noopPatterns: RegExp[];
}

/** JVM languages differ in syntax, but run the same test frameworks and so share their markers. */
function jvmSource(options: JvmSourceOptions): SourceLanguageProfile {
  const dialect: CLikeDialect = {
    typeKeywords: options.typeKeywords,
    markers: ANNOTATIONS,
    testMarker: TEST_ANNOTATION,
    expressionBodyEnd: options.expressionBodyEnd,
  };
  return {
    extensions: options.extensions,
    lexer: {
      lineComment: '//',
      blockComment: ['/*', '*/'],
      ...options.lexer,
    },
    scanDeclarations: (text, masked) => scanCLike(text, masked, dialect),
    assertions: /\bassert[A-Z_]\w*\s*\(|\bassert\s*\(|\bfail\s*\(|\bverify\s*\(|\bshould[A-Z]\w*\b/g,
    skipMarkers: [/@\s*(?:[\w.]*\.)?(?:Disabled|Ignore)\b/],
    skipInBody: [],
    noopPatterns: options.noopPatterns,
  };
}

export const javaSource = jvmSource({
  extensions: ['.java'],
  typeKeywords: ['class', 'interface', 'record', 'enum'],
  lexer: { tripleQuoteEscapes: true },
  expressionBodyEnd: ';',
  noopPatterns: [/\bnull\b/g],
});

export const kotlinSource = jvmSource({
  extensions: ['.kt', '.kts'],
  // `enum class` and `data class` are reached through `class`.
  typeKeywords: ['class', 'interface', 'object'],
  lexer: {
    // `"""…"""` is a raw string.
    tripleQuoteEscapes: false,
    nestedBlockComments: true,
    templateOpener: '${',
    quotedIdentifier: '`',
  },
  // Statements need no `;`, so an expression body ends at the line break.
  expressionBodyEnd: ';\n',
  noopPatterns: [/\bnull\b/g, /\bUnit\b/g],
});
