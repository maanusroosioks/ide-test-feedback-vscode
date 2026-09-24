import type { PlatformProfile, StackFrame } from '../types';

/** CPython traceback: `File "/abs/tests/test_x.py", line 12, in test_bar`. */
const TRACEBACK_FRAME = /File "([^"]+)", line (\d+)/g;
/** pytest's own failure report footer: `tests/test_math.py:12: AssertionError`. */
const PYTEST_REPORT_FRAME = /^\s*([^\s:][^:\n]*\.py):(\d+):/gm;

const toFrame = (match: RegExpExecArray): StackFrame => ({ file: match[1], line: Number(match[2]) });

/** pytest names a suite after its module, then its class if any: `tests.test_math.TestMath`. */
function sourcePaths(qualifiedName: string): string[] {
  const segments = qualifiedName.split('.');
  const paths = [segments.join('/')];
  if (segments.length > 1 && /^[A-Z]/.test(segments[segments.length - 1])) {
    paths.push(segments.slice(0, -1).join('/'));
  }
  return paths;
}

export const pythonPlatform: PlatformProfile = {
  defaultSourceLanguage: 'python',
  sourceExtensions: ['.py'],
  sourceRoots: ['', 'src', 'tests', 'test'],
  sourcePaths,
  // A venv is usually hidden (`.venv`), which is skipped anyway.
  ignoredDirs: ['venv', '__pycache__', 'site-packages', 'build'],
  stackFrames: [
    { pattern: TRACEBACK_FRAME, toFrame },
    { pattern: PYTEST_REPORT_FRAME, toFrame },
  ],
};
