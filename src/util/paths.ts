import { isAbsolute, relative, sep } from 'node:path';

/** Strictly inside: the folder itself is not. */
export function isInside(folderPath: string, path: string): boolean {
  const rel = relative(folderPath, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Hidden folders are never walked, along with whatever `ignored` names. */
export function isWalkableDir(name: string, ignored: ReadonlySet<string>): boolean {
  return !name.startsWith('.') && !ignored.has(name);
}
