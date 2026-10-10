import { stat } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';
import type { Platform } from '../core/types';
import { ignoredDirsFor, languagesOf, PLATFORMS, SOURCE_LANGUAGES, type SourceLanguageProfile } from '../ecosystems';
import { readDirSafe } from '../util/fs';
import { isInside, isWalkableDir } from '../util/paths';
import type { SourceFile, SourceFileCache } from './sourceFiles';

export interface DiscoveryLimits {
  /** Candidate files found before giving up on the rest of the folder. */
  maxFiles: number;
  /** Directory entries visited before giving up, so a huge tree with few candidates can't stall the walk either. */
  maxEntries: number;
  /** Larger files are skipped unread: a generated file, not a test someone wrote. */
  maxFileBytes: number;
}

/** Course projects are far below all three; they only stop an opened home folder from stalling discovery. */
export const DISCOVERY_LIMITS: DiscoveryLimits = { maxFiles: 5000, maxEntries: 50_000, maxFileBytes: 1_000_000 };

/** Files read at once: enough to overlap the disk waits, few enough not to exhaust file handles. */
const READ_CONCURRENCY = 16;

const SOURCE_EXTENSIONS = [...new Set(Object.values(SOURCE_LANGUAGES).flatMap((profile) => profile.extensions))];

/** Every file a finder could accept, for a file watcher to narrow its events to. */
export const SOURCE_FILE_GLOB = `**/*.{${SOURCE_EXTENSIONS.map((ext) => ext.slice(1)).join(',')}}`;

const ANY_IGNORED_DIR = ignoredDirsFor(Object.keys(PLATFORMS) as Platform[]);

/** The path's segments below `folderPath`, or `undefined` when it isn't inside it. */
function segmentsBelow(folderPath: string, path: string): string[] | undefined {
  return isInside(folderPath, path) ? relative(folderPath, path).split(sep) : undefined;
}

/**
 * Whether a newly created entry other than a source file could be a folder holding tests: nothing
 * hidden or ignored on the way to it. Judged by its path alone and every platform's ignored
 * folders, so build output can be dropped without detecting the folder's platforms or touching disk.
 */
export function mayBeTestFolder(folderPath: string, path: string): boolean {
  const segments = segmentsBelow(folderPath, path);
  return (
    segments !== undefined &&
    segments.every((segment) => isWalkableDir(segment, ANY_IGNORED_DIR)) &&
    !SOURCE_EXTENSIONS.includes(extname(path).toLowerCase())
  );
}

/** Finds the files in one workspace folder that declare tests, without building or running anything. */
export class TestFileFinder {
  private readonly ignoredDirs: Set<string>;
  private readonly profileByExtension: Map<string, SourceLanguageProfile>;

  constructor(
    private readonly folderPath: string,
    /** The platforms the folder builds for; never empty. */
    readonly platforms: Platform[],
    private readonly limits: DiscoveryLimits = DISCOVERY_LIMITS,
  ) {
    this.ignoredDirs = ignoredDirsFor(platforms);
    this.profileByExtension = new Map(
      platforms
        .flatMap(languagesOf)
        .flatMap((language) => SOURCE_LANGUAGES[language].extensions.map((ext) => [ext, SOURCE_LANGUAGES[language]] as const)),
    );
  }

  /** Whether a file at this path could hold tests, judged by its path alone. */
  isCandidate(absolutePath: string): boolean {
    const segments = segmentsBelow(this.folderPath, absolutePath);
    if (!segments) return false;
    const name = segments.pop() ?? '';
    return segments.every((dir) => isWalkableDir(dir, this.ignoredDirs)) && this.accepts(name);
  }

  /** The file, if it is a test file that declares at least one test. */
  async load(absolutePath: string, files: SourceFileCache): Promise<SourceFile | undefined> {
    try {
      if ((await stat(absolutePath)).size > this.limits.maxFileBytes) return undefined;
    } catch {
      return undefined;
    }
    const file = await files.load(absolutePath);
    return file && file.declarations.length > 0 ? file : undefined;
  }

  /** Every test file in the folder, in path order. */
  async discover(files: SourceFileCache): Promise<SourceFile[]> {
    const candidates = await this.candidates();
    const found: SourceFile[] = [];
    for (let start = 0; start < candidates.length; start += READ_CONCURRENCY) {
      const batch = candidates.slice(start, start + READ_CONCURRENCY);
      for (const file of await Promise.all(batch.map((path) => this.load(path, files)))) {
        if (file) found.push(file);
      }
    }
    return found;
  }

  private accepts(fileName: string): boolean {
    const profile = this.profileByExtension.get(extname(fileName).toLowerCase());
    return profile !== undefined && (profile.testFileName?.test(fileName) ?? true);
  }

  private async candidates(): Promise<string[]> {
    const found: string[] = [];
    let visited = 0;
    const exhausted = (): boolean => found.length >= this.limits.maxFiles || visited >= this.limits.maxEntries;

    const walk = async (dir: string): Promise<void> => {
      const entries = await readDirSafe(dir);
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of entries) {
        if (exhausted()) return;
        visited++;
        // `isDirectory()` is false for symlinks, so the walk cannot loop.
        if (entry.isDirectory()) {
          if (isWalkableDir(entry.name, this.ignoredDirs)) await walk(join(dir, entry.name));
        } else if (entry.isFile() && this.accepts(entry.name)) {
          found.push(join(dir, entry.name));
        }
      }
    };
    await walk(this.folderPath);
    return found;
  }
}
