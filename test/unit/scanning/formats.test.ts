// Formatting variants and edge cases, one small source per row, so a regression names its case.

import { describe, expect, it } from 'vitest';
import { maskCommentsAndStrings, scanTestDeclarations, type SourceLanguage } from '../../../src/ecosystems';
import { fixture } from '../helpers/sourceFixtures';

interface Expect {
  names: string[];
  /** The rest are checked against the first named declaration. */
  container?: string;
  body?: string;
  markers?: string[];
  containerMarkers?: string[];
  lines?: [number, number];
}

const CASES: Array<[string, SourceLanguage, string, Expect]> = [
  // ---------------- java
  ['java allman', 'java', 'class T\n{\n  @Test\n  public void a()\n  {\n    assertTrue(x);\n  }\n}\n', { names: ['a'], body: 'assertTrue', lines: [3, 7] }],
  ['java same line', 'java', 'class T { @Test public void a() { assertTrue(x); } }', { names: ['a'], container: 'T' }],
  ['java line comment between', 'java', 'class T {\n  @Test // flaky\n  void a() { assertTrue(x); }\n}\n', { names: ['a'], markers: ['@Test'] }],
  ['java block comment between', 'java', 'class T {\n  @Disabled /* later */ @Test\n  void a() { assertTrue(x); }\n}\n', { names: ['a'], markers: ['@Disabled', '@Test'] }],
  ['java comment line between stacked', 'java', 'class T {\n  @Disabled\n  // reason\n  @Test\n  void a() { assertTrue(x); }\n}\n', { names: ['a'], markers: ['@Disabled', '@Test'] }],
  ['java javadoc before', 'java', 'class T {\n  /** Docs {@link X} */\n  @Test\n  void a() { assertTrue(x); }\n}\n', { names: ['a'], lines: [3, 4] }],
  ['java many on one line', 'java', 'class T {\n  @Test @DisplayName("x") @Tag("y") void a() { assertTrue(x); }\n}\n', { names: ['a'], markers: ['@Test', '@DisplayName("x")', '@Tag("y")'] }],
  ['java multi-line annotation', 'java', 'class T {\n  @ParameterizedTest\n  @CsvSource({\n    "1, 2",\n    "3, 4"\n  })\n  void a(int x, int y) { assertTrue(x); }\n}\n', { names: ['a'], lines: [2, 7] }],
  ['java space after @', 'java', 'class T {\n  @ Disabled\n  @ Test\n  void a() { assertTrue(x); }\n}\n', { names: ['a'], markers: ['@ Disabled', '@ Test'] }],
  ['java qualified', 'java', 'class T {\n  @org.junit.jupiter.api.Test\n  void a() { assertTrue(x); }\n}\n', { names: ['a'] }],
  ['java empty parens', 'java', 'class T {\n  @Test()\n  void a() { assertTrue(x); }\n}\n', { names: ['a'] }],
  ['java junit4 expected', 'java', 'class T {\n  @Test(expected = IllegalStateException.class)\n  public void a() { f(); }\n}\n', { names: ['a'], container: 'T' }],
  ['java generic', 'java', 'class T {\n  @Test\n  <T extends Comparable<T>> void a() { assertTrue(x); }\n}\n', { names: ['a'] }],
  ['java throws multiline', 'java', 'class T {\n  @Test\n  void a()\n      throws IOException,\n             InterruptedException {\n    assertTrue(x);\n  }\n}\n', { names: ['a'], body: 'assertTrue' }],
  ['java param annotations', 'java', 'class T {\n  @Test\n  void a(@TempDir Path dir) { assertTrue(x); }\n}\n', { names: ['a'] }],
  ['java modifiers', 'java', 'class T {\n  @Test\n  public final synchronized void a() { assertTrue(x); }\n}\n', { names: ['a'] }],
  ['java multi-line class header', 'java', '@Disabled\npublic class FooTest\n    extends Base<Foo>\n    implements A, B\n{\n  @Test\n  void a() { assertTrue(x); }\n}\n', { names: ['a'], container: 'FooTest', containerMarkers: ['@Disabled'] }],
  ['java string with )', 'java', 'class T {\n  @DisplayName("a) b {")\n  @Test\n  void a() { assertTrue(x); }\n}\n', { names: ['a'] }],
  ['java text block', 'java', 'class T {\n  @Test\n  void a() {\n    String s = """\n      @Test void b() { }\n      """;\n    assertTrue(s);\n  }\n}\n', { names: ['a'], lines: [2, 8] }],
  ['java char literals', 'java', "class T {\n  @Test\n  void a() { char c = '{'; char d = '\"'; char e = '\\''; assertTrue(x); }\n  @Test\n  void b() { assertTrue(y); }\n}\n", { names: ['a', 'b'] }],
  ['java interface default', 'java', 'interface T {\n  @Test\n  default void a() { assertTrue(x); }\n}\n', { names: ['a'], container: 'T' }],
  ['java anon class in body', 'java', 'class T {\n  @Test\n  void a() {\n    Runnable r = new Runnable() { public void run() { } };\n    assertTrue(x);\n  }\n  @Test void b() { assertTrue(y); }\n}\n', { names: ['a', 'b'] }],
  ['java closing brace same line', 'java', 'class T {\n  @Test void a() { assertTrue(x); } @Test void b() { assertTrue(y); }\n}\n', { names: ['a', 'b'] }],
  ['java unicode names', 'java', 'class KalkulaatorÕTest {\n  @Test\n  void liidabÕigesti() { assertTrue(x); }\n}\n', { names: ['liidabÕigesti'], container: 'KalkulaatorÕTest' }],
  ['java tabs', 'java', 'class T {\n\t@Test\n\tvoid a() {\n\t\tassertTrue(x);\n\t}\n}\n', { names: ['a'] }],
  ['java crlf', 'java', 'class T {\r\n  @Test\r\n  void a() {\r\n    assertTrue(x);\r\n  }\r\n}\r\n', { names: ['a'], lines: [2, 5] }],
  ['java unterminated (mid-edit)', 'java', 'class T {\n  @Test\n  void a() {\n    assertTrue(x);\n  @Test\n  void b() { assertTrue(y); }\n', { names: ['b'] }],
  ['java record', 'java', 'record P(int x) {\n  @Test\n  void a() { assertTrue(x); }\n}\n', { names: ['a'], container: 'P' }],
  ['java field annotation before', 'java', 'class T {\n  @RegisterExtension\n  static Ext ext = new Ext();\n  @Test\n  void a() { assertTrue(x); }\n}\n', { names: ['a'], markers: ['@Test'] }],
  ['java commented test', 'java', 'class T {\n  // @Test\n  // void a() { }\n  /*\n  @Test\n  void b() { }\n  */\n  @Test void c() { assertTrue(x); }\n}\n', { names: ['c'] }],
  // ---------------- kotlin
  ['kt one line', 'kotlin', 'class T { @Test fun a() { assertTrue(x) } }', { names: ['a'], container: 'T' }],
  ['kt allman', 'kotlin', 'class T\n{\n  @Test\n  fun a()\n  {\n    assertTrue(x)\n  }\n}\n', { names: ['a'], lines: [3, 7] }],
  ['kt return type', 'kotlin', 'class T {\n  @Test\n  fun a(): Unit {\n    assertTrue(x)\n  }\n}\n', { names: ['a'], body: 'assertTrue' }],
  ['kt runBlocking generic', 'kotlin', 'class T {\n  @Test\n  fun a() = runBlocking<Unit> {\n    assertTrue(x)\n  }\n  @Test fun b() {}\n}\n', { names: ['a', 'b'], lines: [2, 5] }],
  ['kt backtick quotes', 'kotlin', 'class T {\n  @Test\n  fun `handles "quoted" // and /* */ text`() { assertTrue(x) }\n}\n', { names: ['handles "quoted" // and /* */ text'] }],
  ['kt odd quote in backtick', 'kotlin', 'class T {\n  @Test\n  fun `a " b`() { assertTrue(x) }\n  @Test fun c() {}\n}\n', { names: ['a " b', 'c'] }],
  ['kt array annotation', 'kotlin', 'class T {\n  @ParameterizedTest\n  @ValueSource(ints = [1, 2, 3])\n  fun a(x: Int) { assertTrue(x) }\n}\n', { names: ['a'], markers: ['@ParameterizedTest', '@ValueSource(ints = [1, 2, 3])'] }],
  ['kt modifiers', 'kotlin', 'class T {\n  @Test\n  internal suspend fun a() { assertTrue(x) }\n}\n', { names: ['a'] }],
  ['kt object', 'kotlin', 'object T {\n  @Test\n  fun a() { assertTrue(x) }\n}\n', { names: ['a'], container: 'T' }],
  ['kt companion', 'kotlin', 'class T {\n  companion object {\n    @JvmStatic fun data() = listOf(1)\n  }\n  @Test fun a() { assertTrue(x) }\n}\n', { names: ['a'], container: 'T' }],
  ['kt template', 'kotlin', 'class T {\n  @Test\n  fun a() {\n    val s = "${x} and ${if (y) "}" else "{"}"\n    assertTrue(s)\n  }\n  @Test fun b() {}\n}\n', { names: ['a', 'b'], lines: [2, 6] }],
  ['kt nested comment', 'kotlin', 'class T {\n  /* outer /* inner */ @Test fun ghost() { } */\n  @Test fun a() { assertTrue(x) }\n}\n', { names: ['a'] }],
  ['kt expr body closes class', 'kotlin', 'class T { @Test fun a() = check(x) }\nclass U { @Test fun b() = check(y) }\n', { names: ['a', 'b'] }],
  ['kt generic fun', 'kotlin', 'class T {\n  @Test\n  fun <T> a() { assertTrue(x) }\n}\n', { names: ['a'] }],
  ['kt multi-line header', 'kotlin', '@Disabled\nclass T(\n  private val x: Int = 1,\n) : Base(),\n  Other {\n  @Test fun a() { assertTrue(x) }\n}\n', { names: ['a'], container: 'T', containerMarkers: ['@Disabled'] }],
  ['kt use-site target before', 'kotlin', 'class T {\n  @get:Rule\n  val tmp = TemporaryFolder()\n  @Test fun a() { assertTrue(x) }\n}\n', { names: ['a'], markers: ['@Test'] }],
  ['kt property no semicolon before', 'kotlin', 'class T {\n  private val calc = Calculator()\n  @Test\n  fun a() { assertTrue(x) }\n}\n', { names: ['a'], markers: ['@Test'] }],
  ['kt elvis continuation', 'kotlin', 'class T {\n  @Test\n  fun a() = x\n    ?: fail()\n}\n', { names: ['a'], body: 'fail()' }],
  ['kt unicode', 'kotlin', 'class ÕunTest {\n  @Test\n  fun kasÕige() { assertTrue(x) }\n}\n', { names: ['kasÕige'], container: 'ÕunTest' }],
  ['kt enum class body', 'kotlin', 'enum class Color { RED, GREEN }\nclass T {\n  @Test fun a() { assertTrue(x) }\n}\n', { names: ['a'], container: 'T' }],
  ['kt sealed bodyless chain', 'kotlin', 'sealed interface S\nobject A : S\ndata class B(val x: Int) : S\nclass T {\n  @Test fun a() { assertTrue(x) }\n}\n', { names: ['a'], container: 'T' }],
  // ---------------- csharp
  ['cs k&r', 'csharp', 'public class T {\n    [Fact]\n    public void A() {\n        Assert.True(x);\n    }\n}\n', { names: ['A'], container: 'T' }],
  ['cs same line attr', 'csharp', 'public class T\n{\n    [Fact] public void A() { Assert.True(x); }\n}\n', { names: ['A'] }],
  ['cs attrs same line', 'csharp', 'public class T\n{\n    [Test][Category("x")]\n    public void A() { Assert.True(x); }\n}\n', { names: ['A'], markers: ['[Test]', '[Category("x")]'] }],
  ['cs trait first', 'csharp', 'public class T\n{\n    [Trait("Category", "Unit"), Fact]\n    public void A() { Assert.True(x); }\n}\n', { names: ['A'] }],
  ['cs attribute suffix', 'csharp', 'public class T\n{\n    [FactAttribute]\n    public void A() { Assert.True(x); }\n}\n', { names: ['A'] }],
  ['cs qualified', 'csharp', 'public class T\n{\n    [Xunit.Fact]\n    public void A() { Assert.True(x); }\n}\n', { names: ['A'] }],
  ['cs testcasesource', 'csharp', 'public class T\n{\n    [TestCaseSource(nameof(Cases))]\n    public void A(int x) { Assert.That(x); }\n}\n', { names: ['A'] }],
  ['cs async', 'csharp', 'public class T\n{\n    [Fact]\n    public async Task A()\n    {\n        await Task.Delay(1);\n        Assert.True(x);\n    }\n}\n', { names: ['A'], body: 'Assert.True' }],
  ['cs expr next line', 'csharp', 'public class T\n{\n    [Fact]\n    public void A()\n        => Assert.True(x);\n}\n', { names: ['A'], body: 'Assert.True(x)' }],
  ['cs region/if', 'csharp', "public class T\n{\n    #region Don't (touch)\n    [Fact]\n    public void A() { Assert.True(x); }\n    #endregion\n#if DEBUG\n    [Fact] public void B() { Assert.True(y); }\n#endif\n}\n", { names: ['A', 'B'] }],
  ['cs strings', 'csharp', "public class T\n{\n    [Fact]\n    public void A() { var a = $@\"{x} }} \"\"q\"\"\"; var b = \"\"\"\n raw } \" \n\"\"\"; var c = '\"'; Assert.True(x); }\n    [Fact] public void B() { Assert.True(y); }\n}\n", { names: ['A', 'B'] }],
  ['cs file-scoped ns', 'csharp', 'namespace Foo.Bar;\n\n[TestFixture]\npublic sealed class T\n{\n    [Test]\n    public void A() { Assert.Pass(); }\n}\n', { names: ['A'], container: 'T', containerMarkers: ['[TestFixture]'] }],
  ['cs constraint', 'csharp', 'public class T<TItem> where TItem : class, new()\n{\n    [Fact]\n    public void A() { Assert.True(x); }\n}\n', { names: ['A'], container: 'T' }],
  ['cs default param', 'csharp', 'public class T\n{\n    [Theory]\n    [InlineData(1)]\n    public void A(int x, int y = 2) { Assert.True(x == y); }\n}\n', { names: ['A'] }],
  ['cs indexer before', 'csharp', 'public class T\n{\n    private int[] a = new int[3];\n    public int this[int i] => a[i];\n    [Fact]\n    public void A() { Assert.True(x); }\n}\n', { names: ['A'], markers: ['[Fact]'] }],
  ['cs unicode', 'csharp', 'public class ÕunTests\n{\n    [Fact]\n    public void KasÕige() { Assert.True(x); }\n}\n', { names: ['KasÕige'], container: 'ÕunTests' }],
  ['cs attr multi-line args', 'csharp', 'public class T\n{\n    [Theory]\n    [InlineData(\n        1,\n        2)]\n    public void A(int x, int y) { Assert.True(x); }\n}\n', { names: ['A'], lines: [3, 7] }],
  // ---------------- python
  ['py tabs', 'python', 'class TestA:\n\tdef test_a(self):\n\t\tassert 1\n\n\tdef test_b(self):\n\t\tassert 2\n', { names: ['test_a', 'test_b'], container: 'TestA' }],
  ['py comment between decorator', 'python', '@pytest.mark.skip\n# because\ndef test_a():\n    assert 1\n', { names: ['test_a'], markers: ['@pytest.mark.skip'] }],
  ['py blank between decorators', 'python', '@pytest.mark.slow\n\n@pytest.mark.skip\ndef test_a():\n    assert 1\n', { names: ['test_a'], markers: ['@pytest.mark.slow', '@pytest.mark.skip'] }],
  ['py return annotation', 'python', 'def test_a() -> None:\n    assert 1\n', { names: ['test_a'], body: 'assert 1' }],
  ['py lambda and dict defaults', 'python', 'def test_a(f=lambda x: x,\n           d={"a": 1}):\n    assert f(d)\n', { names: ['test_a'], body: 'assert f(d)' }],
  ['py semicolons', 'python', 'def test_a(): x = 1; assert x\n', { names: ['test_a'], body: 'x = 1; assert x' }],
  ['py multi-line bases', 'python', 'class TestA(\n    Base,\n):\n    def test_a(self):\n        assert 1\n', { names: ['test_a'], container: 'TestA' }],
  ['py unittest', 'python', 'import unittest\n\nclass TestA(unittest.TestCase):\n    def setUp(self):\n        self.x = 1\n\n    def test_a(self):\n        self.assertEqual(self.x, 1)\n', { names: ['test_a'], container: 'TestA' }],
  ['py unicode', 'python', 'def test_õige():\n    assert 1\n', { names: ['test_õige'] }],
  ['py eof no newline', 'python', 'def test_a():\n    assert 1', { names: ['test_a'], body: 'assert 1', lines: [1, 2] }],
  ['py string paren default', 'python', 'def test_a(x=")"):\n    assert x\n', { names: ['test_a'], body: 'assert x' }],
  ['py backslash sig', 'python', 'def test_a(x, \\\n           y):\n    assert x\n', { names: ['test_a'], body: 'assert x' }],
  ['py decorator spaces', 'python', '@ pytest.mark.skip\ndef test_a():\n    assert 1\n', { names: ['test_a'], markers: ['@ pytest.mark.skip'] }],
  ['py crlf', 'python', 'class TestA:\r\n    def test_a(self):\r\n        assert 1\r\n\r\n    def test_b(self):\r\n        assert 2\r\n', { names: ['test_a', 'test_b'], container: 'TestA' }],
  ['py in if block', 'python', 'if True:\n    def test_a():\n        assert 1\n', { names: ['test_a'] }],
  ['py class docstring', 'python', 'class TestA:\n    """Docs.\n\nMore."""\n    def test_a(self):\n        assert 1\n', { names: ['test_a'], container: 'TestA' }],
  ['py nested def in helper', 'python', 'class TestA:\n    def helper(self):\n        x = 1\n\n    @pytest.mark.skip\n    def test_a(self):\n        assert 1\n', { names: ['test_a'], markers: ['@pytest.mark.skip'] }],
  ['py fstring nested quotes', 'python', 'def test_a():\n    s = f"{d["k"]} {{"\n    assert s\n\ndef test_b():\n    assert 1\n', { names: ['test_a', 'test_b'] }],
  ['py fstring brace in nested string', 'python', 'def test_a():\n    s = f"{d["{"]}"\n    assert s\n\ndef test_b():\n    assert 1\n', { names: ['test_a', 'test_b'], lines: [1, 3] }],
];

