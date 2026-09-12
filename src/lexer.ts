// A small hand-written lexer for TARGET source.
//
// The language features need to know exactly where strings and comments are (an
// identifier inside a comment is not a call, and EXEC's argument is source code
// wrapped in a string). Regex scanning gets this wrong at the edges, so the
// structure is recovered properly once here and reused by every provider.

export enum TokKind {
  Comment,
  String,
  Char,
  Ident,
  Number,
  Punct,
}

export interface Token {
  kind: TokKind;
  start: number;
  end: number;
  /** Source text of the token, verbatim. */
  value: string;
}

const isIdentStart = (c: string) => /[A-Za-z_]/.test(c);
const isIdentPart = (c: string) => /[A-Za-z0-9_]/.test(c);
const isDigit = (c: string) => c >= '0' && c <= '9';

export function lex(text: string): Token[] {
  const out: Token[] = [];
  const n = text.length;
  let i = 0;

  while (i < n) {
    const c = text[i];

    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      i++;
      continue;
    }

    // Comments
    if (c === '/' && text[i + 1] === '/') {
      const start = i;
      while (i < n && text[i] !== '\n') i++;
      out.push({ kind: TokKind.Comment, start, end: i, value: text.slice(start, i) });
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const start = i;
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i = Math.min(i + 2, n);
      out.push({ kind: TokKind.Comment, start, end: i, value: text.slice(start, i) });
      continue;
    }

    // String literal. An unterminated one stops at end of line rather than eating the
    // rest of the file, which keeps a typo from poisoning everything below it.
    if (c === '"') {
      const start = i;
      i++;
      while (i < n && text[i] !== '"' && text[i] !== '\n') {
        if (text[i] === '\\') i++;
        i++;
      }
      if (i < n && text[i] === '"') i++;
      out.push({ kind: TokKind.String, start, end: i, value: text.slice(start, i) });
      continue;
    }

    if (c === "'") {
      const start = i;
      i++;
      while (i < n && text[i] !== "'" && text[i] !== '\n') {
        if (text[i] === '\\') i++;
        i++;
      }
      if (i < n && text[i] === "'") i++;
      out.push({ kind: TokKind.Char, start, end: i, value: text.slice(start, i) });
      continue;
    }

    if (isIdentStart(c)) {
      const start = i;
      while (i < n && isIdentPart(text[i])) i++;
      out.push({ kind: TokKind.Ident, start, end: i, value: text.slice(start, i) });
      continue;
    }

    if (isDigit(c) || (c === '.' && isDigit(text[i + 1]))) {
      const start = i;
      if (c === '0' && (text[i + 1] === 'x' || text[i + 1] === 'X')) {
        i += 2;
        while (i < n && /[0-9A-Fa-f]/.test(text[i])) i++;
      } else {
        while (i < n && (isDigit(text[i]) || text[i] === '.')) i++;
        if (i < n && /[eE]/.test(text[i])) {
          i++;
          if (i < n && (text[i] === '+' || text[i] === '-')) i++;
          while (i < n && isDigit(text[i])) i++;
        }
      }
      out.push({ kind: TokKind.Number, start, end: i, value: text.slice(start, i) });
      continue;
    }

    out.push({ kind: TokKind.Punct, start: i, end: i + 1, value: c });
    i++;
  }

  return out;
}

/** Index of the last token that starts at or before `offset`, or -1. */
export function tokenIndexBefore(tokens: Token[], offset: number): number {
  let lo = 0;
  let hi = tokens.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (tokens[mid].start <= offset) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/** True when `offset` falls inside a comment or string, where completion should stay quiet. */
export function tokenAt(tokens: Token[], offset: number): Token | null {
  const i = tokenIndexBefore(tokens, offset);
  if (i < 0) return null;
  const t = tokens[i];
  return offset >= t.start && offset <= t.end ? t : null;
}
