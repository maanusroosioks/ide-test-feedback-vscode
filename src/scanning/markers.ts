import { matchBackward, matchForward } from './text';

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

/** Walks back over contiguous markers. Masked Javadoc reads as blank, so it stops there. */
export function expandMarkersBackward(masked: string, offset: number, syntax: MarkerSyntax): number {
  let start = offset;
  for (;;) {
    const previous = syntax.previousMarkerStart(masked, start);
    if (previous === undefined) return start;
    start = previous;
  }
}

export function collectMarkers(
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
