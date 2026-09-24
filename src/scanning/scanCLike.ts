import { collectMarkers, expandMarkersBackward, type MarkerSyntax } from './markers';
import type { TestDeclaration } from './types';
import {
  lineOf,
  lineStarts,
  matchBackward,
  matchForward,
  scanTopLevel,
  skipBackward,
  skipForward,
  skipSpaceBackward,
} from './text';

export interface CLikeDialect {
  /** Keywords that open a named type body, e.g. `class`, `struct`. */
  typeKeywords: string[];
  markers: MarkerSyntax;
  /** Global. Run on the masked text; each match must contain the marker's opener. */
  testMarker: RegExp;
  /** What ends an `=`/`=>` expression body, e.g. Kotlin's newline. */
  expressionBodyEnd: string;
}

interface TypeRange {
  name: string;
  start: number;
  end: number;
  markers: string[];
}

/** Kotlin's backticked names may hold `(`, `=` or `{`, which must not read as syntax. */
function blankBacktickNames(masked: string): string {
  return masked.replace(/`[^`\n]*`/g, (name) => `\`${' '.repeat(name.length - 2)}\``);
}

function readNameBackward(
  text: string,
  masked: string,
  parenOpen: number,
): { name: string; start: number } | undefined {
  let i = skipSpaceBackward(masked, parenOpen - 1);
  // C#'s `Method<T>(…)`.
  if (masked[i] === '>') {
    const open = matchBackward(masked, i, '<', '>');
    if (open < 0) return undefined;
    i = skipSpaceBackward(masked, open - 1);
  }
  if (i < 0) return undefined;

  if (masked[i] === '`') {
    const open = masked.lastIndexOf('`', i - 1);
    return open < 0 ? undefined : { name: text.slice(open + 1, i), start: open };
  }

  const j = skipBackward(masked, i, /[\p{L}\p{N}_$]/u);
  return j === i ? undefined : { name: text.slice(j + 1, i + 1), start: j + 1 };
}

/** Start of the modifiers (`public`, `inner`, `sealed`) that sit between a type keyword and its markers. */
function modifiersStart(masked: string, keyword: number): number {
  let start = keyword;
  for (;;) {
    const end = skipSpaceBackward(masked, start - 1);
    const word = skipBackward(masked, end, /[a-z]/);
    // Preceded by a name character, `@` or `.`: part of a longer name, an annotation or a member access.
    const isModifier = word < end && !/[\p{L}\p{N}_$@.]/u.test(masked[word] ?? '');
    if (!isModifier) return start;
    start = word + 1;
  }
}

function scanTypeRanges(
  text: string,
  masked: string,
  dialect: CLikeDialect,
  testMarkers: number[],
): TypeRange[] {
  const syntax = dialect.markers;
  // Keywords may stack, as in C#'s `record struct`.
  const typeDeclaration = new RegExp(
    `\\b(?:(?:${dialect.typeKeywords.join('|')})[ \\t]+)+([\\p{L}_][\\p{L}\\p{N}_]*)`,
    'gu',
  );
  const matches = [...masked.matchAll(typeDeclaration)];
  const ranges: TypeRange[] = [];

  for (const match of matches) {
    const keyword = match.index;
    // `;` first means a forward declaration or an abstract member, not a body to descend into.
    const brace = scanTopLevel(masked, keyword + match[0].length, '{;');
    if (brace < 0 || masked[brace] !== '{') continue;
    // A bodyless type (Kotlin's `data class P(val x: Int)`) would otherwise claim the body of
    // whatever is declared after it.
    const beforeBrace = (offset: number): boolean => keyword < offset && offset < brace;
    if (matches.some((other) => beforeBrace(other.index)) || testMarkers.some(beforeBrace)) continue;

    const end = matchForward(masked, brace, '{', '}');
    if (end < 0) continue;

    const markerStart = expandMarkersBackward(masked, modifiersStart(masked, keyword), syntax);
    ranges.push({
      name: match[1],
      start: keyword,
      end,
      markers: collectMarkers(text, masked, markerStart, syntax).markers,
    });
  }

  return ranges;
}

function containersOf(ranges: TypeRange[], offset: number): TypeRange[] {
  return ranges.filter((range) => range.start < offset && offset < range.end);
}