describe('scanTestDeclarations — formatting and edge cases', () => {
  it.each(CASES)('%s', (_label, language, text, expected) => {
    const declarations = scanTestDeclarations(text, language);
    expect(declarations.map((declaration) => declaration.name)).toEqual(expected.names);

    const first = declarations[0];
    if (expected.container !== undefined) expect(first.container).toBe(expected.container);
    if (expected.body !== undefined) expect(first.bodyText).toContain(expected.body);
    if (expected.markers) expect(first.markers).toEqual(expected.markers);
    if (expected.containerMarkers) expect(first.containerMarkers).toEqual(expected.containerMarkers);
    if (expected.lines) expect([first.startLine, first.endLine]).toEqual(expected.lines);
  });
});

describe('maskCommentsAndStrings — interpolation and nesting', () => {
  // Each row is code, a string's content, and code again: only the content may be blanked.
  it.each([
    ['csharp', 'x = $"', 'a {{ b }} {c}', '" + d;'],
    ['csharp', 'x = $"', '{s.Replace("(", "")}', '" + (d);'],
    ['csharp', 'x = $@"', '{a["k"]} ""q"" {{', '" + d;'],
    ['csharp', 'x = $"""', '{a} "q" ', '""" + d;'],
    ['kotlin', 'x = "', '${s.split("{")}', '" + y'],
    ['kotlin', 'x = """', '${a("}")} $b', '""" + y'],
    // A hole left open mid-edit stops at the end of its line.
    ['kotlin', 'x = "', '${', '" + y\nz = (1)'],
    // Since 3.12 an f-string's code may reuse its quote; prefixes combine in any case and order.
    ['python', 'x = f"', '{d["{"]}', '" + (y)'],
    ['python', "x = rf'", '{a!r:>{w}} {{', "' + (y)"],
    ['python', 'x = Fr"""', '{d["}"]}', '\n""" + (y)'],
    ['python', 'x = t"', '{a}', '" + (y)'],
    ['python', 'x = b"', '{', '" + (y)'],
    // Only a prefix that starts a token: the `f` of `if` is not one.
    ['python', 'if"', '{', '" in x: (y)'],
    // Java has no templates: `${` is plain text, so the string ends at the next quote.
    ['java', 'x = "', '${', '" + y + " ";'],
  ] as const)('%s: %s…', (language, before, content, after) => {
    const text = `${before}${content}${after}`;
    expect(maskCommentsAndStrings(text, language)).toBe(`${before}${' '.repeat(content.length)}${after}`);
  });

  it('nests Kotlin block comments but not Java ones', () => {
    expect(maskCommentsAndStrings('/* a /* b */ c() */ d()', 'kotlin')).toBe(`${' '.repeat(20)}d()`);
    expect(maskCommentsAndStrings('/* a /* b */ c();', 'java')).toBe(`${' '.repeat(13)}c();`);
  });

  it("skips a Kotlin backticked name whole, so its apostrophe opens nothing", () => {
    expect(maskCommentsAndStrings("fun `it's ok`() = 'x'", 'kotlin')).toBe("fun `it's ok`() = ' '");
  });
});

describe('scanTestDeclarations — robustness', () => {
  // Every prefix of a fixture stands in for a file caught mid-edit.
  it.each([
    ['python/test_calculator.py', 'python'],
    ['java/CalculatorTest.java', 'java'],
    ['kotlin/CalculatorTest.kt', 'kotlin'],
    ['csharp/CalculatorTests.cs', 'csharp'],
  ] as const)('never throws on a truncated %s', (path, language) => {
    const text = fixture(path);
    for (let end = 0; end <= text.length; end++) {
      expect(() => scanTestDeclarations(text.slice(0, end), language)).not.toThrow();
    }
  });
});
