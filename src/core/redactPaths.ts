export interface LocalRoots {
  workspace: string;
  home?: string;
}

/** A regex source for `path`, in which `/` and `\` each match either separator. */
function pathPattern(path: string): string {
  return [...path]
    .map((char) => (char === '/' || char === '\\' ? '[\\\\/]' : char.replace(/[.*+?^${}()|[\]]/g, '\\$&')))
    .join('');
}

/** `root` followed by a separator or by the end of its last segment, so `/home/al` doesn't match `/home/alice`. */
function rootPattern(root: string): RegExp {
  // Windows drive paths are case-insensitive.
  return new RegExp(`${pathPattern(root)}(?:[\\\\/]|(?![\\w.-]))`, /^[A-Za-z]:/.test(root) ? 'gi' : 'g');
}

function replaceRoot(text: string, root: string | undefined, withSeparator: string, alone: string): string {
  const trimmed = root?.replace(/[\\/]+$/, '');
  if (!trimmed) return text;
  return text.replace(rootPattern(trimmed), (match) => (/[\\/]$/.test(match) ? withSeparator : alone));
}

/** `/home/alice/proj/data.txt` -> `data.txt`; elsewhere under home -> `~/...`. */
export function redactLocalPaths(message: string | undefined, roots: LocalRoots | undefined): string | undefined {
  if (message === undefined || roots === undefined) return message;
  return replaceRoot(replaceRoot(message, roots.workspace, '', '.'), roots.home, '~/', '~');
}
