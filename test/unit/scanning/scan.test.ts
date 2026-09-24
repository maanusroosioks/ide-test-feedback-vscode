import { describe, expect, it } from 'vitest';
import { languageForFile, maskCommentsAndStrings, scanTestDeclarations } from '../../../src/ecosystems';
import { sliceLines, type TestDeclaration } from '../../../src/scanning';
import { declarationNamed as find, fixture, scan } from '../helpers/sourceFixtures';

function names(declarations: TestDeclaration[]): string[] {
  return declarations.map((declaration) => declaration.name);
}

function snippet(text: string, declaration: TestDeclaration): string {
  return sliceLines(text, declaration.startLine, declaration.endLine);
}

describe('languageForFile', () => {
  it('prefers the file extension over the platform default', () => {
    // The JVM platform hosts both Java and Kotlin, so the extension has to win.
    expect(languageForFile('/p/src/test/kotlin/FooTest.kt', 'jvm')).toBe('kotlin');
    expect(languageForFile('/p/src/test/java/FooTest.java', 'jvm')).toBe('java');
  });

  it("falls back to the platform's default language when the extension is unknown", () => {
    expect(languageForFile('/p/FooTest.groovy', 'jvm')).toBe('java');
  });
});

describe('maskCommentsAndStrings', () => {
  it('preserves length and newlines', () => {
    const text = 'a = "hello"  # trailing\nb = 2\n';
    const masked = maskCommentsAndStrings(text, 'python');
    expect(masked).toHaveLength(text.length);
    expect(masked.split('\n')).toHaveLength(text.split('\n').length);
  });

  it('blanks braces inside string literals but keeps the code around them', () => {
    const masked = maskCommentsAndStrings('if (x) { s = "}"; }', 'java');
    expect(masked).toBe('if (x) { s = " "; }');
  });

  it('handles C# verbatim strings, where "" escapes a quote', () => {
    const masked = maskCommentsAndStrings('var v = @"a } "" b"; var n = 1;', 'csharp');
    expect(masked).toBe('var v = @"        "; var n = 1;');
  });

  it('does not process escapes inside a Kotlin raw string', () => {
    const masked = maskCommentsAndStrings('val v = """a \\ } b""" + c', 'kotlin');
    expect(masked).toBe('val v = """       """ + c');
  });

  it('blanks block comments', () => {
    const masked = maskCommentsAndStrings('/* @Test */ void f() {}', 'java');
    expect(masked).not.toContain('@Test');
    expect(masked).toContain('void f() {}');
  });
});

describe('scanTestDeclarations — python', () => {
  const text = fixture('python/test_calculator.py');
  const declarations = scan('python/test_calculator.py', 'python');

  it('finds every test function and no helpers or commented-out decoys', () => {
    expect(names(declarations)).toEqual([
      'test_add_returns_sum',
      'test_divide_returns_quotient',
      'test_uses_a_nested_helper',
      'test_empty_body',
      'test_only_a_docstring',
      'test_skipped_outright',
      'test_async_add',
      'test_one_liner',
      'test_brace_in_a_string',
      'test_add',
      'test_divide_by_zero',
      'test_add',
    ]);
    expect(names(declarations)).not.toContain('helper');
    expect(names(declarations)).not.toContain('test_decoy');
  });

  it('includes a multi-line decorator in the snippet', () => {
    const code = snippet(text, find(declarations, 'test_divide_returns_quotient'));
    expect(code).toContain('@pytest.mark.parametrize');
    expect(code).toContain('(9, 3, 3),');
    expect(code).toContain('assert divide(a, b) == expected');
    expect(code).not.toContain('def test_uses_a_nested_helper');
  });

  it('ends the body by indentation, so a nested function stays inside', () => {
    const code = snippet(text, find(declarations, 'test_uses_a_nested_helper'));
    expect(code).toContain('def inner(value):');
    expect(code).toContain('assert inner(add(1, 1)) == 3');
    expect(code).not.toContain('def test_empty_body');
  });

  it('handles a one-line body', () => {
    const declaration = find(declarations, 'test_one_liner');
    expect(declaration.bodyText).toBe('assert add(0, 0) == 0');
    expect(declaration.startLine).toBe(declaration.endLine);
  });

  it('assigns class containers and their markers', () => {
    const inClass = declarations.filter((declaration) => declaration.name === 'test_add');
    expect(inClass.map((declaration) => declaration.container)).toEqual(['TestMath', 'TestParked']);
    expect(inClass[0].containerMarkers).toEqual([]);
    expect(inClass[1].containerMarkers).toEqual(['@pytest.mark.skip(reason="whole class parked")']);
  });

  it('records the test’s own markers', () => {
    expect(find(declarations, 'test_skipped_outright').markers).toEqual([
      '@pytest.mark.skip(reason="not implemented yet")',
    ]);
    expect(find(declarations, 'test_add_returns_sum').markers).toEqual([]);
  });

  it('treats a docstring-only body as the body', () => {
    expect(find(declarations, 'test_only_a_docstring').bodyText.trim()).toBe(
      '"""Should have asserted something."""',
    );
  });
});

