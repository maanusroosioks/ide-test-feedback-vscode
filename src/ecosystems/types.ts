// An ecosystem is a runtime and its toolchain (the JVM, .NET, Python). It owns:
//  - adapters: the build tools that run its tests and report the results;
//  - a platform profile: what its stack traces look like and where its sources live;
//  - source languages: the syntaxes it hosts and the test conventions written in them.
// Ecosystems hold configuration only; the engines they configure are in `../runner` and `../scanning`.

import type { TestRunnerAdapter } from '../runner/types';
import type { LexicalRules, TestDeclaration } from '../scanning';

export type SourceLanguage = 'python' | 'java' | 'kotlin' | 'csharp';

/** What the extension knows about one language's source text. */
export interface SourceLanguageProfile {
  /** Lower-case, dot included. */
  extensions: string[];
  lexer: LexicalRules;
  /** `masked` is `text` put through `lexer`. */
  scanDeclarations(text: string, masked: string): TestDeclaration[];
  /**
   * One global alternation, not a list: a global regex consumes what it matches, so chained styles
   * like AssertJ's `assertThat(x).isEqualTo(y)` count once.
   */
  assertions: RegExp;
  /** Tested against each marker on the test and its enclosing type. */
  skipMarkers: RegExp[];
  skipInBody: RegExp[];
  /** Global. Tokens that do nothing in a test body, on top of the ones every language shares. */
  noopPatterns: RegExp[];
}

export interface StackFrame {
  className?: string;
  file: string;
  line: number;
}

export interface StackFrameRule {
  /** Global. */
  pattern: RegExp;
  toFrame(match: RegExpExecArray): StackFrame | undefined;
}

/** What the extension knows about the platform an adapter runs on, which may host several source languages. */
export interface PlatformProfile {
  /** For a file no source language claims, e.g. `.scala` on the JVM. */
  defaultSourceLanguage: SourceLanguage;
  /** Where a test suite's file may be found; wider than the source languages scanned. */
  sourceExtensions: string[];
  /** Relative to the project or one of its modules, probed in order; `''` is the directory itself. */
  sourceRoots: string[];
  /**
   * Where the file declaring a test suite or a stack frame's class may be: relative to a source
   * root, forward slashes, no extension. Probed in order.
   */
  sourcePaths(qualifiedName: string): string[];
  /** Build output and environments not to search for modules, on top of the ones every platform shares. */
  ignoredDirs: string[];
  stackFrames: StackFrameRule[];
}

export interface Ecosystem {
  platform: PlatformProfile;
  languages: Partial<Record<SourceLanguage, SourceLanguageProfile>>;
  /** In detection priority order. */
  adapters: TestRunnerAdapter[];
}
