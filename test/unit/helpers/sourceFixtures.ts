import { expect } from 'vitest';
import { scanTestDeclarations, type SourceLanguage } from '../../../src/ecosystems';
import type { TestDeclaration } from '../../../src/scanning';
import { readFixture } from './project';

/** `relative` is from test/unit/fixtures/source. */
export function fixture(relative: string): string {
  return readFixture(`source/${relative}`);
}

export function scan(relative: string, language: SourceLanguage): TestDeclaration[] {
  return scanTestDeclarations(fixture(relative), language);
}

/** Scanned once and shared: every suite below asserts against the same four fixtures. */
export const declarations = {
  python: scan('python/test_calculator.py', 'python'),
  java: scan('java/CalculatorTest.java', 'java'),
  kotlin: scan('kotlin/CalculatorTest.kt', 'kotlin'),
  csharp: scan('csharp/CalculatorTests.cs', 'csharp'),
};

/** A hand-built declaration, for analysis that only cares about a field or two. */
export function declaration(fields: Partial<TestDeclaration> = {}): TestDeclaration {
  return { name: 'x', startLine: 1, endLine: 1, markers: [], containerMarkers: [], bodyText: '', ...fields };
}

/** Fails the test rather than silently picking one when a fixture has same-named declarations. */
export function declarationNamed(found: TestDeclaration[], name: string): TestDeclaration {
  const hits = found.filter((declaration) => declaration.name === name);
  expect(hits, `expected exactly one declaration named ${name}`).toHaveLength(1);
  return hits[0];
}