describe('scanTestDeclarations — java', () => {
  const text = fixture('java/CalculatorTest.java');
  const declarations = scan('java/CalculatorTest.java', 'java');

  it('finds annotated tests and ignores helpers and Javadoc mentions', () => {
    expect(names(declarations)).toEqual([
      'addReturnsSum',
      'divideReturnsQuotient',
      'parkedTest',
      'displayNamed',
      'braceInsideAString',
      'emptyBody',
      'genericSignature',
      'throwsOnDivideByZero',
      'ambiguous',
      'ambiguous',
    ]);
    expect(names(declarations)).not.toContain('helper');
  });

  it('keeps @ParameterizedTest and @CsvSource together in the snippet', () => {
    const code = snippet(text, find(declarations, 'divideReturnsQuotient'));
    expect(code).toContain('@ParameterizedTest');
    expect(code).toContain('@CsvSource({');
    expect(code).toContain('"9, 3, 3"');
    expect(code).toContain('assertEquals(expected, calculator.divide(a, b));');
  });

  it('walks back over a stacked @Disabled', () => {
    const declaration = find(declarations, 'parkedTest');
    expect(declaration.markers).toEqual(['@Disabled("parked")', '@Test']);
    expect(snippet(text, declaration)).toContain('@Disabled("parked")');
  });

  it('does not absorb the preceding Javadoc block', () => {
    expect(snippet(text, find(declarations, 'addReturnsSum'))).not.toContain('Javadoc');
  });

  it('brace-matches past a brace inside a string literal', () => {
    expect(find(declarations, 'braceInsideAString').bodyText).toContain('calculator.format("{")');
  });

  it('handles a generic signature and a throws clause', () => {
    expect(find(declarations, 'genericSignature').bodyText).toContain('assertTrue');
    expect(find(declarations, 'throwsOnDivideByZero').bodyText).toContain('assertThrows');
  });

  it('records dotted containers for @Nested classes', () => {
    const ambiguous = declarations.filter((declaration) => declaration.name === 'ambiguous');
    expect(ambiguous.map((declaration) => declaration.container)).toEqual([
      'CalculatorTest.InnerCases',
      'CalculatorTest.OtherCases',
    ]);
    expect(ambiguous[0].containerMarkers).toEqual(['@Nested']);
  });

  it('reports an empty body as empty', () => {
    expect(find(declarations, 'emptyBody').bodyText.trim()).toBe('');
  });
});

describe('scanTestDeclarations — kotlin', () => {
  const declarations = scan('kotlin/CalculatorTest.kt', 'kotlin');

  it('finds backticked and expression-bodied tests', () => {
    expect(names(declarations)).toEqual([
      'adds two and three',
      'expressionBodied',
      'rawStringWithBrace',
      'emptyBody',
    ]);
  });

  it('captures an expression body', () => {
    expect(find(declarations, 'expressionBodied').bodyText).toBe(
      'assertTrue(calculator.add(1, 1) == 2)',
    );
  });

  it('brace-matches past a raw string containing braces', () => {
    const declaration = find(declarations, 'rawStringWithBrace');
    expect(declaration.bodyText).toContain('assertTrue(template.contains("not"))');
  });
});

