import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TestLocationResolver, parseStackFrames } from '../../../src/capture/location';
import type { Platform } from '../../../src/core/types';

const ROOT = resolve('/work/proj');

/** Builds a resolver whose filesystem is exactly the given relative paths. */
function resolverFor(
  platform: Platform,
  files: string[],
  dirs: string[] = [],
  root = ROOT,
): TestLocationResolver {
  const present = new Set(files.map((file) => resolve(root, file)));
  return new TestLocationResolver(root, platform, {
    exists: async (path) => present.has(path),
    listDirs: async () => dirs,
  });
}

describe('parseStackFrames — JVM', () => {
  it('reads class, file and line, ignoring the module prefix', () => {
    const trace = [
      'java.lang.AssertionError: expected 2 but was 3',
      '\tat org.junit.Assert.fail(Assert.java:88)',
      '\tat app//com.pkg.FooTest.addsUp(FooTest.java:42)',
    ].join('\n');

    expect(parseStackFrames(trace, 'jvm')).toEqual([
      { className: 'org.junit.Assert', file: 'Assert.java', line: 88 },
      { className: 'com.pkg.FooTest', file: 'FooTest.java', line: 42 },
    ]);
  });

  it('skips frames with no source file', () => {
    const trace = '\tat java.base/java.lang.reflect.Method.invoke(Method.java:568)\n\tat Foo.bar(Unknown Source)';
    expect(parseStackFrames(trace, 'jvm')).toHaveLength(1);
  });
});

describe('parseStackFrames — python', () => {
  it('reads CPython traceback frames', () => {
    const trace = 'Traceback:\n  File "/work/proj/tests/test_math.py", line 12, in test_add\n    assert 1 == 2';
    expect(parseStackFrames(trace, 'python')).toEqual([
      { file: '/work/proj/tests/test_math.py', line: 12 },
    ]);
  });

  it("reads pytest's own report footer", () => {
    const trace = [
      'self = <test_math.TestMath object at 0x1>',
      '',
      '    def test_add(self):',
      '>       assert 1 == 2',
      'E       assert 1 == 2',
      '',
      'tests/test_math.py:12: AssertionError',
    ].join('\n');

    expect(parseStackFrames(trace, 'python')).toEqual([{ file: 'tests/test_math.py', line: 12 }]);
  });
});

describe('parseStackFrames — .NET', () => {
  it('reads the file and line after "in"', () => {
    const file = resolve(ROOT, 'FooTests.cs');
    const trace = `   at Ns.FooTests.Bar() in ${file}:line 42`;
    expect(parseStackFrames(trace, 'dotnet')).toEqual([{ file, line: 42 }]);
  });
});

