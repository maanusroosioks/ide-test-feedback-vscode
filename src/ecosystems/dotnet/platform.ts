import type { PlatformProfile } from '../types';

/** `at Ns.FooTests.Bar() in C:\src\FooTests.cs:line 42`. */
const FRAME = /\bin\s+(.+?):line\s+(\d+)/g;

/** Folders rarely follow namespaces, so the class's own name is the likelier file. */
function sourcePaths(qualifiedName: string): string[] {
  const segments = qualifiedName.split('.');
  const paths = [segments.join('/')];
  if (segments.length > 1) paths.push(segments[segments.length - 1]);
  return paths;
}

export const dotnetPlatform: PlatformProfile = {
  defaultSourceLanguage: 'csharp',
  sourceExtensions: ['.cs'],
  sourceRoots: ['', 'src'],
  sourcePaths,
  ignoredDirs: ['bin', 'obj'],
  stackFrames: [{ pattern: FRAME, toFrame: (match) => ({ file: match[1].trim(), line: Number(match[2]) }) }],
};
