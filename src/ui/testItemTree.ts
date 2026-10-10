import { posix } from 'node:path';
import * as vscode from 'vscode';
import { isInside, samePath } from '../util/paths';
import type { SourceFile } from '../capture/sourceFiles';
import type { TestDeclaration } from '../scanning';
import { classItemId, declarationItemId, fileItemId, folderItemId, isFileItemId } from './testItemIds';

const NOT_DISCOVERED = 'run to discover tests';

/** Snapshots ids so the collection can be mutated while walking it. */
function idsOf(collection: vscode.TestItemCollection): string[] {
  const ids: string[] = [];
  collection.forEach((item) => ids.push(item.id));
  return ids;
}

/** Overloads, or a function defined twice: the later ones are told apart by their order. */
function numberedId(seen: Map<string, number>, baseId: string): string {
  const count = (seen.get(baseId) ?? 0) + 1;
  seen.set(baseId, count);
  return count === 1 ? baseId : `${baseId}#${count}`;
}

/** Whole lines, so "run test at cursor" works anywhere in the test. */
function declarationRange(declaration: TestDeclaration, lines: string[]): vscode.Range {
  const lastLine = declaration.endLine - 1;
  return new vscode.Range(declaration.startLine - 1, 0, lastLine, lines[lastLine]?.length ?? 0);
}

function isAtOrUnder(path: string, root: string): boolean {
  return samePath(path, root) || isInside(root, path);
}

export function isOpen(folder: vscode.WorkspaceFolder): boolean {
  return (vscode.workspace.workspaceFolders ?? []).some((open) => open.uri.fsPath === folder.uri.fsPath);
}

export interface RenderedFile {
  fileItem: vscode.TestItem;
  items: Map<TestDeclaration, vscode.TestItem>;
}

/** The controller's items: one per workspace folder, its test files, and what is declared or ran in them. */
export class TestItemTree {
  /** Results that exist only once the tests run; a run prunes these, never what came from source. */
  private readonly resultItems = new WeakSet<vscode.TestItem>();

  /** When each file item was last built, so a slow discovery can tell what changed while it walked. */
  private renders = 0;
  private readonly renderedAt = new WeakMap<vscode.TestItem, number>();

  constructor(private readonly controller: vscode.TestController) {}

  /** Pass to {@link renderedSince} to learn which file items were rebuilt after this point. */
  get renderMark(): number {
    return this.renders;
  }

  renderedSince(item: vscode.TestItem, mark: number): boolean {
    return (this.renderedAt.get(item) ?? 0) > mark;
  }

  folderItem(folder: vscode.WorkspaceFolder): vscode.TestItem {
    const id = folderItemId(folder.uri.fsPath);
    const existing = this.controller.items.get(id);
    if (existing) return existing;

    const item = this.controller.createTestItem(id, folder.name, folder.uri);
    item.description = NOT_DISCOVERED;
    this.controller.items.add(item);
    return item;
  }

  hasFolderItem(folder: vscode.WorkspaceFolder): boolean {
    return this.controller.items.get(folderItemId(folder.uri.fsPath)) !== undefined;
  }

  /** Drops the items of folders no longer open. */
  syncFolders(folders: readonly vscode.WorkspaceFolder[]): void {
    const live = new Set(folders.map((folder) => folderItemId(folder.uri.fsPath)));
    for (const id of idsOf(this.controller.items)) {
      if (!live.has(id)) this.controller.items.delete(id);
    }
  }

  updatePlaceholder(folder: vscode.WorkspaceFolder): void {
    const root = this.folderItem(folder);
    root.description = root.children.size === 0 ? NOT_DISCOVERED : undefined;
  }

  childItem(parent: vscode.TestItem, id: string, label: string, uri: vscode.Uri | undefined): vscode.TestItem {
    const existing = parent.children.get(id);
    // `TestItem.uri` is readonly, so an item whose file moved must be recreated.
    if (existing && existing.uri?.toString() === uri?.toString()) {
      existing.label = label;
      return existing;
    }
    if (existing) {
      parent.children.delete(id);
    }
    const item = this.controller.createTestItem(id, label, uri);
    parent.children.add(item);
    return item;
  }

  /** Like {@link childItem}, for an item that exists only because the tests ran. */
  resultItem(parent: vscode.TestItem, id: string, label: string, uri: vscode.Uri | undefined): vscode.TestItem {
    const item = this.childItem(parent, id, label, uri);
    this.resultItems.add(item);
    return item;
  }

