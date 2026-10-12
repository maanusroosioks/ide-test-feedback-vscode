import * as vscode from 'vscode';
import type { RunSummary, StatusReporter } from '../core/ports';
import { COMMANDS } from '../commands/ids';

export type DisposableStatusReporter = StatusReporter & vscode.Disposable;

export function createStatusReporter(): DisposableStatusReporter {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  item.command = COMMANDS.showOutput;

  const show = (text: string, { tooltip, isError = false }: { tooltip?: string; isError?: boolean } = {}): void => {
    item.text = text;
    item.tooltip = tooltip;
    item.backgroundColor = isError ? new vscode.ThemeColor('statusBarItem.errorBackground') : undefined;
  };
  const idle = (): void => show('$(beaker) IDE Test Feedback');

  idle();
  item.show();

  return {
    running(): void {
      show('$(sync~spin) Running tests…');
    },
    result(summary: RunSummary): void {
      if (summary.failed === 0) {
        show(`$(check) ${summary.passed}/${summary.total} passed`);
      } else {
        show(`$(x) ${summary.failed}/${summary.total} failed`, { isError: true });
      }
    },
    error(message: string): void {
      show('$(error) IDE Test Feedback', { tooltip: message, isError: true });
    },
    idle,
    dispose(): void {
      item.dispose();
    },
  };
}
