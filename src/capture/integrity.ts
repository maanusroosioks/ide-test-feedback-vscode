// These signals never leave the machine: they drive the pre-submit warning and nothing else.
// Computed over files the student owns, so they were never trustworthy as evidence; the grader
// gets the test source instead.

import { SOURCE_LANGUAGES, type SourceLanguageProfile } from '../languages';
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

const NOOP_PATTERNS: RegExp[] = [
  /\bTask\s*\.\s*(?:CompletedTask|FromResult\s*\(\s*\))/g,
  /\breturn\b/g,
  /\bawait\b/g,
  /\bpass\b/g,
  /\bnull\b/g,
  /\bUnit\b/g,
  /\.\.\./g,
];

/** `String.prototype.match` resets lastIndex, so a global regex shared between profiles is safe here. */
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

function findSkipMarker(
  declaration: TestDeclaration,
  maskedBody: string,
  profile: SourceLanguageProfile,
): string | undefined {
  for (const marker of [...declaration.markers, ...declaration.containerMarkers]) {
    if (profile.skipMarkers.some((pattern) => pattern.test(marker))) {
      return marker.slice(0, MAX_SKIP_MARKER);
    }
  }
  for (const pattern of profile.skipInBody) {
    const match = pattern.exec(maskedBody);
    if (match) return match[0].slice(0, MAX_SKIP_MARKER);
  }
  return undefined;
}

export function analyzeDeclaration(
  declaration: TestDeclaration,
  language: SourceLanguage,
): TestIntegrity {
  const profile = SOURCE_LANGUAGES[language];
  const maskedBody = maskCommentsAndStrings(declaration.bodyText, language);
  const skipMarker = findSkipMarker(declaration, maskedBody, profile);

  return {
    located: true,
    assertionCount: countMatches(maskedBody, profile.assertions),
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