function testMarkerOffsets(masked: string, dialect: CLikeDialect): number[] {
  // A line-anchored pattern starts at the indent rather than at the opener.
  return [...masked.matchAll(dialect.testMarker)].map(
    (match) => match.index + match[0].indexOf(dialect.markers.opener),
  );
}

// A line opening with one of these continues the expression before it: `assertThat(x)` then `.isEqualTo(1)`.
const CONTINUES_EXPRESSION = /\s*(?:\??\.|\?:|&&|\|\|)/y;

function expressionEnd(masked: string, start: number, dialect: CLikeDialect): number {
  let from = start;
  for (;;) {
    // A closer with no opener of its own ends the expression: it belongs to the enclosing type.
    const end = scanTopLevel(masked, from, dialect.expressionBodyEnd, { unbalancedClose: true });
    if (end < 0) return masked.length;
    CONTINUES_EXPRESSION.lastIndex = end + 1;
    if (masked[end] !== '\n' || !CONTINUES_EXPRESSION.test(masked)) return end;
    from = end + 1;
  }
}

interface MemberBody {
  endOffset: number;
  bodyText: string;
}

/** The body after a parameter list: a braced block or an `=`/`=>` expression. */
function readBody(text: string, masked: string, from: number, dialect: CLikeDialect): MemberBody | undefined {
  // Skips `throws A, B` (Java), `: Type` (Kotlin) and `where T : new()` (C#) to reach the body.
  let k = from;
  for (;;) {
    const stop = scanTopLevel(masked, k, '{;=');
    if (stop < 0 || masked[stop] === ';') return undefined;

    if (masked[stop] === '{') {
      const braceClose = matchForward(masked, stop, '{', '}');
      return braceClose < 0 ? undefined : { endOffset: braceClose, bodyText: text.slice(stop + 1, braceClose) };
    }

    // `==` is a comparison in a constraint or default argument, not the start of a body.
    if (masked[stop + 1] === '=') {
      k = stop + 2;
      continue;
    }

    // Kotlin's `fun f() =` may break the line before the expression.
    const start = skipForward(masked, stop + (masked[stop + 1] === '>' ? 2 : 1), /\s/);
    const endOffset = expressionEnd(masked, start, dialect);
    return { endOffset, bodyText: text.slice(start, endOffset).trim() };
  }
}

interface ParsedMember extends MemberBody {
  name: string;
  signatureOffset: number;
  markers: string[];
}

function parseMember(
  text: string,
  masked: string,
  start: number,
  dialect: CLikeDialect,
): ParsedMember | undefined {
  const { markers, end: afterMarkers } = collectMarkers(text, masked, start, dialect.markers);

  // A brace, terminator or assignment before the parameter list means this isn't a method.
  const parenOpen = scanTopLevel(masked, afterMarkers, '({};=', { unbalancedClose: true });
  if (parenOpen < 0 || masked[parenOpen] !== '(') return undefined;

  const named = readNameBackward(text, masked, parenOpen);
  if (!named) return undefined;

  const parenClose = matchForward(masked, parenOpen, '(', ')');
  if (parenClose < 0) return undefined;

  const body = readBody(text, masked, parenClose + 1, dialect);
  return body && { name: named.name, signatureOffset: named.start, markers, ...body };
}

/** `masked` is `text` with comments and string contents blanked, offset for offset. */
export function scanCLike(text: string, maskedText: string, dialect: CLikeDialect): TestDeclaration[] {
  const masked = blankBacktickNames(maskedText);
  const starts = lineStarts(text);
  const testMarkers = testMarkerOffsets(masked, dialect);
  const types = scanTypeRanges(text, masked, dialect, testMarkers);
  const declarations: TestDeclaration[] = [];
  const seen = new Set<number>();

  for (const offset of testMarkers) {
    const start = expandMarkersBackward(masked, offset, dialect.markers);
    const member = parseMember(text, masked, start, dialect);
    if (!member || seen.has(member.signatureOffset)) continue;
    seen.add(member.signatureOffset);

    const enclosing = containersOf(types, member.signatureOffset);
    declarations.push({
      name: member.name,
      container: enclosing.length > 0 ? enclosing.map((range) => range.name).join('.') : undefined,
      startLine: lineOf(starts, start),
      endLine: lineOf(starts, member.endOffset),
      markers: member.markers,
      containerMarkers: enclosing.flatMap((range) => range.markers),
      bodyText: member.bodyText,
    });
  }

  return declarations.sort((a, b) => a.startLine - b.startLine);
}
