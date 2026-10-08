// Stands in for the `vscode` module (aliased in vitest.config.ts), which only exists inside the
// extension host. Covers just the API surface the extension uses; test/unit/setup.ts resets it
// before every test so recorded calls and state don't leak between tests.

import { vi, type Mock } from 'vitest';
import type * as vscode from 'vscode';

const resetters: Array<() => void> = [];

function stubFn<Args extends unknown[], R>(impl: (...args: Args) => R): Mock<(...args: Args) => R> {
  const fn = vi.fn(impl);
  resetters.push(() => {
    fn.mockReset();
    fn.mockImplementation(impl);
  });
  return fn;
}

const disposable = (): { dispose: Mock } => ({ dispose: vi.fn() });

// ------------------------------------------------------------- values ----

export class Uri {
  readonly scheme = 'file';
  private constructor(readonly fsPath: string) {}
  static file(fsPath: string): Uri {
    return new Uri(fsPath);
  }
  toString(): string {
    return `file://${this.fsPath}`;
  }
}

export class Range {
  constructor(
    readonly startLine: number,
    readonly startCharacter: number,
    readonly endLine: number,
    readonly endCharacter: number,
  ) {}
}

export class Location {
  constructor(
    readonly uri: Uri,
    readonly range: Range,
  ) {}
}

export class TestMessage {
  location?: Location;
  constructor(readonly message: string) {}
}

export class TestRunRequest {
  constructor(readonly include?: FakeTestItem[]) {}
}

export class ThemeColor {
  constructor(readonly id: string) {}
}

export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

export enum ProgressLocation {
  SourceControl = 1,
  Window = 10,
  Notification = 15,
}

export enum TestRunProfileKind {
  Run = 1,
  Debug = 2,
  Coverage = 3,
}

// ---------------------------------------------------------- test tree ----

export interface FakeTestItem {
  id: string;
  label: string;
  uri?: Uri;
  parent?: FakeTestItem;
  description?: string;
  range?: Range;
  children: FakeTestItemCollection;
}

export class FakeTestItemCollection {
  private readonly items = new Map<string, FakeTestItem>();
  constructor(private readonly owner?: FakeTestItem) {}

  get size(): number {
    return this.items.size;
  }
  add(item: FakeTestItem): void {
    item.parent = this.owner;
    this.items.set(item.id, item);
  }
  delete(id: string): void {
    this.items.delete(id);
  }
  get(id: string): FakeTestItem | undefined {
    return this.items.get(id);
  }
  forEach(callback: (item: FakeTestItem) => void): void {
    [...this.items.values()].forEach((item) => callback(item));
  }
  ids(): string[] {
    return [...this.items.keys()];
  }
}

type Outcome =
  | { status: 'passed'; durationMs?: number }
  | { status: 'skipped' }
  | { status: 'failed' | 'errored'; message: TestMessage; durationMs?: number };

export class FakeTestRun {
  output = '';
  ended = false;
  readonly startedIds: string[] = [];
  readonly outcomes = new Map<string, Outcome>();
  private readonly cancelListeners = new Set<() => void>();

  readonly token = {
    onCancellationRequested: (listener: () => void) => {
      this.cancelListeners.add(listener);
      return { dispose: () => this.cancelListeners.delete(listener) };
    },
  };

  constructor(
    readonly request: TestRunRequest,
    readonly name: string,
  ) {}

  /** Simulates the user pressing stop in the Testing view. */
  cancel(): void {
    this.cancelListeners.forEach((listener) => listener());
  }
  get cancelListenerCount(): number {
    return this.cancelListeners.size;
  }

  started(item: FakeTestItem): void {
    this.startedIds.push(item.id);
  }
  passed(item: FakeTestItem, durationMs?: number): void {
    this.outcomes.set(item.id, { status: 'passed', durationMs });
  }
  skipped(item: FakeTestItem): void {
    this.outcomes.set(item.id, { status: 'skipped' });
  }
  failed(item: FakeTestItem, message: TestMessage, durationMs?: number): void {
    this.outcomes.set(item.id, { status: 'failed', message, durationMs });
  }
  errored(item: FakeTestItem, message: TestMessage, durationMs?: number): void {
    this.outcomes.set(item.id, { status: 'errored', message, durationMs });
  }
  appendOutput(text: string): void {
    this.output += text;
  }
  end(): void {
    this.ended = true;
  }
}

export interface FakeRunProfile {
  label: string;
  kind: TestRunProfileKind;
  handler: (request: TestRunRequest) => Promise<void>;
  isDefault: boolean;
}

export class FakeTestController {
  readonly items = new FakeTestItemCollection();
  readonly runs: FakeTestRun[] = [];
  readonly profiles: FakeRunProfile[] = [];
  readonly dispose = vi.fn();

  constructor(
    readonly id: string,
    readonly label: string,
  ) {}

  createTestItem(id: string, label: string, uri?: Uri): FakeTestItem {
    const item = { id, label, uri } as FakeTestItem;
    item.children = new FakeTestItemCollection(item);
    return item;
  }
  createTestRun(request: TestRunRequest, name: string): FakeTestRun {
    const run = new FakeTestRun(request, name);
    this.runs.push(run);
    return run;
  }
  createRunProfile(
    label: string,
    kind: TestRunProfileKind,
    handler: FakeRunProfile['handler'],
    isDefault: boolean,
  ): FakeRunProfile {
    const profile = { label, kind, handler, isDefault };
    this.profiles.push(profile);
    return profile;
  }
}

