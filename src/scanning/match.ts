import type { TestDeclaration } from './types';
import { matchBackward } from './text';

function trimTrailingGroup(value: string, open: string, close: string): string | undefined {
  if (value[value.length - 1] !== close) return undefined;
  const start = matchBackward(value, value.length - 1, open, close);
  return start < 0 ? undefined : value.slice(0, start).trimEnd();
}

/** Brackets and parens can nest and interleave, so strips whichever is currently trailing. */
function trimTrailingGroups(name: string): string {
  let value = name;
  for (;;) {
    const trimmed = trimTrailingGroup(value, '[', ']') ?? trimTrailingGroup(value, '(', ')');
    if (trimmed === undefined) return value;
    value = trimmed;
  }
}

/** `test_add[2-3]`, `divideReturnsQuotient(int, int)[1]`, `Ns.Cls.Add_ReturnsSum`, `` `adds 2` ``. */
export function normalizeTestName(testName: string): string {
  let value = trimTrailingGroups(testName.trim());

  // Only after the argument list is gone, since dotnet theory arguments contain dots.
  // A space means this is a display name, not a qualified name, so leave it whole.
  const dot = value.lastIndexOf('.');
  if (dot >= 0 && !/\s/.test(value)) {
    value = value.slice(dot + 1);
  }

  return value.replace(/^`/, '').replace(/`$/, '');
}

/** Nested types are joined by `$` on the JVM and `+` in .NET. */
function simpleName(qualified: string | undefined): string | undefined {
  return qualified?.split(/[.$+]/).pop() || undefined;
}

const DISPLAY_NAME = /DisplayName\s*[=(]\s*"((?:[^"\\]|\\.)*)"/;

function displayNameOf(marker: string): string | undefined {
  const match = DISPLAY_NAME.exec(marker);
  return match ? match[1] : undefined;
}

function unique(
  candidates: TestDeclaration[],
  preferLine: number | undefined,
): TestDeclaration | undefined {
  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0 || preferLine === undefined) return undefined;
  const containing = candidates.filter(
    (declaration) => declaration.startLine <= preferLine && preferLine <= declaration.endLine,
  );
  return containing.length === 1 ? containing[0] : undefined;
}

/** An ambiguous name yields no match: the wrong snippet is worse than a whole-file fallback. */
export function matchDeclaration(
  declarations: TestDeclaration[],
  testName: string,
  testSuite: string | undefined,
  preferLine?: number,
): TestDeclaration | undefined {
  if (declarations.length === 0) return undefined;

  const normalized = normalizeTestName(testName);
  const suite = simpleName(testSuite);
  // A pytest module suite (`test_calculator`) names a file, not a class.
  const suiteIsType = suite !== undefined && /^\p{Lu}/u.test(suite);
  const inContainer =
    suite === undefined
      ? []
      : declarations.filter((declaration) =>
          suiteIsType
            ? simpleName(declaration.container) === suite
            : declaration.container === undefined,
        );

  const raw = testName.trim();
  const rules: Array<() => TestDeclaration[]> = [
    () => inContainer.filter((declaration) => declaration.name === normalized),
    () => declarations.filter((declaration) => declaration.name === normalized),
    () =>
      declarations.filter(
        (declaration) => declaration.name.toLowerCase() === normalized.toLowerCase(),
      ),
    // A backticked name can end in a group of its own, `divide(a, b)`, which normalizing strips too.
    () =>
      declarations.filter(
        (declaration) =>
          raw.startsWith(declaration.name) &&
          trimTrailingGroups(raw.slice(declaration.name.length)) === '',
      ),
    // xUnit appends a theory's arguments to its display name: `adds two(x: 1)`.
    () =>
      declarations.filter((declaration) =>
        declaration.markers.some((marker) => {
          const displayName = displayNameOf(marker);
          return displayName === raw || displayName === normalized;
        }),
      ),
  ];

  for (const rule of rules) {
    const hit = unique(rule(), preferLine);
    if (hit) return hit;
  }
  return undefined;
}
