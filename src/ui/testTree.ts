const SEPARATOR = '::';

export const NO_SUITE = '(no suite)';

export function folderItemId(folderPath: string): string {
  return folderPath;
}

/** A leading `/` keeps a file's id apart from a fallback suite's, whose name never starts with one. */
export function fileItemId(folderPath: string, relativePath: string): string {
  return `${folderPath}${SEPARATOR}/${relativePath}`;
}

export function isFileItemId(folderPath: string, id: string): boolean {
  return id.startsWith(`${folderPath}${SEPARATOR}/`);
}

/** `container` is the dotted path from the outermost class down, e.g. `Outer.Inner`. */
export function classItemId(fileId: string, container: string): string {
  return `${fileId}${SEPARATOR}${container}`;
}

/** Keyed by where the test is declared, so it holds from discovery through every run. */
export function declarationItemId(fileId: string, container: string | undefined, name: string): string {
  return `${fileId}${SEPARATOR}${container ?? ''}${SEPARATOR}${name}`;
}

/** A result that exists only once the tests run, e.g. one case of a parameterized test. */
export function resultItemId(parentId: string, testName: string): string {
  return `${parentId}${SEPARATOR}run:${testName}`;
}

/** For results traced to no file: grouped by the suite the report names. */
export function suiteItemId(folderPath: string, suite: string): string {
  return `${folderPath}${SEPARATOR}${suite}`;
}

export function testItemId(folderPath: string, suite: string, testName: string): string {
  return `${folderPath}${SEPARATOR}${suite}${SEPARATOR}${testName}`;
}

export function suiteKey(suite: string | undefined): string {
  const trimmed = suite?.trim();
  return trimmed ? trimmed : NO_SUITE;
}

/** `com.pkg.FooTest` -> `FooTest`; the full name goes in the item description. */
export function suiteLabel(suite: string): string {
  const lastDot = suite.lastIndexOf('.');
  const short = lastDot >= 0 ? suite.slice(lastDot + 1) : suite;
  return short.length > 0 ? short : suite;
}

/** `undefined` when the label already shows everything the full name would. */
export function suiteDescription(suite: string): string | undefined {
  return suiteLabel(suite) === suite ? undefined : suite;
}
