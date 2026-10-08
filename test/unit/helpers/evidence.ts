import { expect } from 'vitest';
import type { DeclaredSource, TestEvidence, TestSource, TestSourceKind } from '../../../src/capture/evidence';

export function kindsOf(evidence: TestEvidence): TestSourceKind[] {
  return evidence.payload.sources.map((source) => source.kind);
}

export function filePathOf(source: TestSource): string | undefined {
  return source.kind === 'NONE' ? undefined : source.filePath;
}

/** Fails the test unless result `index` was located down to its declaration. */
export function declaredAt(evidence: TestEvidence, index: number): DeclaredSource {
  const source = evidence.payload.sources[index];
  expect(source.kind, `source ${index}`).toBe('TEST');
  return source as DeclaredSource;
}