describe('scanTestDeclarations — csharp', () => {
  const text = fixture('csharp/CalculatorTests.cs');
  const declarations = scan('csharp/CalculatorTests.cs', 'csharp');

  it('finds attributed tests and ignores array syntax and helpers', () => {
    expect(names(declarations)).toEqual([
      'Add_ReturnsSum',
      'Divide_ReturnsQuotient',
      'Divide_ByZero_Throws',
      'Parked',
      'DisplayNamed',
      'ExpressionBodied',
      'BraceInsideAString',
      'EmptyBody',
    ]);
    expect(names(declarations)).not.toContain('Helper');
  });

  it('keeps [Theory] and both [InlineData] rows in the snippet', () => {
    const code = snippet(text, find(declarations, 'Divide_ReturnsQuotient'));
    expect(code).toContain('[Theory]');
    expect(code).toContain('[InlineData(10, 2, 5)]');
    expect(code).toContain('[InlineData(9, 3, 3)]');
  });

  it('keeps angle brackets in generic assertions', () => {
    expect(find(declarations, 'Divide_ByZero_Throws').bodyText).toContain(
      'Assert.Throws<DivideByZeroException>',
    );
  });

  it('records Skip and DisplayName attributes as markers', () => {
    expect(find(declarations, 'Parked').markers).toEqual(['[Fact(Skip = "not implemented yet")]']);
    expect(find(declarations, 'DisplayNamed').markers).toEqual([
      '[Fact(DisplayName = "adds two and three")]',
    ]);
  });

  it('captures an expression body', () => {
    expect(find(declarations, 'ExpressionBodied').bodyText).toBe(
      'Assert.Equal(2, new Calculator().Add(1, 1))',
    );
  });

  it('brace-matches past a verbatim string containing a brace', () => {
    expect(find(declarations, 'BraceInsideAString').bodyText).toContain('Assert.Contains');
  });

  it('assigns the class as container, ignoring the namespace', () => {
    expect(find(declarations, 'Add_ReturnsSum').container).toBe('CalculatorTests');
  });
});

