import type { LexicalRules } from '../source/mask';
import type { SourceLanguage, TestDeclaration } from '../source/language';

/** What the extension knows about one language's source text. */
export interface SourceLanguageProfile {
  /** Lower-case, dot included. */
  extensions: string[];
  lexer: LexicalRules;
  scanDeclarations(text: string): TestDeclaration[];
  /**
   * One global alternation, not a list: a global regex consumes what it matches, so chained styles
   * like AssertJ's `assertThat(x).isEqualTo(y)` count once.
   */
  assertions: RegExp;
  /** Tested against each marker on the test and its enclosing type. */
  skipMarkers: RegExp[];
  skipInBody: RegExp[];
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
export interface RunLanguageProfile {
  /** For a file no source language claims, e.g. `.scala` on the JVM. */
  defaultSourceLanguage: SourceLanguage;
  /** Where a test suite's file may be found; wider than the source languages scanned. */
  sourceExtensions: string[];
  /** Relative to the project or one of its modules, probed in order; `''` is the directory itself. */
  sourceRoots: string[];
  stackFrames: StackFrameRule[];
}
