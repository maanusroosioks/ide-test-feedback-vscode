import { describe, expect, it } from 'vitest';
import { createStatusReporter } from '../../../src/ui/statusBar';
import { StatusBarAlignment, ThemeColor, window, type FakeStatusBarItem } from '../helpers/vscodeStub';

function createReporter() {
  const reporter = createStatusReporter();
  const item = window.createStatusBarItem.mock.results[0].value as FakeStatusBarItem;
  return { reporter, item };
}

describe('createStatusReporter', () => {
  it('shows an idle item on the left that opens the log', () => {
    const { item } = createReporter();

    expect(window.createStatusBarItem).toHaveBeenCalledWith(StatusBarAlignment.Left, 100);
    expect(item.command).toBe('moodleSubmit.showOutput');
    expect(item.text).toBe('$(beaker) Moodle Submit');
    expect(item.show).toHaveBeenCalledOnce();
  });

  it('shows a spinner while tests run', () => {
    const { reporter, item } = createReporter();

    reporter.running();

    expect(item.text).toBe('$(sync~spin) Running tests…');
    expect(item.backgroundColor).toBeUndefined();
  });

  it('shows the pass count when everything passed', () => {
    const { reporter, item } = createReporter();

    reporter.result({ total: 4, passed: 3, failed: 0, skipped: 1 });

    expect(item.text).toBe('$(check) 3/4 passed');
    expect(item.backgroundColor).toBeUndefined();
  });

  it('shows the failure count on an error background when anything failed', () => {
    const { reporter, item } = createReporter();

    reporter.result({ total: 4, passed: 2, failed: 2, skipped: 0 });

    expect(item.text).toBe('$(x) 2/4 failed');
    expect(item.backgroundColor).toEqual(new ThemeColor('statusBarItem.errorBackground'));
  });

  it('puts the error message in the tooltip, and idle clears it', () => {
    const { reporter, item } = createReporter();

    reporter.error('Submission service returned 500');
    expect(item.text).toBe('$(error) Moodle submit failed');
    expect(item.tooltip).toBe('Submission service returned 500');
    expect(item.backgroundColor).toEqual(new ThemeColor('statusBarItem.errorBackground'));

    reporter.idle();
    expect(item.text).toBe('$(beaker) Moodle Submit');
    expect(item.tooltip).toBeUndefined();
    expect(item.backgroundColor).toBeUndefined();
  });

  it('a new run clears the previous error state', () => {
    const { reporter, item } = createReporter();

    reporter.error('boom');
    reporter.running();

    expect(item.tooltip).toBeUndefined();
    expect(item.backgroundColor).toBeUndefined();
  });

  it('disposes the item', () => {
    const { reporter, item } = createReporter();

    reporter.dispose();

    expect(item.dispose).toHaveBeenCalledOnce();
  });
});
