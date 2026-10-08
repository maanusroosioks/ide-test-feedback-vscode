import type { PlatformProfile } from '../types';

/** `at Ns.FooTests.Bar() in C:\src\FooTests.cs:line 42`. */
const FRAME = /\bin\s+(.+?):line\s+(\d+)/g;

/**
 * A project's folder is named after its dotted root namespace (`Calculator.Tests/`), and only the
 * namespace below that maps to folders, so every split point is tried. Folders rarely follow
 * namespaces at all, so the bare class name is tried last.
 */
function sourcePaths(qualifiedName: string): string[] {
  const segments = qualifiedName.split('.');
  const paths: string[] = [];
  for (let split = 1; split < segments.length; split++) {
    paths.push([segments.slice(0, split).join('.'), ...segments.slice(split)].join('/'));
  }
  paths.push(segments[segments.length - 1]);
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
