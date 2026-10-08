import { scanPython } from '../../scanning';
import type { SourceLanguageProfile } from '../types';

export const pythonSource: SourceLanguageProfile = {
  extensions: ['.py'],
  lexer: {
    lineComment: '#',
    tripleQuoteEscapes: true,
    // f- and t-strings open code at `{`, which since 3.12 may reuse the enclosing quote.
    stringPrefixes: {
      f: 'interpolated',
      F: 'interpolated',
      t: 'interpolated',
      T: 'interpolated',
      r: 'plain',
      R: 'plain',
      b: 'plain',
      B: 'plain',
      u: 'plain',
      U: 'plain',
    },
  },
  scanDeclarations: scanPython,
  assertions:
    /(?:^|[^.\w])assert\b|\bself\s*\.\s*(?:assert\w+|fail)\s*\(|\bpytest\s*\.\s*(?:raises|fail)\s*\(|\b(?:np|numpy)\s*\.\s*testing\s*\.\s*assert_\w+\s*\(/g,
  // Unconditional skips only, as on the JVM: `skipif`/`skipIf`/`skipUnless` tests usually do run.
  skipMarkers: [/@\s*(?:pytest\s*\.\s*mark\s*\.\s*)?skip\b/, /@\s*unittest\s*\.\s*skip\b/],
  skipInBody: [/\bpytest\s*\.\s*skip\s*\(/, /\bself\s*\.\s*skipTest\s*\(/],
  noopPatterns: [/\bpass\b/g, /\bNone\b/g],
};
