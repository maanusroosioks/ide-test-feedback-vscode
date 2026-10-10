import { describe, expect, it } from 'vitest';
import { analyzeDeclaration } from '../../../src/capture/integrity';
import type { SourceLanguage } from '../../../src/ecosystems';
import { declaration, declarationNamed, declarations } from '../helpers/sourceFixtures';

function analyze(language: SourceLanguage, name: string) {
  return analyzeDeclaration(declarationNamed(declarations[language], name), language);
}

describe('analyzeDeclaration — python', () => {
  it('counts bare asserts', () => {
    expect(analyze('python', 'test_add_returns_sum').assertionCount).toBe(1);
  });

  it('counts pytest.raises as an assertion', () => {
    expect(analyze('python', 'test_divide_by_zero').assertionCount).toBe(1);
  });

  it('flags a pass-only body as empty with no assertions', () => {
    expect(analyze('python', 'test_empty_body')).toMatchObject({
      located: true,
      empty: true,
      assertionCount: 0,
    });
  });

  it('flags a body that only returns None as empty', () => {
    expect(analyzeDeclaration(declaration({ bodyText: '    return None' }), 'python').empty).toBe(true);
  });

  it('flags a docstring-only body as empty', () => {
    expect(analyze('python', 'test_only_a_docstring')).toMatchObject({
      empty: true,
      assertionCount: 0,
    });
  });

  it('reads a skip decorator on the test', () => {
    expect(analyze('python', 'test_skipped_outright')).toMatchObject({
      skipMarker: '@pytest.mark.skip(reason="not implemented yet")',
    });
  });

  it('reads a skip decorator inherited from the class', () => {
    const parked = declarations.python.find((d) => d.name === 'test_add' && d.container === 'TestParked');
    expect(analyzeDeclaration(parked!, 'python')).toMatchObject({
      skipMarker: '@pytest.mark.skip(reason="whole class parked")',
    });
  });

  it.each(['@unittest.skip("parked")', '@skip'])('reads the unconditional skip %s', (marker) => {
    const skipped = declaration({ markers: [marker], bodyText: '    assert True' });
    expect(analyzeDeclaration(skipped, 'python').skipMarker).toBe(marker);
  });

  it.each([
    '@pytest.mark.skipif(sys.platform == "win32", reason="posix only")',
    '@unittest.skipIf(sys.version_info < (3, 12), "needs 3.12")',
    '@unittest.skipUnless(HAS_NUMPY, "needs numpy")',
  ])('does not treat the conditional %s as a skip, since the test usually runs', (marker) => {
    const conditional = declaration({ markers: [marker], bodyText: '    assert True' });
    expect(analyzeDeclaration(conditional, 'python').skipMarker).toBeUndefined();
  });

  it('does not double-count self.assertX as a bare assert', () => {
    expect(analyzeDeclaration(declaration({ bodyText: 'self.assertEqual(1, 1)' }), 'python').assertionCount).toBe(1);
  });

  it('ignores an assert that only appears in a comment or a string', () => {
    const commented = declaration({ bodyText: '# assert 1 == 2\nvalue = "assert 3 == 4"\n' });
    expect(analyzeDeclaration(commented, 'python').assertionCount).toBe(0);
  });
});

describe('analyzeDeclaration — java and kotlin', () => {
  it('counts assertEquals and assertThrows', () => {
    expect(analyze('java', 'addReturnsSum').assertionCount).toBe(1);
    expect(analyze('java', 'throwsOnDivideByZero').assertionCount).toBe(1);
  });

  it('flags an empty method body', () => {
    expect(analyze('java', 'emptyBody')).toMatchObject({ empty: true, assertionCount: 0 });
    expect(analyze('kotlin', 'emptyBody')).toMatchObject({ empty: true, assertionCount: 0 });
  });

  it('reads @Disabled as a skip marker', () => {
    expect(analyze('java', 'parkedTest')).toMatchObject({
      skipMarker: '@Disabled("parked")',
    });
  });

  it('leaves an ordinary test unmarked', () => {
    expect(analyze('java', 'addReturnsSum')).toMatchObject({
      skipMarker: undefined,
      empty: false,
    });
  });

  it('counts an assertion in a Kotlin expression body', () => {
    expect(analyze('kotlin', 'expressionBodied').assertionCount).toBe(1);
  });

  it('does not count an assertEquals that only appears in a comment', () => {
    const commented = declaration({ bodyText: '// assertEquals(1, 2);\nint x = 1;' });
    expect(analyzeDeclaration(commented, 'java')).toMatchObject({ assertionCount: 0, empty: false });
  });
});

describe('analyzeDeclaration — csharp', () => {
  it('counts Assert.Equal', () => {
    expect(analyze('csharp', 'Add_ReturnsSum').assertionCount).toBe(1);
  });

  it('counts a generic Assert.Throws<T>', () => {
    expect(analyze('csharp', 'Divide_ByZero_Throws').assertionCount).toBe(1);
  });

  it('reads Skip = "…" on the attribute', () => {
    expect(analyze('csharp', 'Parked')).toMatchObject({
      skipMarker: '[Fact(Skip = "not implemented yet")]',
    });
  });

  it('does not treat DisplayName as a skip', () => {
    expect(analyze('csharp', 'DisplayNamed').skipMarker).toBeUndefined();
  });

  it('flags an empty body', () => {
    expect(analyze('csharp', 'EmptyBody')).toMatchObject({ empty: true, assertionCount: 0 });
  });
});