  /** Builds or refreshes one file's subtree from its scan, keeping the run-time results under it. */
  renderFile(folder: vscode.WorkspaceFolder, file: SourceFile): RenderedFile {
    const fileItem = this.renderFileItem(folder, file);
    const stem = posix.basename(file.relativePath, posix.extname(file.relativePath));
    const lines = file.text.split('\n');
    const kept = new Set<vscode.TestItem>();
    const seen = new Map<string, number>();
    const items = new Map<TestDeclaration, vscode.TestItem>();

    for (const declaration of file.declarations) {
      const parent = this.containerItem(fileItem, declaration.container, stem, kept);
      const id = numberedId(seen, declarationItemId(fileItem.id, declaration.container, declaration.name));
      const item = this.childItem(parent, id, declaration.name, fileItem.uri);
      kept.add(item);
      item.range = declarationRange(declaration, lines);
      // Its parameterized cases sit where it does, wherever an edit has moved it.
      item.children.forEach((child) => {
        if (this.resultItems.has(child)) child.range = item.range;
      });
      items.set(declaration, item);
    }

    // What the scan no longer declares goes; results stay until a run prunes them.
    this.pruneChildren(fileItem, (child) => {
      if (this.resultItems.has(child)) return 'leave';
      return kept.has(child) ? 'descend' : 'delete';
    });
    return { fileItem, items };
  }

  private renderFileItem(folder: vscode.WorkspaceFolder, file: SourceFile): vscode.TestItem {
    const id = fileItemId(folder.uri.fsPath, file.relativePath);
    const uri = vscode.Uri.file(file.absolutePath);
    const item = this.childItem(this.folderItem(folder), id, posix.basename(file.relativePath), uri);
    this.renderedAt.set(item, ++this.renders);
    const dir = posix.dirname(file.relativePath);
    item.description = dir === '.' ? undefined : dir;
    return item;
  }

  /** The innermost class item a declaration sits in, or its file's item; each one passed is added to `kept`. */
  private containerItem(
    fileItem: vscode.TestItem,
    container: string | undefined,
    stem: string,
    kept: Set<vscode.TestItem>,
  ): vscode.TestItem {
    const segments = container?.split('.') ?? [];
    let parent = fileItem;
    // A class named after its file adds nothing to the file it is in.
    for (let depth = segments[0] === stem ? 1 : 0; depth < segments.length; depth++) {
      const classId = classItemId(fileItem.id, segments.slice(0, depth + 1).join('.'));
      parent = this.childItem(parent, classId, segments[depth], fileItem.uri);
      kept.add(parent);
    }
    return parent;
  }

  /** Walks `item`'s subtree: deletes what `decide` drops, descends into what it keeps, leaves the rest. */
  private pruneChildren(
    item: vscode.TestItem,
    decide: (child: vscode.TestItem) => 'delete' | 'descend' | 'leave',
  ): void {
    for (const id of idsOf(item.children)) {
      const child = item.children.get(id);
      if (!child) continue;
      const verdict = decide(child);
      if (verdict === 'delete') item.children.delete(id);
      else if (verdict === 'descend') this.pruneChildren(child, decide);
    }
  }

  fileItemsOf(folder: vscode.WorkspaceFolder): vscode.TestItem[] {
    const items: vscode.TestItem[] = [];
    this.folderItem(folder).children.forEach((item) => {
      if (isFileItemId(folder.uri.fsPath, item.id)) items.push(item);
    });
    return items;
  }

  /** Removes the file at `path`, or every file under it when it was a folder. */
  removeFiles(folder: vscode.WorkspaceFolder, path: string): void {
    const root = this.folderItem(folder);
    for (const item of this.fileItemsOf(folder)) {
      if (item.uri && isAtOrUnder(item.uri.fsPath, path)) root.children.delete(item.id);
    }
    this.updatePlaceholder(folder);
  }

  /** Results from earlier runs go; tests declared in the source stay, whether or not they ran. */
  pruneResults(folder: vscode.WorkspaceFolder, live: Set<vscode.TestItem>): void {
    this.pruneChildren(this.folderItem(folder), (child) =>
      this.resultItems.has(child) && !live.has(child) ? 'delete' : 'descend',
    );
    this.updatePlaceholder(folder);
  }

  folderOf(item: vscode.TestItem): vscode.WorkspaceFolder | undefined {
    let root = item;
    while (root.parent) {
      root = root.parent;
    }
    return (vscode.workspace.workspaceFolders ?? []).find((folder) => folderItemId(folder.uri.fsPath) === root.id);
  }
}
