import { ANNOTATIONS, scanCLike, type CLikeDialect } from '../source';
import type { PlatformProfile, SourceLanguageProfile } from './types';

// ------------------------------------------------------------- source languages ----

const TEST_ANNOTATION =
  /@[ \t]*(?:[A-Za-z_]\w*[ \t]*\.[ \t]*)*(ParameterizedTest|RepeatedTest|TestFactory|TestTemplate|Test)\b/g;

interface JvmSourceOptions {
  extensions: string[];
  /** False where `"""…"""` is a raw string. */
  tripleQuoteEscapes: boolean;
  expressionBodyEnd: string;
  noopPatterns: RegExp[];
}

/** JVM languages differ in syntax, but run the same test frameworks and so share their markers. */
function jvmSource({ extensions, tripleQuoteEscapes, expressionBodyEnd, noopPatterns }: JvmSourceOptions): SourceLanguageProfile {
  const dialect: CLikeDialect = { markers: ANNOTATIONS, testMarker: TEST_ANNOTATION, expressionBodyEnd };
  return {
    extensions,
    lexer: { lineComment: '//', blockComment: ['/*', '*/'], tripleQuoteEscapes },
    scanDeclarations: (text, masked) => scanCLike(text, masked, dialect),
    assertions: /\bassert[A-Z_]\w*\s*\(|\bassert\s*\(|\bfail\s*\(|\bverify\s*\(|\bshould[A-Z]\w*\b/g,
    skipMarkers: [/@\s*(?:[\w.]*\.)?(?:Disabled|Ignore)\b/],
    skipInBody: [],
    noopPatterns,
  };
}

export const javaSource = jvmSource({
  extensions: ['.java'],
  tripleQuoteEscapes: true,
  expressionBodyEnd: ';',
  noopPatterns: [/\bnull\b/g],
});

export const kotlinSource = jvmSource({
  extensions: ['.kt', '.kts'],
  tripleQuoteEscapes: false,
  // Statements need no `;`, so an expression body ends at the line break.
  expressionBodyEnd: ';\n',
  noopPatterns: [/\bnull\b/g, /\bUnit\b/g],
});

// ---------------------------------------------------------------------- platform ----

const SOURCE_EXTENSIONS = ['.java', '.kt', '.kts', '.scala', '.groovy'];

/** `at app//com.pkg.FooTest.bar(FooTest.java:42)` — the `app//` prefix is optional. */
const FRAME = /\bat\s+([^\s(]+)\(([^()]+):(\d+)\)/g;

function className(qualified: string): string | undefined {
  const afterModule = qualified.slice(qualified.lastIndexOf('/') + 1);
  const lastDot = afterModule.lastIndexOf('.');
  return lastDot > 0 ? afterModule.slice(0, lastDot) : undefined;
}

export const jvmPlatform: PlatformProfile = {
  defaultSourceLanguage: 'java',
  sourceExtensions: SOURCE_EXTENSIONS,
  sourceRoots: [
    'src/test/java',
    'src/main/java',
    'src/test/kotlin',
    'src/main/kotlin',
    'src/test/scala',
    'src/main/scala',
    'src',
    '',
  ],
  stackFrames: [
    {
      pattern: FRAME,
      toFrame(match) {
        const file = match[2];
        if (!SOURCE_EXTENSIONS.some((ext) => file.toLowerCase().endsWith(ext))) return undefined;
        return { className: className(match[1]), file, line: Number(match[3]) };
      },
    },
  ],
};
