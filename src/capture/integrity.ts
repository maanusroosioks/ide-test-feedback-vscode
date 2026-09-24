// These signals never leave the machine: they drive the pre-submit warning and nothing else.
// Computed over files the student owns, so they were never trustworthy as evidence; the grader
// gets the test source instead.

import { maskCommentsAndStrings, type SourceLanguage, type TestDeclaration } from '../source';

export interface TestIntegrity {
  /** Whether a declaration for this result was found in the project's source. */
  located: boolean;
  assertionCount?: number;
  empty?: boolean;
  /** The marker verbatim, e.g. `@Disabled("wip")`. Absent when the test is not skip-marked. */
  skipMarker?: string;
}

const MAX_SKIP_MARKER = 100;

const JVM_ASSERTIONS = /\bassert[A-Z_]\w*\s*\(|\bassert\s*\(|\bfail\s*\(|\bverify\s*\(|\bshould[A-Z]\w*\b/g;

/**
 * One alternation per language, not a list: a global regex consumes what it matches, so chained
 * styles like AssertJ's `assertThat(x).isEqualTo(y)` count once. Sharing a regex object across
 * languages is safe — `String.prototype.match` resets lastIndex.
 */
const ASSERTIONS: Record<SourceLanguage, RegExp> = {
  python:
    /(?:^|[^.\w])assert\b|\bself\s*\.\s*(?:assert\w+|fail)\s*\(|\bpytest\s*\.\s*(?:raises|fail)\s*\(|\b(?:np|numpy)\s*\.\s*testing\s*\.\s*assert_\w+\s*\(/g,
  java: JVM_ASSERTIONS,
  kotlin: JVM_ASSERTIONS,
  // The optional `<...>` keeps `Assert.Throws<DivideByZeroException>(…)` from slipping through.
  csharp:
    /\bAssert\s*\.\s*\w+\s*(?:<[^>()]*>)?\s*\(|\.\s*Should\s*\(\s*\)|\bMock\w*\s*\.\s*Verify\b|\bRecord\s*\.\s*Exception\s*\(/g,
};

const SKIP_MARKERS: RegExp[] = [
  /@\s*(?:[\w.]*\.)?(?:Disabled|Ignore)\b/,
  /@\s*(?:pytest\s*\.\s*mark\s*\.\s*)?skip(?:if)?\b/,
  /@\s*unittest\s*\.\s*skip\w*\b/,
  /\[\s*(?:[\w.]*\.)?Ignore\b/,
  /\bSkip\s*=\s*"/,
];

const SKIP_IN_BODY: RegExp[] = [
  /\bpytest\s*\.\s*skip\s*\(/,
  /\bAssert\s*\.\s*Ignore\s*\(/,
  /\bself\s*\.\s*skipTest\s*\(/,
];

const NOOP_PATTERNS: RegExp[] = [
  /\bTask\s*\.\s*(?:CompletedTask|FromResult\s*\(\s*\))/g,
  /\breturn\b/g,
  /\bawait\b/g,
  /\bpass\b/g,
  /\bnull\b/g,
  /\bUnit\b/g,
  /\.\.\./g,
];

function countMatches(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

function isEmptyBody(maskedBody: string): boolean {
  let remaining = maskedBody;
  for (const pattern of NOOP_PATTERNS) {
    remaining = remaining.replace(pattern, ' ');
  }
  // Quotes survive masking, so a docstring-only body reduces to its delimiters.
  return remaining.replace(/[{}();,"'`\s]/g, '') === '';
}

function findSkipMarker(declaration: TestDeclaration, maskedBody: string): string | undefined {
  for (const marker of [...declaration.markers, ...declaration.containerMarkers]) {
    if (SKIP_MARKERS.some((pattern) => pattern.test(marker))) {
      return marker.slice(0, MAX_SKIP_MARKER);
    }
  }
  for (const pattern of SKIP_IN_BODY) {
    const match = pattern.exec(maskedBody);
    if (match) return match[0].slice(0, MAX_SKIP_MARKER);
  }
  return undefined;
}

export function analyzeDeclaration(
  declaration: TestDeclaration,
  language: SourceLanguage,
): TestIntegrity {
  const maskedBody = maskCommentsAndStrings(declaration.bodyText, language);
  const skipMarker = findSkipMarker(declaration, maskedBody);

  return {
    located: true,
    assertionCount: countMatches(maskedBody, ASSERTIONS[language]),
    empty: isEmptyBody(maskedBody),
    skipMarker,
  };
}

export function unlocatedIntegrity(): TestIntegrity {
  return { located: false };
}

/** Names its own test, so the warning path never indexes back into the run to find out whose it is. */
export interface TestIntegrityEntry {
  testSuite?: string;
  testName: string;
  integrity: TestIntegrity;
}

export interface SuspiciousTest {
  testSuite?: string;
  testName: string;
  reasons: string[];
}

/** Below this share of unlocatable tests it's an unusual project layout, not a signal. */
const UNLOCATED_SHARE = 0.3;

/**
 * A framework-reported SKIPPED status is deliberately not a reason on its own: it is legitimate
 * and already visible in the results, and warning on it would train students to click through.
 */
export function describeSuspiciousTests(entries: TestIntegrityEntry[]): SuspiciousTest[] {
  const total = entries.length;
  const unlocated = entries.filter((entry) => !entry.integrity.located).length;
  const reportUnlocated = total > 0 && unlocated / total > UNLOCATED_SHARE;
  const findings: SuspiciousTest[] = [];

  for (const { testSuite, testName, integrity } of entries) {
    const reasons: string[] = [];
    if (integrity.empty) {
      reasons.push('has an empty body');
    } else if (integrity.located && integrity.assertionCount === 0) {
      reasons.push('makes no assertions');
    }
    if (integrity.skipMarker) {
      reasons.push(`is marked as skipped (${integrity.skipMarker})`);
    }
    if (!integrity.located && reportUnlocated) {
      reasons.push("could not be found in the project's source");
    }

    if (reasons.length > 0) {
      findings.push({ testSuite, testName, reasons });
    }
  }

  return findings;
}
