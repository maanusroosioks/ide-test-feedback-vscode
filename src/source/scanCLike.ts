import type { TestDeclaration } from './language';
import { maskWith, type LexicalRules } from './mask';
import { lineOf, lineStarts, matchBackward, matchForward, scanTopLevel } from './text';

const TYPE_DECLARATION = /\b(?:class|interface|record|struct|enum|object)[ \t]+([A-Za-z_]\w*)/g;

/** How a family of languages writes the markers (annotations, attributes) that precede a declaration. */
export interface MarkerSyntax {
  opener: string;
  /** Start of the marker ending just before `before`, or undefined when none does. */
  previousMarkerStart(masked: string, before: number): number | undefined;
  /** End (exclusive) of the marker opening at `start`, or -1. */
  markerEnd(masked: string, start: number): number;
}

function skipSpaceBackward(masked: string, from: number): number {
  let i = from;
  while (i >= 0 && /\s/.test(masked[i])) i--;
  return i;
}

/** `@Test`, `@DisplayName("x")`, `@org.junit.jupiter.api.Test`. */
export const ANNOTATIONS: MarkerSyntax = {
  opener: '@',

  previousMarkerStart(masked, before) {
    let i = skipSpaceBackward(masked, before - 1);
    if (i < 0) return undefined;
    if (masked[i] === ')') {
      const open = matchBackward(masked, i, '(', ')');
      if (open < 0) return undefined;
      i = skipSpaceBackward(masked, open - 1);
    }
    let name = i;
    while (name >= 0 && /[A-Za-z0-9_.]/.test(masked[name])) name--;
    return name === i || name < 0 || masked[name] !== '@' ? undefined : name;
  },

  markerEnd(masked, start) {
    let j = start + 1;
    while (j < masked.length && /[A-Za-z0-9_.]/.test(masked[j])) j++;
    // Only spaces/tabs, never a newline: otherwise `@Test\nvoid foo()` eats the parameter list.
    let k = j;
    while (k < masked.length && /[ \t]/.test(masked[k])) k++;
    if (masked[k] !== '(') return j;
    const close = matchForward(masked, k, '(', ')');
    return close < 0 ? -1 : close + 1;
  },
};

/** `[Fact]`, `[Theory, InlineData(1)]`. */
export const ATTRIBUTES: MarkerSyntax = {
  opener: '[',

  previousMarkerStart(masked, before) {
    const i = skipSpaceBackward(masked, before - 1);
    if (i < 0 || masked[i] !== ']') return undefined;
    const open = matchBackward(masked, i, '[', ']');
    return open < 0 ? undefined : open;
  },

  markerEnd(masked, start) {
    const close = matchForward(masked, start, '[', ']');
    return close < 0 ? -1 : close + 1;
  },
};

export interface CLikeDialect {
  lexer: LexicalRules;
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

/** Walks back over contiguous markers. Masked Javadoc reads as blank, so it stops there. */
function expandMarkersBackward(masked: string, offset: number, syntax: MarkerSyntax): number {
  let start = offset;
  for (;;) {
    const previous = syntax.previousMarkerStart(masked, start);
    if (previous === undefined) return start;
    start = previous;
  }
}

function collectMarkers(
  text: string,
  masked: string,
  start: number,
  syntax: MarkerSyntax,
): { markers: string[]; end: number } {
  const markers: string[] = [];
  let i = start;

  for (;;) {
    while (i < masked.length && /\s/.test(masked[i])) i++;
    if (masked[i] !== syntax.opener) break;
    const end = syntax.markerEnd(masked, i);
    if (end < 0) break;
    markers.push(text.slice(i, end).trim());
    i = end;
  }

  return { markers, end: i };
}

function readNameBackward(
  text: string,
  masked: string,
  parenOpen: number,
): { name: string; start: number } | undefined {
  let i = parenOpen - 1;
  while (i >= 0 && /\s/.test(masked[i])) i--;
  if (i < 0) return undefined;

  if (text[i] === '`') {
    const open = text.lastIndexOf('`', i - 1);
    return open < 0 ? undefined : { name: text.slice(open + 1, i), start: open };
  }

  let j = i;
  while (j >= 0 && /[A-Za-z0-9_$]/.test(masked[j])) j--;
  return j === i ? undefined : { name: text.slice(j + 1, i + 1), start: j + 1 };
}

function scanTypeRanges(text: string, masked: string, syntax: MarkerSyntax): TypeRange[] {
  const ranges: TypeRange[] = [];
  TYPE_DECLARATION.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = TYPE_DECLARATION.exec(masked)) !== null) {
    // `;` first means a forward declaration or an abstract member, not a body to descend into.
    const brace = scanTopLevel(masked, match.index + match[0].length, '{;');
    if (brace < 0 || masked[brace] !== '{') continue;

    const end = matchForward(masked, brace, '{', '}');
    if (end < 0) continue;

    const markerStart = expandMarkersBackward(masked, match.index, syntax);
    ranges.push({
      name: match[1],
      start: match.index,
      end,
      markers: markerStart < match.index ? collectMarkers(text, masked, markerStart, syntax).markers : [],
    });
  }

  return ranges;
}

