export interface LexicalRules {
  lineComment: string;
  blockComment?: [open: string, close: string];
  /** Kotlin raw strings and C# raw string literals take backslashes literally. */
  tripleQuoteEscapes: boolean;
  /** Characters that may prefix a quote, e.g. C#'s `@"…"` and `$"…"`. A `verbatim` prefix makes `""` the escape. */
  stringPrefixes?: Record<string, 'verbatim' | 'plain'>;
}

// ----------------------------------------------------------------- literals ----

interface Literal {
  contentStart: number;
  contentEnd: number;
  end: number;
}

function endOfLine(text: string, from: number): number {
  const newline = text.indexOf('\n', from);
  return newline < 0 ? text.length : newline;
}

function quotedLiteral(text: string, quoteIndex: number, rules: LexicalRules): Literal {
  const quote = text[quoteIndex];
  const triple = text.startsWith(quote.repeat(3), quoteIndex);
  const delimiter = triple ? quote.repeat(3) : quote;
  const escapes = !triple || rules.tripleQuoteEscapes;
  const contentStart = quoteIndex + delimiter.length;

  let i = contentStart;
  while (i < text.length) {
    if (escapes && text[i] === '\\') {
      i += 2;
      continue;
    }
    if (text.startsWith(delimiter, i)) {
      return { contentStart, contentEnd: i, end: i + delimiter.length };
    }
    // An unterminated single-line string must not swallow the rest of the file.
    if (!triple && text[i] === '\n') {
      return { contentStart, contentEnd: i, end: i };
    }
    i++;
  }
  return { contentStart, contentEnd: text.length, end: text.length };
}

function verbatimLiteral(text: string, quoteIndex: number): Literal {
  const contentStart = quoteIndex + 1;
  let i = contentStart;
  while (i < text.length) {
    if (text[i] === '"') {
      if (text[i + 1] === '"') {
        i += 2;
        continue;
      }
      return { contentStart, contentEnd: i, end: i + 1 };
    }
    i++;
  }
  return { contentStart, contentEnd: text.length, end: text.length };
}

function literalAt(text: string, index: number, rules: LexicalRules): Literal | undefined {
  const char = text[index];
  const prefixes = rules.stringPrefixes;

  if (prefixes?.[char] !== undefined) {
    let i = index;
    let verbatim = false;
    while (prefixes[text[i]] !== undefined) {
      if (prefixes[text[i]] === 'verbatim') verbatim = true;
      i++;
    }
    if (text[i] !== '"') return undefined;
    return verbatim ? verbatimLiteral(text, i) : quotedLiteral(text, i, rules);
  }

  if (char === '"' || char === "'") {
    return quotedLiteral(text, index, rules);
  }
  return undefined;
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
      const [open, close] = rules.blockComment;
      const closeAt = text.indexOf(close, i + open.length);
      const end = closeAt < 0 ? text.length : closeAt + close.length;
      blank(i, end);
      i = end;
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
