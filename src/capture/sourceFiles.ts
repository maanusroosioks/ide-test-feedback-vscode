import { readFile } from 'node:fs/promises';
import { basename, relative, sep } from 'node:path';
import type { NormalizedTestRun, Platform } from '../core/types';
import { languageForFile, scanTestDeclarations, type SourceLanguage } from '../ecosystems';
import { matchDeclaration, type TestDeclaration } from '../scanning';
import { getOrCreate } from '../util/maps';
import { isInside } from '../util/paths';
import type { SourceLocation, TestLocationResolver } from './location';

export interface SourceFile {
  absolutePath: string;
  /** Workspace-relative, forward slashes — never absolute, which would leak the student's username. */
  relativePath: string;
  /** LF-normalized. */
  text: string;
  language: SourceLanguage;
  declarations: TestDeclaration[];
}

export type ReadFileFn = (path: string) => Promise<string>;

function toLf(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

function toRelative(folderPath: string, absolutePath: string): string {
  if (!isInside(folderPath, absolutePath)) return basename(absolutePath);
  return relative(folderPath, absolutePath).split(sep).join('/');
}

/** One read and one scan per file, however many tests or callers ask for it. Instantiate per pass. */
export class SourceFileCache {
  private readonly loaded = new Map<string, Promise<SourceFile | undefined>>();

  constructor(
    private readonly folderPath: string,
    private readonly platform: Platform,
    private readonly read: ReadFileFn = (path) => readFile(path, 'utf8'),
  ) {}

  /** `undefined` when the file can't be read. */
  load(absolutePath: string): Promise<SourceFile | undefined> {
    return getOrCreate(this.loaded, absolutePath, () => this.readAndScan(absolutePath));
  }

  private async readAndScan(absolutePath: string): Promise<SourceFile | undefined> {
    try {
      const text = toLf(await this.read(absolutePath));
      const language = languageForFile(absolutePath, this.platform);
      return {
        absolutePath,
        relativePath: toRelative(this.folderPath, absolutePath),
        text,
        language,
        declarations: scanTestDeclarations(text, language),
      };
    } catch {
      return undefined;
    }
  }
}

/** How far one result was traced into the project's source. Each field needs the one before it. */
export interface LocatedResult {
  location?: SourceLocation;
  file?: SourceFile;
  declaration?: TestDeclaration;
}

/** Index-aligned with `run.results`. */
export async function locateResults(
  run: NormalizedTestRun,
  resolver: TestLocationResolver,
  files: SourceFileCache,
): Promise<LocatedResult[]> {
  const located: LocatedResult[] = [];
  for (const testCase of run.results) {
    const location = await resolver.resolveTestLocation(testCase.testSuite, testCase.stackTrace);
    const file = location ? await files.load(location.file) : undefined;
    const declaration = file
      ? matchDeclaration(file.declarations, testCase.testName, testCase.testSuite, location?.line)
      : undefined;
    located.push({ location, file, declaration });
  }
  return located;
}
