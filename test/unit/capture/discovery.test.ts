import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DISCOVERY_LIMITS,
  mayBeTestFolder,
  SOURCE_FILE_GLOB,
  TestFileFinder,
  type DiscoveryLimits,
} from '../../../src/capture/discovery';
import { SourceFileCache } from '../../../src/capture/sourceFiles';
import type { Platform } from '../../../src/core/types';
import { tempDir, writeTree } from '../helpers/fs';
import { fixture } from '../helpers/sourceFixtures';

const PYTHON = fixture('python/test_calculator.py');
const JAVA = fixture('java/CalculatorTest.java');
const KOTLIN = fixture('kotlin/CalculatorTest.kt');
const CSHARP = fixture('csharp/CalculatorTests.cs');

async function discover(
  files: Record<string, string>,
  platforms: Platform[],
  limits?: DiscoveryLimits,
): Promise<string[]> {
  const folder = await tempDir();
  await writeTree(folder, files);
  const found = await new TestFileFinder(folder, platforms, limits).discover(new SourceFileCache(folder, platforms[0]));
  return found.map((file) => file.relativePath);
}

describe('TestFileFinder.discover', () => {
  it("finds the test files of each of the folder's platforms, in path order", async () => {
    const found = await discover(
      {
        'tests/test_calculator.py': PYTHON,
        'src/test/java/CalculatorTest.java': JAVA,
        'src/test/kotlin/CalculatorTest.kt': KOTLIN,
        'Calculator.Tests/CalculatorTests.cs': CSHARP,
      },
      ['python', 'jvm', 'dotnet'],
    );

    expect(found).toEqual([
      'Calculator.Tests/CalculatorTests.cs',
      'src/test/java/CalculatorTest.java',
      'src/test/kotlin/CalculatorTest.kt',
      'tests/test_calculator.py',
    ]);
  });

  it("looks only at the languages of the folder's platforms", async () => {
    const found = await discover(
      { 'test_calculator.py': PYTHON, 'CalculatorTest.java': JAVA },
      ['python'],
    );

    expect(found).toEqual(['test_calculator.py']);
  });

  it('leaves out source files that declare no tests', async () => {
    const found = await discover(
      {
        'src/main/java/Calculator.java': 'public class Calculator { int add(int a, int b) { return a + b; } }',
        'src/test/java/CalculatorTest.java': JAVA,
      },
      ['jvm'],
    );

    expect(found).toEqual(['src/test/java/CalculatorTest.java']);
  });

  it("takes only pytest's test file names, so a test-like helper elsewhere is no test", async () => {
    const found = await discover(
      {
        'helpers.py': 'def test_helper():\n    return 1\n',
        'test_calculator.py': PYTHON,
        'calculator_test.py': 'def test_it():\n    assert True\n',
      },
      ['python'],
    );

    expect(found).toEqual(['calculator_test.py', 'test_calculator.py']);
  });

  it('skips hidden folders, build output and installed packages', async () => {
    const found = await discover(
      {
        'tests/test_calculator.py': PYTHON,
        '.venv/lib/test_vendored.py': PYTHON,
        'venv/lib/site-packages/pkg/test_pkg.py': PYTHON,
        'node_modules/x/test_x.py': PYTHON,
        'build/test_built.py': PYTHON,
        'target/test-classes/CalculatorTest.java': JAVA,
      },
      ['python', 'jvm'],
    );

    expect(found).toEqual(['tests/test_calculator.py']);
  });

  it('skips files too large to be tests someone wrote', async () => {
    const found = await discover(
      { 'test_small.py': 'def test_a():\n    assert True\n', 'test_huge.py': PYTHON },
      ['python'],
      { ...DISCOVERY_LIMITS, maxFileBytes: 100 },
    );

    expect(found).toEqual(['test_small.py']);
  });

  it('stops walking at the file cap', async () => {
    const files = Object.fromEntries(
      Array.from({ length: 5 }, (_, index) => [`test_${index}.py`, 'def test_a():\n    assert True\n']),
    );

    const found = await discover(files, ['python'], { ...DISCOVERY_LIMITS, maxFiles: 3 });

    expect(found).toEqual(['test_0.py', 'test_1.py', 'test_2.py']);
  });

  it('stops walking a huge tree with few candidates at the entry cap', async () => {
    const data = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`data/${index}.csv`, 'x']));

    // `data` sorts first, so its entries use up the cap before `tests` is reached.
    const found = await discover(
      { ...data, 'tests/test_a.py': 'def test_a():\n    assert True\n' },
      ['python'],
      { ...DISCOVERY_LIMITS, maxEntries: 10 },
    );

    expect(found).toEqual([]);
  });

  it('finds every test file of a project larger than one read batch', async () => {
    const files = Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [`test_${String(index).padStart(2, '0')}.py`, 'def test_a():\n    assert True\n']),
    );

    const found = await discover(files, ['python']);

    expect(found).toEqual(Object.keys(files));
  });
});

describe('mayBeTestFolder', () => {
  const folder = join('/', 'project');

  it('lets through a new folder that could hold tests, dotted .NET project names included', () => {
    expect(mayBeTestFolder(folder, join(folder, 'tests'))).toBe(true);
    expect(mayBeTestFolder(folder, join(folder, 'Calculator.Tests'))).toBe(true);
  });

  it('drops build output, hidden folders and anything outside the workspace folder, unread', () => {
    expect(mayBeTestFolder(folder, join(folder, 'target', 'classes'))).toBe(false);
    expect(mayBeTestFolder(folder, join(folder, 'build', 'test-results'))).toBe(false);
    expect(mayBeTestFolder(folder, join(folder, '.git', 'objects'))).toBe(false);
    expect(mayBeTestFolder(folder, join('/', 'elsewhere', 'tests'))).toBe(false);
    expect(mayBeTestFolder(folder, folder)).toBe(false);
  });

  it('leaves source files to the source watcher', () => {
    expect(mayBeTestFolder(folder, join(folder, 'tests', 'test_math.py'))).toBe(false);
  });
});

describe('TestFileFinder.isCandidate', () => {
  const folder = join('/', 'project');
  const finder = new TestFileFinder(folder, ['python', 'jvm']);

  it('accepts a test file anywhere outside the skipped folders', () => {
    expect(finder.isCandidate(join(folder, 'tests', 'test_math.py'))).toBe(true);
    expect(finder.isCandidate(join(folder, 'src', 'test', 'java', 'MathTest.java'))).toBe(true);
  });

  it('rejects a file under a hidden or ignored folder, or outside the workspace folder', () => {
    expect(finder.isCandidate(join(folder, '.venv', 'test_math.py'))).toBe(false);
    expect(finder.isCandidate(join(folder, 'target', 'MathTest.java'))).toBe(false);
    expect(finder.isCandidate(join('/', 'elsewhere', 'test_math.py'))).toBe(false);
  });

  it("rejects a file no language of the folder's platforms claims", () => {
    expect(finder.isCandidate(join(folder, 'MathTests.cs'))).toBe(false);
    expect(finder.isCandidate(join(folder, 'helpers.py'))).toBe(false);
  });
});

describe('SOURCE_FILE_GLOB', () => {
  it("covers every scanned language's extensions", () => {
    expect(SOURCE_FILE_GLOB).toBe('**/*.{java,kt,kts,py,cs}');
  });
});
