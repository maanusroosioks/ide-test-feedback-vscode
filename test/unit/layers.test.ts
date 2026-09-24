import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(__dirname, '../../src');

interface Import {
  from: string;
  /** Relative to src, forward slashes, without extension. */
  target: string;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

function toSrcPath(path: string): string {
  return relative(SRC, path).split(sep).join('/');
}

const IMPORTS: Import[] = sourceFiles(SRC).flatMap((file) =>
  [...readFileSync(file, 'utf8').matchAll(/from '(\.[^']*)'/g)].map((match) => ({
    from: toSrcPath(file),
    target: toSrcPath(resolve(dirname(file), match[1])),
  })),
);

const layerOf = (path: string): string => path.split('/')[0];

function importsOf(layer: string): Import[] {
  return IMPORTS.filter((entry) => layerOf(entry.from) === layer && layerOf(entry.target) !== layer);
}

describe('layering', () => {
  it('finds the imports it checks', () => {
    expect(importsOf('capture').length).toBeGreaterThan(0);
  });

  // Engines are configured by ecosystems, so they must not know any of them.
  it('keeps scanning self-contained', () => {
    expect(importsOf('scanning')).toEqual([]);
  });

  it('keeps the runner below ecosystems and their consumers', () => {
    for (const entry of importsOf('runner')) {
      expect(['core', 'util'], `${entry.from} imports ${entry.target}`).toContain(layerOf(entry.target));
    }
  });

  it("reaches an ecosystem's own files only through ecosystems/index", () => {
    const outside = IMPORTS.filter((entry) => layerOf(entry.from) !== 'ecosystems');
    for (const entry of outside.filter((e) => layerOf(e.target) === 'ecosystems')) {
      expect(entry.target, `${entry.from} imports ${entry.target}`).toBe('ecosystems');
    }
  });

  it('keeps each ecosystem independent of the others', () => {
    for (const entry of IMPORTS.filter((e) => /^ecosystems\/[^/]+\//.test(e.from))) {
      const [, own] = entry.from.split('/');
      const [layer, other] = entry.target.split('/');
      if (layer === 'ecosystems' && other !== 'types') {
        expect(other, `${entry.from} imports ${entry.target}`).toBe(own);
      }
    }
  });
});
