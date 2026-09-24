export interface LexicalRules {
  lineComment: string;
  blockComment?: [open: string, close: string];
  /** Kotlin's block comments nest; Java's and C#'s end at the first close. */
  nestedBlockComments?: boolean;
  /** Whether `\` escapes inside `"""…"""`; not in Kotlin raw strings or C# raw string literals. */
  tripleQuoteEscapes: boolean;
  /**
   * Characters that may prefix a quote, in any combination: C#'s `@"…"` and `$"…"`, Python's
   * `rf"…"`. A `verbatim` prefix makes `""` the escape; an `interpolated` one opens code at `{`.
   */
  stringPrefixes?: Record<string, 'verbatim' | 'interpolated' | 'plain'>;
  /** Opens code inside any double-quoted string, e.g. Kotlin's `${`. */
  templateOpener?: string;
  /** Kotlin's backticked names, kept as they are but skipped whole so a `'` in `doesn't` opens no literal. */
  quotedIdentifier?: string;
}

// ----------------------------------------------------------------- literals ----

interface Literal {
  contentStart: number;
  contentEnd: number;
  end: number;
}

interface StringStyle {
  verbatim: boolean;
  /** Where code starts inside the string, if anywhere. */
  hole?: string;
}

function endOfLine(text: string, from: number): number {
  const newline = text.indexOf('\n', from);
  return newline < 0 ? text.length : newline;
}

/** End (exclusive) of code opened inside a string: it may hold braces and strings of its own. */
function holeEnd(text: string, from: number, rules: LexicalRules): number {
  let depth = 1;
  let i = from;
  while (i < text.length) {
    const literal = literalAt(text, i, rules);
    if (literal) {
      i = Math.max(literal.end, i + 1);
      continue;
    }
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return i + 1;
    i++;
  }
  return text.length;
}

function quotedLiteral(text: string, quoteIndex: number, rules: LexicalRules, style: StringStyle): Literal {
  const quote = text[quoteIndex];
  // A verbatim string's `""` is an escaped quote, never a triple delimiter.
  const triple = !style.verbatim && text.startsWith(quote.repeat(3), quoteIndex);
  const delimiter = triple ? quote.repeat(3) : quote;
  const escapes = !style.verbatim && (!triple || rules.tripleQuoteEscapes);
  const singleLine = !triple && !style.verbatim;
  const hole = style.hole;
  const contentStart = quoteIndex + delimiter.length;

  let i = contentStart;
  while (i < text.length) {
    if (escapes && text[i] === '\\') {
      i += 2;
      continue;
    }
    if (hole && text.startsWith(hole, i)) {
      // A doubled opener is an escaped brace, `{{`.
      if (text.startsWith(hole, i + hole.length)) {
        i += 2 * hole.length;
        continue;
      }
      const end = holeEnd(text, i + hole.length, rules);
      // A hole left open mid-edit must not carry a one-line string past its line.
      i = singleLine && end > endOfLine(text, i) ? i + hole.length : end;
      continue;
    }
    if (text.startsWith(delimiter, i)) {
      if (style.verbatim && text[i + 1] === quote) {
        i += 2;
        continue;
      }
      return { contentStart, contentEnd: i, end: i + delimiter.length };
    }
    // An unterminated single-line string must not swallow the rest of the file.
    if (singleLine && text[i] === '\n') {
      return { contentStart, contentEnd: i, end: i };
    }
    i++;
  }
  return { contentStart, contentEnd: text.length, end: text.length };
}

function literalAt(text: string, index: number, rules: LexicalRules): Literal | undefined {
  const prefixes = rules.stringPrefixes ?? {};
  let quoteIndex = index;
  let verbatim = false;
  let interpolated = false;

  // A prefix starts a token: the `f` closing `if"a"` is part of the keyword.
  if (prefixes[text[index]] !== undefined && !/[\p{L}\p{N}_]/u.test(text[index - 1] ?? '')) {
    while (prefixes[text[quoteIndex]] !== undefined) {
      const kind = prefixes[text[quoteIndex++]];
      verbatim ||= kind === 'verbatim';
      interpolated ||= kind === 'interpolated';
    }
  }

  const quote = text[quoteIndex];
  if (quote !== '"' && quote !== "'") return undefined;
  const hole = interpolated ? '{' : quote === '"' ? rules.templateOpener : undefined;
  return quotedLiteral(text, quoteIndex, rules, { verbatim, hole });
}

// ----------------------------------------------------------------- comments ----

function blockCommentEnd(text: string, from: number, [open, close]: [string, string], nested: boolean): number {
  let depth = 0;
  let i = from;
  while (i < text.length) {
    if (text.startsWith(open, i) && (depth === 0 || nested)) {
      depth++;
      i += open.length;
    } else if (text.startsWith(close, i)) {
      i += close.length;
      if (--depth === 0) return i;
    } else {
      i++;
    }
  }
  return text.length;
}

export function maskWith(text: string, rules: LexicalRules): string {
  const out = text.split('');
  const blank = (from: number, to: number): void => {
    for (let i = Math.max(0, from); i < Math.min(to, text.length); i++) {
      if (out[i] !== '\n' && out[i] !== '\r') out[i] = ' ';
    }
  };

  let i = 0;
  while (i < text.length) {
    if (text.startsWith(rules.lineComment, i)) {
      const end = endOfLine(text, i);
      blank(i, end);
      i = end;
      continue;
    }
    if (rules.blockComment && text.startsWith(rules.blockComment[0], i)) {
      const end = blockCommentEnd(text, i, rules.blockComment, rules.nestedBlockComments ?? false);
      blank(i, end);
      i = end;
      continue;
    }

    if (rules.quotedIdentifier && text[i] === rules.quotedIdentifier) {
      const close = text.indexOf(rules.quotedIdentifier, i + 1);
      i = close < 0 || close > endOfLine(text, i) ? i + 1 : close + 1;
      continue;
    }

    // Skipped over whole, so a `//` inside a string isn't read as a comment.
    const literal = literalAt(text, i, rules);
    if (literal) {
      blank(literal.contentStart, literal.contentEnd);
      i = Math.max(literal.end, i + 1);
      continue;
    }
    i++;
  }

  return out.join('');
}
