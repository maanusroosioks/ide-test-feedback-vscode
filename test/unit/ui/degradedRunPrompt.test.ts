import { describe, expect, it } from 'vitest';
import type { SuspiciousTest } from '../../../src/capture/integrity';
import { confirmDegradedRun, describeFinding } from '../../../src/ui/degradedRunPrompt';
import { window } from '../helpers/vscodeStub';

function finding(testName: string, testSuite?: string): SuspiciousTest {
  return { testSuite, testName, reasons: ['has an empty body'] };
}

describe('describeFinding', () => {
  it('qualifies the test with its suite and joins the reasons', () => {
    expect(
      describeFinding({
        testSuite: 'CalculatorTest',
        testName: 'adds',
        reasons: ['has an empty body', 'is marked as skipped (@Disabled)'],
      }),
    ).toBe('CalculatorTest.adds — has an empty body; is marked as skipped (@Disabled)');
  });

  it('uses the bare name when there is no suite', () => {
    expect(describeFinding(finding('test_adds'))).toBe('test_adds — has an empty body');
  });
});

describe('confirmDegradedRun', () => {
  it('proceeds without asking when nothing looks suspicious', async () => {
    expect(await confirmDegradedRun([], 10)).toBe(true);
    expect(window.showWarningMessage).not.toHaveBeenCalled();
  });

  it('shows a modal warning listing the findings', async () => {
    await confirmDegradedRun([finding('a', 'S'), finding('b')], 7);

    expect(window.showWarningMessage).toHaveBeenCalledWith(
      '2 of 7 tests look like they may have been emptied or disabled.',
      { modal: true, detail: 'S.a — has an empty body\nb — has an empty body' },
      'Submit anyway',
    );
  });

  it('lists at most ten findings and counts the rest', async () => {
    const findings = Array.from({ length: 13 }, (_, i) => finding(`t${i}`));

    await confirmDegradedRun(findings, 20);

    const { detail } = window.showWarningMessage.mock.calls[0][1] as { detail: string };
    const lines = detail.split('\n');
    expect(lines).toHaveLength(11);
    expect(lines[9]).toBe('t9 — has an empty body');
    expect(lines[10]).toBe('…and 3 more');
  });

  it('submits only on an explicit "Submit anyway"', async () => {
    window.showWarningMessage.mockResolvedValueOnce('Submit anyway');
    expect(await confirmDegradedRun([finding('a')], 1)).toBe(true);

    window.showWarningMessage.mockResolvedValueOnce(undefined);
    expect(await confirmDegradedRun([finding('a')], 1)).toBe(false);
  });
});