describe('resolveTestLocation', () => {
  it('maps a JVM frame to a maven test source root via the class name', async () => {
    const resolver = resolverFor('jvm', ['src/test/java/com/pkg/FooTest.java']);
    const trace = '\tat com.pkg.FooTest.addsUp(FooTest.java:42)';

    await expect(resolver.resolveTestLocation('com.pkg.FooTest', trace)).resolves.toEqual({
      file: resolve(ROOT, 'src/test/java/com/pkg/FooTest.java'),
      line: 42,
    });
  });

  it('prefers the frame belonging to the test suite over library frames', async () => {
    const resolver = resolverFor('jvm', [
      'src/test/java/com/pkg/FooTest.java',
      'src/main/java/com/pkg/Helper.java',
    ]);
    const trace = [
      '\tat com.pkg.Helper.check(Helper.java:7)',
      '\tat com.pkg.FooTest.addsUp(FooTest.java:42)',
    ].join('\n');

    await expect(resolver.resolveTestLocation('com.pkg.FooTest', trace)).resolves.toEqual({
      file: resolve(ROOT, 'src/test/java/com/pkg/FooTest.java'),
      line: 42,
    });
  });

  it('attributes a nested-class frame to its outer suite file', async () => {
    const resolver = resolverFor('jvm', ['src/test/java/com/pkg/FooTest.java']);
    const trace = '\tat com.pkg.FooTest$Inner.addsUp(FooTest.java:19)';

    await expect(resolver.resolveTestLocation('com.pkg.FooTest', trace)).resolves.toEqual({
      file: resolve(ROOT, 'src/test/java/com/pkg/FooTest.java'),
      line: 19,
    });
  });

  it('falls back to the first resolvable frame when none match the suite', async () => {
    const resolver = resolverFor('jvm', ['src/main/java/com/pkg/Helper.java']);
    const trace = [
      '\tat org.junit.Assert.fail(Assert.java:88)',
      '\tat com.pkg.Helper.check(Helper.java:7)',
    ].join('\n');

    await expect(resolver.resolveTestLocation('com.pkg.FooTest', trace)).resolves.toEqual({
      file: resolve(ROOT, 'src/main/java/com/pkg/Helper.java'),
      line: 7,
    });
  });

  it('finds sources in a multi-module layout', async () => {
    const resolver = resolverFor('jvm', ['core/src/test/java/com/pkg/FooTest.java'], ['core', 'web']);
    const trace = '\tat com.pkg.FooTest.addsUp(FooTest.java:42)';

    await expect(resolver.resolveTestLocation('com.pkg.FooTest', trace)).resolves.toEqual({
      file: resolve(ROOT, 'core/src/test/java/com/pkg/FooTest.java'),
      line: 42,
    });
  });

  it('resolves a pytest report footer relative to the folder', async () => {
    const resolver = resolverFor('python', ['tests/test_math.py']);
    const trace = 'tests/test_math.py:12: AssertionError';

    await expect(resolver.resolveTestLocation('tests.test_math.TestMath', trace)).resolves.toEqual({
      file: resolve(ROOT, 'tests/test_math.py'),
      line: 12,
    });
  });

  it('gives a passing test the suite file with no line', async () => {
    const resolver = resolverFor('jvm', ['src/test/java/com/pkg/FooTest.java']);

    await expect(resolver.resolveTestLocation('com.pkg.FooTest', undefined)).resolves.toEqual({
      file: resolve(ROOT, 'src/test/java/com/pkg/FooTest.java'),
    });
  });

  it('drops the class segment when deriving a pytest module file', async () => {
    const resolver = resolverFor('python', ['tests/test_math.py']);

    await expect(resolver.resolveTestLocation('tests.test_math.TestMath', undefined)).resolves.toEqual({
      file: resolve(ROOT, 'tests/test_math.py'),
    });
  });

  it('finds a .NET suite by its class name when folders do not follow namespaces', async () => {
    const resolver = resolverFor('dotnet', ['src/CalculatorTests.cs']);

    expect(await resolver.resolveSuiteFile('Acme.Math.CalculatorTests')).toBe(resolve(ROOT, 'src/CalculatorTests.cs'));
  });

  it('finds a .NET suite in a project folder named after its dotted root namespace', async () => {
    const resolver = resolverFor('dotnet', ['tests/Acme.Math.Tests/Unit/CalculatorTests.cs'], ['src', 'tests']);

    expect(await resolver.resolveSuiteFile('Acme.Math.Tests.Unit.CalculatorTests')).toBe(
      resolve(ROOT, 'tests/Acme.Math.Tests/Unit/CalculatorTests.cs'),
    );
  });

  it("skips only the platform's own build output when searching modules", async () => {
    const files = ['bin/src/test/java/com/pkg/FooTest.java', 'obj/src/test/java/com/pkg/FooTest.java'];

    // `bin` is Eclipse's output on the JVM, but `obj` means nothing there.
    expect(await resolverFor('jvm', files, ['bin', 'obj']).resolveSuiteFile('com.pkg.FooTest')).toBe(
      resolve(ROOT, 'obj/src/test/java/com/pkg/FooTest.java'),
    );
  });

  it('returns nothing when the suite has no matching file on disk', async () => {
    const resolver = resolverFor('jvm', []);

    await expect(resolver.resolveTestLocation('com.pkg.FooTest', undefined)).resolves.toBeUndefined();
  });

  it('reuses one filesystem probe across repeated lookups', async () => {
    let probes = 0;
    const present = new Set([resolve(ROOT, 'src/test/java/com/pkg/FooTest.java')]);
    const resolver = new TestLocationResolver(ROOT, 'jvm', {
      exists: async (path) => {
        probes += 1;
        return present.has(path);
      },
      listDirs: async () => [],
    });

    await resolver.resolveTestLocation('com.pkg.FooTest', undefined);
    const afterFirst = probes;
    await resolver.resolveTestLocation('com.pkg.FooTest', undefined);

    expect(probes).toBe(afterFirst);
  });
});

describe('TestLocationResolver — relative frame paths', () => {
  it('finds a path-qualified frame inside a module when it is not at the root', async () => {
    const resolver = resolverFor('python', ['backend/tests/test_math.py'], ['backend']);

    expect(await resolver.resolveTestLocation(undefined, 'tests/test_math.py:12: AssertionError')).toEqual({
      file: resolve(ROOT, 'backend/tests/test_math.py'),
      line: 12,
    });
  });
});

describe('TestLocationResolver — real filesystem', () => {
  async function project(files: string[]): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'location-'));
    for (const file of files) {
      await mkdir(dirname(join(root, file)), { recursive: true });
      await writeFile(join(root, file), '', 'utf8');
    }
    return root;
  }

  it('searches module directories, skipping build output and hidden folders', async () => {
    const root = await project([
      '.cache/src/test/java/com/pkg/FooTest.java',
      'build/src/test/java/com/pkg/FooTest.java',
      'core/src/test/java/com/pkg/FooTest.java',
    ]);
    const resolver = new TestLocationResolver(root, 'jvm');

    expect(await resolver.resolveSuiteFile('com.pkg.FooTest')).toBe(
      resolve(root, 'core/src/test/java/com/pkg/FooTest.java'),
    );
  });

  it('finds nothing in a folder that does not exist', async () => {
    const resolver = new TestLocationResolver(join(tmpdir(), 'location-missing', 'nowhere'), 'jvm');

    expect(await resolver.resolveSuiteFile('com.pkg.FooTest')).toBeUndefined();
  });
});
