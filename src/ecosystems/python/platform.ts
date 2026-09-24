import type { PlatformProfile, StackFrame } from '../types';

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
