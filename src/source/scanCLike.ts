import { collectMarkers, expandMarkersBackward, type MarkerSyntax } from './markers';
import type { TestDeclaration } from './types';
import { lineOf, lineStarts, matchForward, scanTopLevel } from './text';

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

function scanTypeRanges(text: string, masked: string, dialect: CLikeDialect): TypeRange[] {
  const syntax = dialect.markers;
  const typeDeclaration = new RegExp(`\\b(?:${dialect.typeKeywords.join('|')})[ \\t]+([A-Za-z_]\\w*)`, 'g');
  const ranges: TypeRange[] = [];
  let match: RegExpExecArray | null;

  while ((match = typeDeclaration.exec(masked)) !== null) {
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

/** `masked` is `text` with comments and string contents blanked, offset for offset. */
export function scanCLike(text: string, masked: string, dialect: CLikeDialect): TestDeclaration[] {
  const starts = lineStarts(text);
  const types = scanTypeRanges(text, masked, dialect);
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
