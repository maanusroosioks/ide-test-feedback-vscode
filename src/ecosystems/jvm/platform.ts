import type { PlatformProfile } from '../types';

const SOURCE_EXTENSIONS = ['.java', '.kt', '.kts', '.scala', '.groovy'];

/** `at app//com.pkg.FooTest.bar(FooTest.java:42)` — the `app//` prefix is optional. */
const FRAME = /\bat\s+([^\s(]+)\(([^()]+):(\d+)\)/g;

function className(qualified: string): string | undefined {
  const afterModule = qualified.slice(qualified.lastIndexOf('/') + 1);
  const lastDot = afterModule.lastIndexOf('.');
  return lastDot > 0 ? afterModule.slice(0, lastDot) : undefined;
}

/** `com.pkg.FooTest$Inner` lives in `com/pkg/FooTest`, or just `FooTest` where folders don't follow packages. */
function sourcePaths(qualifiedName: string): string[] {
  const segments = qualifiedName.split('$')[0].split('.');
  const paths = [segments.join('/')];
  if (segments.length > 1) paths.push(segments[segments.length - 1]);
  return paths;
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
  sourcePaths,
  // Maven, Gradle, Eclipse.
  ignoredDirs: ['target', 'build', 'bin'],
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