describe('scanTestDeclarations — edge cases', () => {
  it('python: ends a multi-line signature at its own colon, not a parameter annotation', () => {
    const [declaration] = scanTestDeclarations('def test_x(a,\n           b: int):\n    assert a\n', 'python');
    expect(declaration.bodyText).toBe('    assert a');
    expect(declaration.endLine).toBe(3);
  });

  it('python: ignores the indentation of a string closed at column 0', () => {
    const text = 'class TestA:\n    def test_a(self):\n        s = """\nabc\n"""\n        assert s\n\n    def test_b(self):\n        assert 1\n';
    const [first, second] = scanTestDeclarations(text, 'python');
    expect(first.bodyText).toContain('assert s');
    expect(second.container).toBe('TestA');
  });

  it('kotlin: reads backticked names holding `=` or parentheses', () => {
    const text = 'class T {\n  @Test\n  fun `1 + 1 = 2`() {\n    assertEquals(2, 1 + 1)\n  }\n  @Test\n  fun `divide(a, b) works`() {\n    assertTrue(x)\n  }\n}\n';
    expect(names(scanTestDeclarations(text, 'kotlin'))).toEqual(['1 + 1 = 2', 'divide(a, b) works']);
  });

  it('kotlin: captures an expression body that starts on the next line', () => {
    const text = 'class T {\n  @Test\n  fun a() =\n    runTest {\n      assertTrue(x)\n    }\n}\n';
    const [declaration] = scanTestDeclarations(text, 'kotlin');
    expect(declaration.bodyText).toContain('assertTrue(x)');
    expect(declaration.endLine).toBe(6);
  });

  it('kotlin: does not let a bodyless class claim the next class', () => {
    const text = 'data class Case(val a: Int)\n\nclass CalcTest {\n  @Test\n  fun a() { assertTrue(x) }\n}\n';
    expect(scanTestDeclarations(text, 'kotlin')[0].container).toBe('CalcTest');
  });

  it.each([
    ['kotlin', '@Nested\ninner class Inner {\n  @Test\n  fun a() { assertTrue(x) }\n}\n', ['@Nested']],
    ['java', '@Disabled("wip")\npublic final class FooTest {\n  @Test\n  void a() { assertTrue(x); }\n}\n', ['@Disabled("wip")']],
    ['csharp', '[Ignore("wip")]\npublic sealed class FooTests\n{\n    [Test]\n    public void A() { Assert.Pass(); }\n}\n', ['[Ignore("wip")]']],
  ] as const)('%s: collects type markers across modifiers', (language, text, expected) => {
    expect(scanTestDeclarations(text, language)[0].containerMarkers).toEqual(expected);
  });

  it("kotlin: reads a backticked name holding an apostrophe, which opens no char literal", () => {
    const text = "class T {\n  @Test\n  fun `doesn't crash`() {\n    assertTrue(x)\n  }\n  @Test\n  fun other() { assertTrue(y) }\n}\n";
    const declarations = scanTestDeclarations(text, 'kotlin');
    expect(names(declarations)).toEqual(["doesn't crash", 'other']);
    expect(declarations[0].endLine).toBe(5);
  });

  it('kotlin: follows an expression body onto a line opening with `.`', () => {
    const text = 'class T {\n  @Test\n  fun a() = assertThat(x)\n    .isEqualTo(1)\n}\n';
    expect(scanTestDeclarations(text, 'kotlin')[0].bodyText).toBe('assertThat(x)\n    .isEqualTo(1)');
  });

  it('kotlin: does not let a bodyless nested class claim the following test', () => {
    const text = '@Disabled\nclass OuterTest {\n  data class Case(val a: Int)\n  @Test\n  fun a() { assertTrue(x) }\n}\n';
    const [declaration] = scanTestDeclarations(text, 'kotlin');
    expect(declaration.container).toBe('OuterTest');
    expect(declaration.containerMarkers).toEqual(['@Disabled']);
  });

  it.each([
    ['java', '@Disabled\nclass OuterTest {\n  @Nested\n  class Inner {\n    @Test\n    void a() { assertTrue(x); }\n  }\n}\n', ['@Disabled', '@Nested']],
    ['python', '@pytest.mark.skip\nclass TestOuter:\n    class TestInner:\n        def test_a(self):\n            assert 1\n', ['@pytest.mark.skip']],
  ] as const)('%s: carries an outer class’s markers to nested tests', (language, text, expected) => {
    expect(scanTestDeclarations(text, language)[0].containerMarkers).toEqual(expected);
  });

  it('csharp: names a `record struct` by its name, not its second keyword', () => {
    const text = 'public record struct Point(int X)\n{\n    [Fact]\n    public void A() { Assert.True(x); }\n}\n';
    expect(scanTestDeclarations(text, 'csharp')[0].container).toBe('Point');
  });

  it('csharp: finds a generic test method', () => {
    const text = 'public class FooTests\n{\n    [Theory]\n    [InlineData(1)]\n    public void Generic<T>(T x) { Assert.NotNull(x); }\n}\n';
    expect(names(scanTestDeclarations(text, 'csharp'))).toEqual(['Generic']);
  });
});

describe('sliceLines', () => {
  const text = 'one\ntwo\nthree\nfour\n';

  it('slices an inclusive 1-based line range without a trailing newline', () => {
    expect(sliceLines(text, 2, 3)).toBe('two\nthree');
    expect(sliceLines(text, 1, 1)).toBe('one');
  });

  it('clamps to the end of the text', () => {
    expect(sliceLines(text, 4, 99)).toBe('four');
  });
});
