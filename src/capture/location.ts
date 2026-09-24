import { readdir } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pathExists } from '../util/shell';
import type { Platform } from '../core/types';
import { PLATFORMS, type PlatformProfile, type StackFrame } from '../ecosystems';

export type { StackFrame };

export interface SourceLocation {
  file: string;
  /** 1-based. Absent when only the file is known. */
  line?: number;
}

export type ExistsFn = (path: string) => Promise<boolean>;
export type ListDirsFn = (path: string) => Promise<string[]>;

/** Every platform's; each profile adds its own. Hidden folders are skipped too. */
const SHARED_IGNORED_DIRS = ['node_modules', 'dist', 'out'];

function hasDirectorySegment(file: string): boolean {
  return file.includes('/') || file.includes('\\');
}

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

interface IndexedFrame {
  index: number;
  frame: StackFrame;
}

/** Several rules can match one trace, so frames are put back in the order they appear in it. */
export function parseStackFrames(stackTrace: string, platform: Platform): StackFrame[] {
  const found: IndexedFrame[] = [];

  for (const { pattern, toFrame } of PLATFORMS[platform].stackFrames) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(stackTrace)) !== null) {
      const frame = toFrame(match);
      if (frame) {
        found.push({ index: match.index, frame });
      }
    }
  }

  return found
    .sort((a, b) => a.index - b.index)
    .map(({ frame }) => frame)
    .filter((frame) => Number.isFinite(frame.line) && frame.line > 0);
}

function classMatchesSuite(className: string | undefined, suite: string | undefined): boolean {
  if (!className || !suite) return false;
  if (className === suite) return true;
  return className.startsWith(`${suite}$`) || suite.startsWith(`${className}$`);
}

async function defaultListDirs(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

export interface TestLocationResolverDeps {
  exists?: ExistsFn;
  listDirs?: ListDirsFn;
}

/** Instantiate per test run — filesystem probes are memoised for its lifetime. */
export class TestLocationResolver {
  private readonly exists: ExistsFn;
  private readonly listDirs: ListDirsFn;
  private readonly profile: PlatformProfile;
  private readonly existsCache = new Map<string, Promise<boolean>>();
  private readonly suiteFiles = new Map<string, Promise<string | undefined>>();
  private readonly frameFiles = new Map<string, Promise<string | undefined>>();
  private modules?: Promise<string[]>;

  constructor(
    private readonly folderPath: string,
    private readonly platform: Platform,
    deps: TestLocationResolverDeps = {},
  ) {
    this.exists = deps.exists ?? pathExists;
    this.listDirs = deps.listDirs ?? defaultListDirs;
    this.profile = PLATFORMS[platform];
  }

  async resolveSuiteFile(testSuite: string | undefined): Promise<string | undefined> {
    if (!testSuite) return undefined;
    let cached = this.suiteFiles.get(testSuite);
    if (!cached) {
      cached = this.probe(this.suiteCandidates(testSuite));
      this.suiteFiles.set(testSuite, cached);
    }
    return cached;
  }

  /** Prefers a frame belonging to the suite itself, then the first resolvable frame. */
  async resolveTestLocation(
    testSuite: string | undefined,
    stackTrace: string | undefined,
  ): Promise<SourceLocation | undefined> {
    const suiteFile = await this.resolveSuiteFile(testSuite);
    const frames = stackTrace ? parseStackFrames(stackTrace, this.platform) : [];

    let fallback: SourceLocation | undefined;
    for (const frame of frames) {
      const file = await this.resolveFrameFile(frame);
      if (!file) continue;
      if (classMatchesSuite(frame.className, testSuite) || (suiteFile && samePath(file, suiteFile))) {
        return { file, line: frame.line };
      }
      fallback ??= { file, line: frame.line };
    }

    return fallback ?? (suiteFile ? { file: suiteFile } : undefined);
  }

  private async resolveFrameFile(frame: StackFrame): Promise<string | undefined> {
    const key = `${frame.className ?? ''}|${frame.file}`;
    let cached = this.frameFiles.get(key);
    if (!cached) {
      cached = this.locateFrameFile(frame);
      this.frameFiles.set(key, cached);
    }
    return cached;
  }

  private async locateFrameFile(frame: StackFrame): Promise<string | undefined> {
    if (isAbsolute(frame.file)) {
      const absolute = resolve(frame.file);
      return (await this.existsCached(absolute)) ? absolute : undefined;
    }
    if (hasDirectorySegment(frame.file)) {
      const direct = resolve(this.folderPath, frame.file);
      if (await this.existsCached(direct)) return direct;
      return this.probe([frame.file]);
    }

    const candidates: string[] = [];
    if (frame.className) {
      const extension = frame.file.slice(frame.file.lastIndexOf('.'));
      candidates.push(...this.profile.sourcePaths(frame.className).map((path) => `${path}${extension}`));
    }
    candidates.push(frame.file);
    return this.probe(candidates);
  }

  private suiteCandidates(testSuite: string): string[] {
    return this.profile
      .sourcePaths(testSuite)
      .flatMap((path) => this.profile.sourceExtensions.map((ext) => `${path}${ext}`));
  }

  private async probe(relatives: string[]): Promise<string | undefined> {
    const hit = await this.probeIn([''], relatives);
    return hit ?? this.probeIn(await this.moduleDirs(), relatives);
  }

  private async probeIn(modules: string[], relatives: string[]): Promise<string | undefined> {
    const roots = this.profile.sourceRoots;
    for (const module of modules) {
      for (const root of roots) {
        for (const relative of relatives) {
          const candidate = resolve(this.folderPath, module, root, relative);
          if (await this.existsCached(candidate)) {
            return candidate;
          }
        }
      }
    }
    return undefined;
  }

  private async moduleDirs(): Promise<string[]> {
    this.modules ??= this.listDirs(this.folderPath).then((dirs) => {
      const ignored = new Set([...SHARED_IGNORED_DIRS, ...this.profile.ignoredDirs]);
      return dirs.filter((name) => !name.startsWith('.') && !ignored.has(name));
    });
    return this.modules;
  }

  private existsCached(path: string): Promise<boolean> {
    let cached = this.existsCache.get(path);
    if (!cached) {
      cached = this.exists(path);
      this.existsCache.set(path, cached);
    }
    return cached;
  }
}