// --------------------------------------------------------- namespaces ----

/** Backs `workspace.getConfiguration(...).get`; keys are unprefixed, e.g. `serviceUrl`. */
export const configValues = new Map<string, unknown>();
export const configUpdate = stubFn(async (_key: string, _value: unknown, _target?: ConfigurationTarget) => {});

/** Handlers passed to `commands.registerCommand`, by command id. */
export const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();

/** Emitted by the default `window.withProgress`; `cancel()` fires its token. */
export const progress = {
  report: vi.fn(),
  cancel: (): void => {},
};

export interface FakeStatusBarItem {
  text: string;
  tooltip?: string;
  command?: string;
  backgroundColor?: ThemeColor;
  show: Mock;
  dispose: Mock;
}

export const window = {
  activeTextEditor: undefined as { document: { uri: Uri } } | undefined,
  showInformationMessage: stubFn(async (..._args: unknown[]): Promise<string | undefined> => undefined),
  showWarningMessage: stubFn(async (..._args: unknown[]): Promise<string | undefined> => undefined),
  showErrorMessage: stubFn(async (..._args: unknown[]): Promise<string | undefined> => undefined),
  showInputBox: stubFn(async (_options?: unknown): Promise<string | undefined> => undefined),
  showQuickPick: stubFn(async (_items: unknown, _options?: unknown): Promise<unknown> => undefined),
  showTextDocument: stubFn(async (_doc: unknown) => ({})),
  createOutputChannel: stubFn((_name: string) => ({ appendLine: vi.fn(), show: vi.fn(), dispose: vi.fn() })),
  createStatusBarItem: stubFn(
    (_alignment?: StatusBarAlignment, _priority?: number): FakeStatusBarItem => ({
      text: '',
      show: vi.fn(),
      dispose: vi.fn(),
    }),
  ),
  withProgress: stubFn(
    async <T>(
      _options: unknown,
      task: (reporter: { report: Mock }, token: FakeTestRun['token']) => Promise<T>,
    ): Promise<T> => {
      const listeners = new Set<() => void>();
      progress.cancel = () => listeners.forEach((listener) => listener());
      return task(progress, {
        onCancellationRequested: (listener) => {
          listeners.add(listener);
          return { dispose: () => listeners.delete(listener) };
        },
      });
    },
  ),
};

export const workspace = {
  workspaceFolders: undefined as vscode.WorkspaceFolder[] | undefined,
  getConfiguration: stubFn((_section?: string, _scope?: Uri) => ({
    get: <T>(key: string, fallback?: T): T | undefined =>
      configValues.has(key) ? (configValues.get(key) as T) : fallback,
    update: configUpdate,
  })),
  getWorkspaceFolder: stubFn((_uri: Uri): vscode.WorkspaceFolder | undefined => undefined),
  openTextDocument: stubFn(async (path: string) => ({ path })),
  onDidChangeWorkspaceFolders: stubFn((_listener: () => void) => disposable()),
  onDidChangeConfiguration: stubFn(
    (_listener: (event: { affectsConfiguration(section: string): boolean }) => void) => disposable(),
  ),
};

export const commands = {
  executeCommand: stubFn(async (..._args: unknown[]): Promise<unknown> => undefined),
  registerCommand: stubFn((id: string, handler: (...args: unknown[]) => unknown) => {
    registeredCommands.set(id, handler);
    return disposable();
  }),
};

export const authentication = {
  getSession: stubFn(
    async (_provider: string, _scopes: readonly string[], _options?: object): Promise<{ accessToken: string } | undefined> =>
      ({ accessToken: 'token-abc' }),
  ),
};

export const tests = {
  createTestController: stubFn((id: string, label: string) => new FakeTestController(id, label)),
};

// ------------------------------------------------------------ helpers ----

export function resetVscodeStub(): void {
  resetters.forEach((reset) => reset());
  configValues.clear();
  registeredCommands.clear();
  progress.report = vi.fn();
  progress.cancel = () => {};
  window.activeTextEditor = undefined;
  workspace.workspaceFolders = undefined;
}

export function workspaceFolder(fsPath: string, name = fsPath, index = 0): vscode.WorkspaceFolder {
  return { uri: Uri.file(fsPath), name, index } as unknown as vscode.WorkspaceFolder;
}

/** Runs a handler registered through `commands.registerCommand`. */
export async function invokeCommand(id: string, ...args: unknown[]): Promise<unknown> {
  const handler = registeredCommands.get(id);
  if (!handler) throw new Error(`command ${id} was never registered`);
  return handler(...args);
}

class FakeMemento {
  private readonly values = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }
  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
}

export interface FakeExtensionContext {
  subscriptions: { dispose(): unknown }[];
  workspaceState: FakeMemento;
  globalState: FakeMemento;
  extension: { id: string };
}

export function fakeExtensionContext(): FakeExtensionContext {
  return {
    subscriptions: [],
    workspaceState: new FakeMemento(),
    globalState: new FakeMemento(),
    extension: { id: 'example.moodle-test-submit' },
  };
}

/** The fake as the extension code sees it. */
export function asContext(context: FakeExtensionContext): vscode.ExtensionContext {
  return context as unknown as vscode.ExtensionContext;
}

resetVscodeStub();
