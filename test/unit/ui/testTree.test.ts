import { describe, expect, it } from 'vitest';
import {
  NO_SUITE,
  classItemId,
  declarationItemId,
  fileItemId,
  folderItemId,
  isFileItemId,
  resultItemId,
  suiteDescription,
  suiteItemId,
  suiteKey,
  suiteLabel,
  testItemId,
} from '../../../src/ui/testTree';

describe('discovered item ids', () => {
  const file = fileItemId('/work/proj', 'tests/test_math.py');

  it('keys a test by its file, its classes and its name', () => {
    expect(file).toBe('/work/proj::/tests/test_math.py');
    expect(classItemId(file, 'Outer.Inner')).toBe('/work/proj::/tests/test_math.py::Outer.Inner');
    expect(declarationItemId(file, 'Outer.Inner', 'test_add')).toBe(
      '/work/proj::/tests/test_math.py::Outer.Inner::test_add',
    );
    expect(declarationItemId(file, undefined, 'test_add')).toBe('/work/proj::/tests/test_math.py::::test_add');
  });

  it('never mistakes a fallback suite for a file', () => {
    expect(isFileItemId('/work/proj', file)).toBe(true);
    expect(isFileItemId('/work/proj', suiteItemId('/work/proj', 'tests.test_math'))).toBe(false);
    expect(isFileItemId('/work/proj', fileItemId('/work/other', 'test_x.py'))).toBe(false);
  });

  it('keeps a run-time result apart from a test or class of the same name', () => {
    const declared = declarationItemId(file, undefined, 'test_add');
    expect(resultItemId(declared, 'test_add[1-2]')).toBe(`${declared}::run:test_add[1-2]`);
    expect(resultItemId(file, 'Outer')).not.toBe(classItemId(file, 'Outer'));
  });
});

describe('testTree ids', () => {
  it('namespaces suites and tests under their folder', () => {
    expect(folderItemId('/work/proj')).toBe('/work/proj');
    expect(suiteItemId('/work/proj', 'com.pkg.FooTest')).toBe('/work/proj::com.pkg.FooTest');
    expect(testItemId('/work/proj', 'com.pkg.FooTest', 'addsUp')).toBe(
      '/work/proj::com.pkg.FooTest::addsUp',
    );
  });

  it('keeps ids distinct for same-named suites in different folders', () => {
    expect(suiteItemId('/a', 'FooTest')).not.toBe(suiteItemId('/b', 'FooTest'));
  });
});

describe('suiteKey', () => {
  it('falls back to a placeholder for missing or blank suites', () => {
    expect(suiteKey(undefined)).toBe(NO_SUITE);
    expect(suiteKey('   ')).toBe(NO_SUITE);
  });

  it('trims a real suite name', () => {
    expect(suiteKey(' com.pkg.FooTest ')).toBe('com.pkg.FooTest');
  });
});

describe('suiteLabel', () => {
  it('shows only the class name for a fully-qualified suite', () => {
    expect(suiteLabel('com.pkg.FooTest')).toBe('FooTest');
    expect(suiteDescription('com.pkg.FooTest')).toBe('com.pkg.FooTest');
  });

  it('leaves an unqualified suite alone and adds no redundant description', () => {
    expect(suiteLabel('FooTest')).toBe('FooTest');
    expect(suiteDescription('FooTest')).toBeUndefined();
  });

  it('does not blank out a suite name that ends in a dot', () => {
    expect(suiteLabel('FooTest.')).toBe('FooTest.');
  });
});
