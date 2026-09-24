import type { TestDeclaration } from './types';
import { scanTopLevel } from './text';

const PY_DECORATOR = /^[ \t]*@/;
const PY_CLASS = /^[ \t]*class[ \t]+([\p{L}_][\p{L}\p{N}_]*)/u;
// pytest's default `python_functions = test*`.
const PY_TEST = /^[ \t]*(?:async[ \t]+)?def[ \t]+(test[\p{L}\p{N}_]*)[ \t]*\(/u;

interface PythonClass {
  name: string;
  indent: number;
  markers: string[];
}

interface PendingMarkers {
  indent: number;
  startLine: number;
  markers: string[];
}

/**
 * Lines that begin inside brackets, a triple-quoted string or after a trailing `\`: their
 * indentation says nothing about blocks, e.g. a string's closing `"""` back at column 0.
 */
function continuationLines(maskedLines: string[]): boolean[] {
  const continued: boolean[] = [];
  let depth = 0;
  let openTriple: string | undefined;
  let backslash = false;

  for (const line of maskedLines) {
    continued.push(depth > 0 || openTriple !== undefined || backslash);
    // String contents are masked, so any quote left is a delimiter.
    for (let c = 0; c < line.length; c++) {
      const char = line[c];
      if (openTriple !== undefined) {
        if (line.startsWith(openTriple, c)) {
          c += 2;
          openTriple = undefined;
        }
      } else if (char === '"' || char === "'") {
        if (line.startsWith(char.repeat(3), c)) {
          openTriple = char.repeat(3);
          c += 2;
        } else {
          const close = line.indexOf(char, c + 1);
          c = close < 0 ? line.length : close;
        }
      } else if (char === '(' || char === '[' || char === '{') {
        depth++;
      } else if (char === ')' || char === ']' || char === '}') {
        depth = Math.max(0, depth - 1);
      }
    }
    backslash = openTriple === undefined && /\\\s*$/.test(line);
  }

  return continued;
}

/** `masked` is `text` with comments and string contents blanked, offset for offset. */
export function scanPython(text: string, masked: string): TestDeclaration[] {
  const lines = text.split('\n');
  const maskedLines = masked.split('\n');
  const continued = continuationLines(maskedLines);
  const declarations: TestDeclaration[] = [];
  const classStack: PythonClass[] = [];
  let pending: PendingMarkers | undefined;

  const indentOf = (line: string): number => line.length - line.trimStart().length;
  const opensStatement = (index: number): boolean => !continued[index] && maskedLines[index].trim() !== '';
  /** Last physical line of the logical line starting at `from`, so multi-line decorators and signatures stay whole. */
  const statementEnd = (from: number): number => {
    let end = from;
    while (end + 1 < lines.length && continued[end + 1]) end++;
    return end;
  };

  for (let i = 0; i < lines.length; i++) {
    if (!opensStatement(i)) continue;
    const maskedLine = maskedLines[i];
    const indent = indentOf(maskedLine);

    while (classStack.length > 0 && classStack[classStack.length - 1].indent >= indent) {
      classStack.pop();
    }

    if (PY_DECORATOR.test(maskedLine)) {
      const end = statementEnd(i);
      const marker = lines.slice(i, end + 1).join('\n').trim();
      if (pending?.indent === indent) {
        pending.markers.push(marker);
      } else {
        pending = { indent, startLine: i + 1, markers: [marker] };
      }
      i = end;
      continue;
    }

    // Decorators belong to whatever statement follows them at their indent, test or not.
    const attached = pending?.indent === indent ? pending : undefined;
    pending = undefined;

    const classMatch = PY_CLASS.exec(maskedLine);
    if (classMatch) {
      classStack.push({ name: classMatch[1], indent, markers: attached?.markers ?? [] });
      continue;
    }

    const testMatch = PY_TEST.exec(maskedLine);
    if (!testMatch) continue;

    // Bracket-aware, so neither a parameter's `: int` nor a default's `lambda:` ends the signature.
    const signatureEnd = statementEnd(i);
    const signature = maskedLines.slice(i, signatureEnd + 1).join('\n');
    const colon = scanTopLevel(signature, 0, ':');
    const inline = colon >= 0 ? signature.slice(colon + 1) : '';

    let endLine: number;
    let bodyText: string;
    if (inline.trim() !== '') {
      endLine = signatureEnd + 1;
      bodyText = lines.slice(i, signatureEnd + 1).join('\n').slice(colon + 1).trim();
    } else {
      let last = signatureEnd;
      for (let j = signatureEnd + 1; j < lines.length; j++) {
        if (!opensStatement(j)) continue;
        if (indentOf(maskedLines[j]) <= indent) break;
        last = statementEnd(j);
      }
      endLine = last + 1;
      bodyText = lines.slice(signatureEnd + 1, last + 1).join('\n');
    }

    declarations.push({
      name: testMatch[1],
      container: classStack.length > 0 ? classStack.map((entry) => entry.name).join('.') : undefined,
      startLine: attached?.startLine ?? i + 1,
      endLine,
      markers: attached?.markers ?? [],
      containerMarkers: classStack.flatMap((entry) => entry.markers),
      bodyText,
    });
    i = endLine - 1;
  }

  return declarations;
}
