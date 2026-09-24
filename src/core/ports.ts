// The seams between the pure layers and the editor, declared here so those layers can take a logger
// or status bar without importing `vscode`; `ui/` supplies the implementations.

export interface Logger {
  log(message: string): void;
}

export interface RunSummary {
  total: number;
  passed: number;
  /** Includes errored tests. */
  failed: number;
  skipped: number;
}

export interface StatusReporter {
  running(): void;
  result(summary: RunSummary): void;
  error(message: string): void;
  idle(): void;
}
