import { stat } from 'node:fs/promises';
import * as vscode from 'vscode';
import { getPreferredAdapterId } from '../config/settings';
import { mayBeTestFolder, SOURCE_FILE_GLOB, TestFileFinder } from '../capture/discovery';
import { SourceFileCache } from '../capture/sourceFiles';
import { describeError } from '../core/errors';
import type { Logger } from '../core/ports';
import type { Platform } from '../core/types';
import type { AdapterRegistry } from '../runner/registry';
import { KeyedDebouncer } from '../util/debounce';
import { getOrCreate } from '../util/maps';
import { samePath } from '../util/paths';
import { isOpen, type TestItemTree } from './testItemTree';

/** Saving often writes a file more than once in quick succession; one scan covers them all. */
export const RESCAN_DELAY_MS = 300;

export interface TestDiscoveryDeps {
  registry: AdapterRegistry;
  logger: Logger;
}

/** Fills the tree from source once the Testing view asks, then keeps it current as files change. */
export function registerTestDiscovery(
  context: vscode.ExtensionContext,
  controller: vscode.TestController,
  tree: TestItemTree,
  deps: TestDiscoveryDeps,
): void {
  let discoveryStarted = false;

  /** The platforms the folder's build tools test on. Detection only, so no prompt can appear. */
  async function platformsFor(folderPath: string): Promise<Platform[]> {
    try {
      const preferred = getPreferredAdapterId(folderPath);
      const adapters = preferred
        ? [await deps.registry.resolveAdapter(folderPath, { preferredAdapterId: preferred })]
        : await deps.registry.detectAdapters(folderPath);
      return [...new Set(adapters.map((adapter) => adapter.platform))];
    } catch {
      return [];
    }
  }

  /**
   * Detected afresh each time, never cached: adding `pom.xml` or `conftest.py`, or changing
   * `preferredAdapter`, changes the answer. It's a handful of file checks.
   */
  async function finderFor(folder: vscode.WorkspaceFolder): Promise<TestFileFinder | undefined> {
    const platforms = await platformsFor(folder.uri.fsPath);
    return platforms.length > 0 ? new TestFileFinder(folder.uri.fsPath, platforms) : undefined;
  }

  async function discoverFolder(folder: vscode.WorkspaceFolder): Promise<void> {
    const folderPath = folder.uri.fsPath;
    const mark = tree.renderMark;
    try {
      const finder = await finderFor(folder);
      const found = finder ? await finder.discover(new SourceFileCache(folderPath, finder.platforms[0])) : [];
      if (!isOpen(folder)) return;

      const live = new Set(found.map((file) => tree.renderFile(folder, file).fileItem.id));
      const root = tree.folderItem(folder);
      for (const item of tree.fileItemsOf(folder)) {
        // Rebuilt during the walk by a rescan or a run: newer than what this walk saw.
        const stale = !tree.renderedSince(item, mark);
        // A file only a run traced, e.g. one a custom `python_files` names, isn't the walk's to remove.
        const discoverable = !finder || (item.uri !== undefined && finder.isCandidate(item.uri.fsPath));
        if (!live.has(item.id) && stale && discoverable) root.children.delete(item.id);
      }
      tree.updatePlaceholder(folder);
    } catch (error) {
      deps.logger.log(`Could not discover the tests in "${folder.name}": ${describeError(error)}`);
    }
  }

  // Called with no item when the Testing view first needs the tree.
  controller.resolveHandler = async (item) => {
    if (item) return;
    discoveryStarted = true;
    await Promise.all((vscode.workspace.workspaceFolders ?? []).map(discoverFolder));
  };

  function syncFolders(): void {
    const folders = vscode.workspace.workspaceFolders ?? [];
    tree.syncFolders(folders);
    for (const folder of folders) {
      const added = !tree.hasFolderItem(folder);
      tree.folderItem(folder);
      if (added && discoveryStarted) void discoverFolder(folder);
    }
  }

  syncFolders();
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(syncFolders));

  const rescans = new KeyedDebouncer(RESCAN_DELAY_MS);
  context.subscriptions.push(rescans);

  async function rescanFile(uri: vscode.Uri): Promise<void> {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) return;
    const finder = await finderFor(folder);
    // A file already in the tree stays current even if only a run could find it.
    const tracked = tree.fileItemsOf(folder).some((item) => item.uri && samePath(item.uri.fsPath, uri.fsPath));
    if (!finder || !(finder.isCandidate(uri.fsPath) || tracked)) return;

    const file = await finder.load(uri.fsPath, new SourceFileCache(folder.uri.fsPath, finder.platforms[0]));
    if (!isOpen(folder)) return;
    if (file) {
      tree.renderFile(folder, file);
      tree.updatePlaceholder(folder);
    } else {
      tree.removeFiles(folder, uri.fsPath);
    }
  }

  function scheduleRescan(uri: vscode.Uri): void {
    if (uri.scheme !== 'file') return;
    rescans.schedule(uri.fsPath, () => void rescanFile(uri));
  }

  function onDeleted(uri: vscode.Uri): void {
    rescans.cancel(uri.fsPath);
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (folder) tree.removeFiles(folder, uri.fsPath);
  }

  // Creating, moving or renaming a folder reports only the folder, not the test files in it, so
  // any folder that turns up has its workspace folder discovered again, once things go quiet.
  const createdPaths = new Map<string, Set<string>>();
  const rediscoveries = new KeyedDebouncer(RESCAN_DELAY_MS);
  context.subscriptions.push(rediscoveries);

  async function discoverIfFolderCreated(folder: vscode.WorkspaceFolder): Promise<void> {
    const paths = createdPaths.get(folder.uri.fsPath) ?? new Set<string>();
    createdPaths.delete(folder.uri.fsPath);
    for (const path of paths) {
      const isDirectory = await stat(path).then(
        (stats) => stats.isDirectory(),
        () => false,
      );
      if (isDirectory) {
        await discoverFolder(folder);
        return;
      }
    }
  }

  function onCreated(uri: vscode.Uri): void {
    if (uri.scheme !== 'file') return;
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    // Build output, caches and source files (the source watcher's) are dropped here, unread.
    if (!folder || !mayBeTestFolder(folder.uri.fsPath, uri.fsPath)) return;

    const key = folder.uri.fsPath;
    getOrCreate(createdPaths, key, () => new Set<string>()).add(uri.fsPath);
    rediscoveries.schedule(key, () => void discoverIfFolderCreated(folder));
  }

  const sourceWatcher = vscode.workspace.createFileSystemWatcher(SOURCE_FILE_GLOB);
  // Folders as well as files; deleting a folder, too, reports only the folder.
  const treeWatcher = vscode.workspace.createFileSystemWatcher('**/*', false, true, false);
  context.subscriptions.push(
    sourceWatcher,
    treeWatcher,
    sourceWatcher.onDidCreate(scheduleRescan),
    sourceWatcher.onDidChange(scheduleRescan),
    treeWatcher.onDidCreate(onCreated),
    treeWatcher.onDidDelete(onDeleted),
    // So an open test file gets its gutter icons even if the Testing view is never opened.
    vscode.workspace.onDidOpenTextDocument((document) => scheduleRescan(document.uri)),
  );
  vscode.workspace.textDocuments.forEach((document) => scheduleRescan(document.uri));
}