function containersOf(ranges: TypeRange[], offset: number): TypeRange[] {
  return ranges.filter((range) => range.start < offset && offset < range.end);
}

function testMarkerOffsets(masked: string, dialect: CLikeDialect): number[] {
  // A line-anchored pattern starts at the indent rather than at the opener.
  const pattern = dialect.testMarker;
  pattern.lastIndex = 0;

  const offsets: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(masked)) !== null) {
    offsets.push(match.index + match[0].indexOf(dialect.markers.opener));
  }
  return offsets;
}

interface ParsedMember {
  name: string;
  signatureOffset: number;
  endOffset: number;
  markers: string[];
  bodyText: string;
}

/** Where a member's body begins after its parameter list: a brace, an `=`/`=>` expression, or neither. */
function findBodyStart(masked: string, from: number): { braceOpen: number; expressionStart: number } {
  // Skips `throws A, B` (Java), `: Type` (Kotlin) and `where T : new()` (C#) to reach the body.
  let k = from;
  while (k < masked.length) {
    const stop = scanTopLevel(masked, k, '{;=');
    if (stop < 0 || masked[stop] === ';') break;
    if (masked[stop] === '{') return { braceOpen: stop, expressionStart: -1 };
    // `==` is a comparison in a constraint or default argument, not the start of a body.
    if (masked[stop + 1] === '=') {
      k = stop + 2;
      continue;
    }
    return { braceOpen: -1, expressionStart: stop + (masked[stop + 1] === '>' ? 2 : 1) };
  }
  return { braceOpen: -1, expressionStart: -1 };
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

  const { braceOpen, expressionStart } = findBodyStart(masked, parenClose + 1);

  if (braceOpen >= 0) {
    const braceClose = matchForward(masked, braceOpen, '{', '}');
    if (braceClose < 0) return undefined;
    return {
      name: named.name,
      signatureOffset: named.start,
      endOffset: braceClose,
      markers,
      bodyText: text.slice(braceOpen + 1, braceClose),
    };
  }

  if (expressionStart >= 0) {
    // A closer with no opener of its own ends the expression: it belongs to the enclosing type.
    const stop = scanTopLevel(masked, expressionStart, dialect.expressionBodyEnd, { unbalancedClose: true });
    const end = stop < 0 ? masked.length : stop;
    return {
      name: named.name,
      signatureOffset: named.start,
      endOffset: end,
      markers,
      bodyText: text.slice(expressionStart, end).trim(),
    };
  }

  return undefined;
}

export function scanCLike(text: string, dialect: CLikeDialect): TestDeclaration[] {
  const masked = maskWith(text, dialect.lexer);
  const starts = lineStarts(text);
  const types = scanTypeRanges(text, masked, dialect.markers);
  const declarations: TestDeclaration[] = [];
  const seen = new Set<number>();

  for (const offset of testMarkerOffsets(masked, dialect)) {
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
      containerMarkers: enclosing[enclosing.length - 1]?.markers ?? [],
      bodyText: member.bodyText,
    });
  }

  return declarations.sort((a, b) => a.startLine - b.startLine);
}
