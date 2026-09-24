import { scanPython } from '../source';
import type { PlatformProfile, SourceLanguageProfile, StackFrame } from './types';

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

/** CPython traceback: `File "/abs/tests/test_x.py", line 12, in test_bar`. */
const TRACEBACK_FRAME = /File "([^"]+)", line (\d+)/g;
/** pytest's own failure report footer: `tests/test_math.py:12: AssertionError`. */
const PYTEST_REPORT_FRAME = /^\s*([^\s:][^:\n]*\.py):(\d+):/gm;

const toFrame = (match: RegExpExecArray): StackFrame => ({ file: match[1], line: Number(match[2]) });

export const pythonPlatform: PlatformProfile = {
  defaultSourceLanguage: 'python',
  sourceExtensions: ['.py'],
  sourceRoots: ['', 'src', 'tests', 'test'],
  stackFrames: [
    { pattern: TRACEBACK_FRAME, toFrame },
    { pattern: PYTEST_REPORT_FRAME, toFrame },
  ],
};
