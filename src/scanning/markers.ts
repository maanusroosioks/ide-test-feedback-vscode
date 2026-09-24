import { matchBackward, matchForward, skipBackward, skipForward, skipSpaceBackward } from './text';

/** How a family of languages writes the markers (annotations, attributes) that precede a declaration. */
export interface MarkerSyntax {
  opener: string;
  /** Start of the marker ending just before `before`, or -1 when none does. */
  previousMarkerStart(masked: string, before: number): number;
  /** End (exclusive) of the marker opening at `start`, or -1. */
  markerEnd(masked: string, start: number): number;
}

const ANNOTATION_NAME = /[\p{L}\p{N}_.]/u;
const INLINE_SPACE = /[ \t]/;

/** `@Test`, `@DisplayName("x")`, `@org.junit.jupiter.api.Test`. */
export const ANNOTATIONS: MarkerSyntax = {
  opener: '@',

  previousMarkerStart(masked, before) {
    let i = skipSpaceBackward(masked, before - 1);
    if (masked[i] === ')') {
      const open = matchBackward(masked, i, '(', ')');
      if (open < 0) return -1;
      i = skipSpaceBackward(masked, open - 1);
    }
    const name = skipBackward(masked, i, ANNOTATION_NAME);
    if (name === i) return -1;
    const at = skipBackward(masked, name, INLINE_SPACE);
    return masked[at] === '@' ? at : -1;
  },

  markerEnd(masked, start) {
    // `@ Test` is legal, if unusual.
    const nameEnd = skipForward(masked, skipForward(masked, start + 1, INLINE_SPACE), ANNOTATION_NAME);
    // Only spaces/tabs, never a newline: otherwise `@Test\nvoid foo()` eats the parameter list.
    const paren = skipForward(masked, nameEnd, INLINE_SPACE);
    if (masked[paren] !== '(') return nameEnd;
    const close = matchForward(masked, paren, '(', ')');
    return close < 0 ? -1 : close + 1;
  },
};

/** `[Fact]`, `[Theory, InlineData(1)]`. */
export const ATTRIBUTES: MarkerSyntax = {
  opener: '[',

  previousMarkerStart(masked, before) {
    const i = skipSpaceBackward(masked, before - 1);
    return masked[i] === ']' ? matchBackward(masked, i, '[', ']') : -1;
  },

  markerEnd(masked, start) {
    const close = matchForward(masked, start, '[', ']');
    return close < 0 ? -1 : close + 1;
  },
};

/** Walks back over contiguous markers. Comments are masked to blanks, so one between markers is walked over. */
export function expandMarkersBackward(masked: string, offset: number, syntax: MarkerSyntax): number {
  let start = offset;
  for (;;) {
    const previous = syntax.previousMarkerStart(masked, start);
    if (previous < 0) return start;
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
    i = skipForward(masked, i, /\s/);
    if (masked[i] !== syntax.opener) break;
    const end = syntax.markerEnd(masked, i);
    if (end < 0) break;
    markers.push(text.slice(i, end).trim());
    i = end;
  }

  return { markers, end: i };
}
