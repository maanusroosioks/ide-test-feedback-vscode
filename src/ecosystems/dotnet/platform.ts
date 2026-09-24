import type { PlatformProfile } from '../types';

/** `at Ns.FooTests.Bar() in C:\src\FooTests.cs:line 42`. */
const FRAME = /\bin\s+(.+?):line\s+(\d+)/g;

export const dotnetPlatform: PlatformProfile = {
  defaultSourceLanguage: 'csharp',
  sourceExtensions: ['.cs'],
  sourceRoots: ['', 'src'],
  stackFrames: [{ pattern: FRAME, toFrame: (match) => ({ file: match[1].trim(), line: Number(match[2]) }) }],
};
