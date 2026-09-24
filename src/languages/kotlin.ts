import type { LexicalRules } from '../source/mask';
import { ANNOTATIONS, scanCLike, type CLikeDialect } from '../source/scanCLike';
import { JVM_ASSERTIONS, JVM_SKIP_MARKERS, JVM_TEST_ANNOTATION } from './jvm';
import type { SourceLanguageProfile } from './types';

// Raw strings (`"""…"""`) take backslashes literally.
const LEXER: LexicalRules = { lineComment: '//', blockComment: ['/*', '*/'], tripleQuoteEscapes: false };

const DIALECT: CLikeDialect = {
  lexer: LEXER,
  markers: ANNOTATIONS,
  testMarker: JVM_TEST_ANNOTATION,
  // Statements need no `;`, so an expression body ends at the line break.
  expressionBodyEnd: ';\n',
};

export const kotlinSource: SourceLanguageProfile = {
  extensions: ['.kt', '.kts'],
  lexer: LEXER,
  scanDeclarations: (text) => scanCLike(text, DIALECT),
  assertions: JVM_ASSERTIONS,
  skipMarkers: JVM_SKIP_MARKERS,
  skipInBody: [],
};
