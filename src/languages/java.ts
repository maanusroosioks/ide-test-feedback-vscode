import type { LexicalRules } from '../source/mask';
import { ANNOTATIONS, scanCLike, type CLikeDialect } from '../source/scanCLike';
import { JVM_ASSERTIONS, JVM_SKIP_MARKERS, JVM_TEST_ANNOTATION } from './jvm';
import type { SourceLanguageProfile } from './types';

const LEXER: LexicalRules = { lineComment: '//', blockComment: ['/*', '*/'], tripleQuoteEscapes: true };

const DIALECT: CLikeDialect = {
  lexer: LEXER,
  markers: ANNOTATIONS,
  testMarker: JVM_TEST_ANNOTATION,
  expressionBodyEnd: ';',
};

export const javaSource: SourceLanguageProfile = {
  extensions: ['.java'],
  lexer: LEXER,
  scanDeclarations: (text) => scanCLike(text, DIALECT),
  assertions: JVM_ASSERTIONS,
  skipMarkers: JVM_SKIP_MARKERS,
  skipInBody: [],
};
