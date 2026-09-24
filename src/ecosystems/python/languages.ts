import { scanPython } from '../../scanning';
import type { SourceLanguageProfile } from '../types';

export const pythonSource: SourceLanguageProfile = {
  extensions: ['.py'],
  lexer: { lineComment: '#', tripleQuoteEscapes: true },
  scanDeclarations: scanPython,
  assertions:
    /(?:^|[^.\w])assert\b|\bself\s*\.\s*(?:assert\w+|fail)\s*\(|\bpytest\s*\.\s*(?:raises|fail)\s*\(|\b(?:np|numpy)\s*\.\s*testing\s*\.\s*assert_\w+\s*\(/g,
  skipMarkers: [/@\s*(?:pytest\s*\.\s*mark\s*\.\s*)?skip(?:if)?\b/, /@\s*unittest\s*\.\s*skip\w*\b/],
  skipInBody: [/\bpytest\s*\.\s*skip\s*\(/, /\bself\s*\.\s*skipTest\s*\(/],
  noopPatterns: [/\bpass\b/g, /\bNone\b/g],
};
