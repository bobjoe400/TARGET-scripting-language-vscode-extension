// Builds a structural model of a TARGET document from the token stream:
// call expressions with their arguments and nesting, declarations, includes.
//
// Everything the providers need is derived here once per document version, so
// completion, hover, symbols and diagnostics all agree on what the file contains.

import { lex, Token, TokKind } from './lexer';

export const TYPE_KEYWORDS = new Set(['char', 'byte', 'short', 'word', 'int', 'float', 'alias', 'struct']);

export interface CallArg {
  start: number;
  end: number;
  /** Trimmed source text of the argument. */
  text: string;
}

export interface CallNode {
  name: string;
  nameStart: number;
  nameEnd: number;
  /** Offset of '('. */
  open: number;
  /** Offset of ')', or -1 when the call is still unclosed (mid-typing). */
  close: number;
  args: CallArg[];
  parent: CallNode | null;
  children: CallNode[];
}

export type DeclKind = 'function' | 'variable' | 'define' | 'alias' | 'struct';

export interface Decl {
  kind: DeclKind;
  name: string;
  /** Comment block documenting this declaration, or '' when it has none. */
  doc: string;
  start: number;
  end: number;
  /** Whole statement span, used for the symbol's outline range. */
  fullStart: number;
  fullEnd: number;
  type: string | null;
  /** Text after '=' for defines and aliases, else null. */
  value: string | null;
  detail: string;
  global: boolean;
}

export interface IncludeRef {
  path: string;
  /** Offsets of the path text, excluding the quotes. */
  start: number;
  end: number;
  line: number;
}

export interface DocModel {
  text: string;
  tokens: Token[];
  /** Character spans of variable initialisers; calls inside them are not statements. */
  initialiserSpans: [number, number][];
  calls: CallNode[];
  /** Every call, flattened, in source order. */
  allCalls: CallNode[];
  decls: Decl[];
  includes: IncludeRef[];
}

interface Frame {
  call: CallNode | null;
  argStart: number;
}

/**
 * Builds call nodes out of the parenthesis, comma and closing-paren tokens fed to it.
 *
 * One implementation, fed from two places: the main scan of the file, and afterwards
 * the variable initialisers whose tokens the declaration parser consumes. Without that
 * second pass a call in an initialiser - `int q = SetSCurve(...);`, `int fp = fopen(...)`
 * - exists for nobody: no arity or range check, no EXEC body check, and no signature
 * help while typing it. The two used to be separate copies of this loop.
 */
class CallCollector {
  private frames: Frame[] = [];
  private stack: CallNode[] = [];

  constructor(
    private readonly text: string,
    /** Calls with no enclosing call. */
    private readonly roots: CallNode[],
    /** Every call, in the order they were opened. */
    private readonly all: CallNode[]
  ) {}

  /** How many argument lists are open; zero means we are at statement level. */
  get openFrames(): number {
    return this.frames.length;
  }

  /** Abandons every unclosed call, at a token that cannot appear inside an argument list. */
  reset(): void {
    this.frames.length = 0;
    this.stack.length = 0;
  }

  /**
   * Feeds the punctuation token at `i`, returning true when it was part of a call
   * expression and the caller should look no further at it.
   *
   * `from` is where the caller's slice of tokens begins: the identifier before a '(' is
   * only the callee when it belongs to the same slice.
   */
  feed(sig: Token[], i: number, from = 0): boolean {
    const t = sig[i];
    if (t.value === '(') {
      const prev = sig[i - 1];
      let node: CallNode | null = null;
      if (prev && prev.kind === TokKind.Ident && i - 1 >= from) {
        node = {
          name: prev.value,
          nameStart: prev.start,
          nameEnd: prev.end,
          open: t.start,
          close: -1,
          args: [],
          parent: this.stack.length ? this.stack[this.stack.length - 1] : null,
          children: [],
        };
        if (node.parent) node.parent.children.push(node);
        else this.roots.push(node);
        this.all.push(node);
        this.stack.push(node);
      }
      this.frames.push({ call: node, argStart: t.end });
      return true;
    }

    if (t.value === ')') {
      const frame = this.frames.pop();
      if (frame?.call) {
        const raw = this.text.slice(frame.argStart, t.start);
        if (raw.trim() || frame.call.args.length > 0) {
          frame.call.args.push({ start: frame.argStart, end: t.start, text: raw.trim() });
        }
        frame.call.close = t.end;
        this.stack.pop();
      }
      return true;
    }

    if (t.value === ',') {
      const frame = this.frames[this.frames.length - 1];
      if (frame?.call) {
        frame.call.args.push({
          start: frame.argStart,
          end: t.start,
          text: this.text.slice(frame.argStart, t.start).trim(),
        });
        frame.argStart = t.end;
      }
      return true;
    }

    return false;
  }
}

/**
 * The comment block documenting a declaration at `offset`.
 *
 * Real scripts separate the block from the declaration by a blank line:
 *
 *     // FUNCTION:  Sets PIP profiles
 *     // Parameter: 0 = Reset, 1 = Increment, 2 = Decrement
 *
 *     int fnPIPMode(int x) {
 *
 * so a search for comments immediately above would find nothing. Up to two blank
 * lines are stepped over, and a banner of dashes or equals signs ends the search:
 * it divides sections rather than documenting the line beneath it.
 */
export function docCommentAbove(lines: string[], lineIndex: number): string {
  const isBanner = (s: string) => /^\s*\/[/*]\s*[-=*_#]{3,}/.test(s) || /^\s*[-=*_#]{5,}\s*$/.test(s);
  const collected: string[] = [];
  let i = lineIndex - 1;
  let blanks = 0;

  while (i >= 0) {
    const line = lines[i];
    if (line.trim() === '') {
      // Blank lines are allowed before the block, but end it once it has started.
      if (collected.length) break;
      if (++blanks > 2) break;
      i--;
      continue;
    }
    if (isBanner(line)) break;

    const lineComment = line.match(/^\s*\/\/\s?(.*)$/);
    if (lineComment) {
      collected.unshift(lineComment[1].replace(/\s+$/, ''));
      i--;
      continue;
    }

    // A block comment ending just above, e.g. `... */`.
    if (/\*\/\s*$/.test(line) && !collected.length) {
      const block: string[] = [];
      let j = i;
      while (j >= 0 && !/\/\*/.test(lines[j])) {
        block.unshift(lines[j]);
        j--;
      }
      if (j >= 0) {
        block.unshift(lines[j]);
        const body = block
          .join('\n')
          .replace(/^[\s\S]*?\/\*+/, '')
          .replace(/\*+\/\s*$/, '')
          .split('\n')
          .map((l) => l.replace(/^\s*\*?\s?/, '').replace(/\s+$/, ''));
        while (body.length && body[0].trim() === '') body.shift();
        while (body.length && body[body.length - 1].trim() === '') body.pop();
        return body.join('\n');
      }
    }
    break; // code
  }

  while (collected.length && collected[0].trim() === '') collected.shift();
  while (collected.length && collected[collected.length - 1].trim() === '') collected.pop();
  // Tabs are used for alignment inside these blocks and mean nothing in markdown.
  return collected.map((l) => l.replace(/\t+/g, ' ')).join('\n');
}

/** Builds call nodes from one slice of significant tokens, e.g. an initialiser. */
function extractCalls(
  sig: Token[],
  from: number,
  to: number,
  text: string,
  roots: CallNode[],
  all: CallNode[]
): void {
  const calls = new CallCollector(text, roots, all);
  for (let i = from; i < to && i < sig.length; i++) {
    if (sig[i].kind === TokKind.Punct) calls.feed(sig, i, from);
  }
}

export function buildModel(text: string): DocModel {
  const tokens = lex(text);
  const sig = tokens.filter((t) => t.kind !== TokKind.Comment);

  const calls: CallNode[] = [];
  const allCalls: CallNode[] = [];
  const decls: Decl[] = [];
  const includes: IncludeRef[] = [];

  const collector = new CallCollector(text, calls, allCalls);
  /** Token ranges of variable initialisers, scanned for calls after the main loop. */
  const initialiserRanges: [number, number][] = [];
  let braceDepth = 0;

  // Built once: computing a line number per declaration by scanning from the start
  // would be quadratic on the larger headers.
  const lines = text.split('\n');
  const lineStarts: number[] = [0];
  for (let i = 0; i < lines.length; i++) lineStarts.push(lineStarts[i] + lines[i].length + 1);
  const lineOf = (offset: number) => {
    let lo = 0;
    let hi = lines.length - 1;
    let ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lineStarts[mid] <= offset) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return ans;
  };
  const docAbove = (offset: number) => docCommentAbove(lines, lineOf(offset));

  for (let i = 0; i < sig.length; i++) {
    const t = sig[i];

    if (t.kind === TokKind.Punct) {
      if (collector.feed(sig, i)) continue;

      if (t.value === '{') braceDepth++;
      else if (t.value === '}') {
        braceDepth = Math.max(0, braceDepth - 1);
        // See the semicolon note below: a brace also ends any unclosed call.
        collector.reset();
      } else if (t.value === ';') {
        // A statement terminator closes any call left open by a missing ')'.
        //
        // Declarations are only recognised while no call is in progress, and a frame
        // is popped only by ')'. So one unclosed paren - which is the state of the
        // file for as long as you are mid-way through typing a call - made every
        // declaration below it invisible: the outline emptied, and diagnostics
        // reported missing-main and unknown-function for code three lines away.
        // TARGET has no `for(;;)`, so a semicolon can never be inside an argument list.
        collector.reset();
      }
      continue;
    }

    if (t.kind !== TokKind.Ident) continue;

    // Declarations are only recognised at statement level, never inside an
    // argument list, so that `alias` as a parameter type is not mistaken for one.
    //
    // `define` and `include` are terminated by the newline, not by a semicolon, so
    // starting a fresh line counts as a statement boundary too. Without this, only
    // the first of a run of consecutive `define`s would ever be seen.
    const prevTok = sig[i - 1];
    const atStatementStart =
      collector.openFrames === 0 &&
      (i === 0 ||
        (prevTok.kind === TokKind.Punct && [';', '{', '}'].includes(prevTok.value)) ||
        text.slice(prevTok.end, t.start).includes('\n'));

    if (!atStatementStart) continue;

    if (t.value === 'include') {
      const next = sig[i + 1];
      if (next?.kind === TokKind.String) {
        const inner = next.value.replace(/^"|"$/g, '');
        includes.push({ path: inner, start: next.start + 1, end: next.end - 1, line: lineOf(next.start) });
      }
      continue;
    }

    if (t.value === 'define') {
      const name = sig[i + 1];
      if (name?.kind === TokKind.Ident) {
        // The value runs to end of line: `define` takes no terminating semicolon.
        const lineEnd = text.indexOf('\n', name.end);
        const stop = lineEnd === -1 ? text.length : lineEnd;
        const rawValue = stripComment(text.slice(name.end, stop)).trim();
        decls.push({
          kind: 'define',
          doc: docAbove(t.start),
          name: name.value,
          start: name.start,
          end: name.end,
          fullStart: t.start,
          fullEnd: stop,
          type: null,
          value: rawValue,
          detail: rawValue,
          global: true,
        });
        // Skip the value. Without this, `define X (1+2)` leaves `X (` for the main
        // loop, which reads it as a call to X - and X is a real builtin, so it would
        // draw a spurious arity error.
        while (i + 1 < sig.length && sig[i + 1].start < stop) i++;
      }
      continue;
    }

    if (TYPE_KEYWORDS.has(t.value)) {
      i = parseDeclaration(text, sig, i, braceDepth, decls, docAbove, initialiserRanges);
      continue;
    }
  }

  // Initialisers are consumed by the declaration parser, so their calls are picked up
  // here rather than being invisible to every feature keyed on allCalls.
  for (const [from, to] of initialiserRanges) extractCalls(sig, from, to, text, calls, allCalls);
  allCalls.sort((a, b) => a.nameStart - b.nameStart);

  const initialiserSpans: [number, number][] = initialiserRanges
    .map(([from, to]) => [sig[from]?.start ?? 0, sig[Math.min(to, sig.length - 1)]?.end ?? 0] as [number, number])
    .filter(([a, b]) => b > a);

  return { text, tokens, calls, allCalls, decls, includes, initialiserSpans };
}

function stripComment(s: string): string {
  const i = s.indexOf('//');
  return i === -1 ? s : s.slice(0, i);
}

/**
 * Parses one declaration statement starting at the type keyword.
 * Returns the index of the last token consumed.
 *
 * TARGET declares reusable events as variables (`int autopilot;`) and real
 * functions with the same leading syntax (`int MainKeyMap() { ... }`), so the two
 * are told apart by what follows the name.
 */
function parseDeclaration(
  text: string,
  sig: Token[],
  start: number,
  braceDepth: number,
  out: Decl[],
  docAbove: (offset: number) => string,
  initialiserRanges?: [number, number][]
): number {
  const typeTok = sig[start];
  const type = typeTok.value;
  let i = start + 1;

  if (type === 'struct') {
    const name = sig[i];
    if (name?.kind === TokKind.Ident) {
      out.push({
        kind: 'struct',
        doc: docAbove(typeTok.start),
        name: name.value,
        start: name.start,
        end: name.end,
        fullStart: typeTok.start,
        fullEnd: name.end,
        type: 'struct',
        value: null,
        detail: 'struct',
        global: braceDepth === 0,
      });
      return i;
    }
    return start;
  }

  // A statement may declare several names: `alias a = "x", b = "y";`
  let depth = 0;
  let expectName = true;
  for (; i < sig.length; i++) {
    const t = sig[i];
    if (t.kind === TokKind.Punct) {
      if (t.value === '(' || t.value === '[' || t.value === '{') depth++;
      else if (t.value === ')' || t.value === ']' || t.value === '}') depth--;
      else if (t.value === ';' && depth <= 0) return i;
      else if (t.value === ',' && depth === 0) expectName = true;
      continue;
    }
    if (t.kind !== TokKind.Ident || !expectName || depth !== 0) continue;

    expectName = false;
    const name = t;
    const next = sig[i + 1];

    if (next?.kind === TokKind.Punct && next.value === '(') {
      // Function definition: capture the parameter list for signature help.
      let d = 0;
      let j = i + 1;
      for (; j < sig.length; j++) {
        if (sig[j].kind !== TokKind.Punct) continue;
        if (sig[j].value === '(') d++;
        else if (sig[j].value === ')') {
          d--;
          if (d === 0) break;
        }
      }
      const paramText = text.slice(next.end, sig[j]?.start ?? next.end).trim();
      // The body, if present, ends the statement.
      let end = sig[j]?.end ?? name.end;
      const afterParen = sig[j + 1];
      const hasBody = afterParen?.kind === TokKind.Punct && afterParen.value === '{';
      if (hasBody) {
        let bd = 0;
        let k = j + 1;
        for (; k < sig.length; k++) {
          if (sig[k].kind !== TokKind.Punct) continue;
          if (sig[k].value === '{') bd++;
          else if (sig[k].value === '}') {
            bd--;
            if (bd === 0) break;
          }
        }
        end = sig[k]?.end ?? end;
      }
      out.push({
        kind: 'function',
        doc: docAbove(typeTok.start),
        name: name.value,
        start: name.start,
        end: name.end,
        fullStart: typeTok.start,
        fullEnd: end,
        type,
        value: null,
        detail: `${type} ${name.value}(${paramText})`,
        global: braceDepth === 0,
      });
      // With a body, stop at the parameter list's ')' rather than at the end of the
      // body: the caller resumes scanning inside it, where the calls actually live.
      if (hasBody) return j;
      i = j;
      continue;
    }

    // Variable, possibly with an initialiser.
    let value: string | null = null;
    if (next?.kind === TokKind.Punct && (next.value === '=' || next.value === '[')) {
      let d = 0;
      let j = i + 1;
      for (; j < sig.length; j++) {
        const s = sig[j];
        if (s.kind !== TokKind.Punct) continue;
        if ('(['.includes(s.value) || s.value === '{') d++;
        else if (')]'.includes(s.value) || s.value === '}') d--;
        else if ((s.value === ';' || s.value === ',') && d <= 0) break;
      }
      value = stripComment(text.slice(next.start, sig[j]?.start ?? next.start)).trim().replace(/^=\s*/, '');
      initialiserRanges?.push([i + 1, j]);
    }

    const isArray = next?.kind === TokKind.Punct && next.value === '[';
    out.push({
      kind: type === 'alias' ? 'alias' : 'variable',
      doc: docAbove(typeTok.start),
      name: name.value,
      start: name.start,
      end: name.end,
      fullStart: typeTok.start,
      fullEnd: name.end,
      type,
      value,
      detail: `${type} ${name.value}${isArray ? '[]' : ''}${value ? ' = ' + truncate(value, 40) : ''}`,
      global: braceDepth === 0,
    });
  }
  return i;
}

const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** Where to stop pretending an unclosed call continues. */
function unclosedCallEnd(text: string, open: number): number {
  // Matched by pattern, not by literal '\n\n'. Real TARGET files are CRLF - the
  // vendor headers and anything Thrustmaster's own editor writes - so a blank line is
  // '\r\n\r\n' and the literal never matched, leaving this bound dead on exactly the
  // files most users have.
  const rest = text.slice(open);
  const blank = rest.search(/\r?\n[ \t]*\r?\n/);
  const brace = rest.search(/\r?\n\s*\}/);
  const candidates = [blank, brace].filter((n) => n !== -1).map((n) => open + n);
  return candidates.length ? Math.min(...candidates) : text.length;
}

/** The innermost call containing `offset`, plus which argument the cursor is in. */
export function callContextAt(
  model: DocModel,
  offset: number
): { call: CallNode; argIndex: number } | null {
  let best: CallNode | null = null;
  for (const c of model.allCalls) {
    // An unclosed call is bounded at the next blank line or closing brace rather than
    // running to end of file. Without that, one missing ')' made every later position
    // report as inside that call: completion narrowed to its argument domain and a
    // stale signature popup pinned itself for the rest of the document.
    const end = c.close === -1 ? unclosedCallEnd(model.text, c.open) : c.close;
    if (offset > c.open && offset <= end) {
      if (!best || c.open > best.open) best = c;
    }
  }
  if (!best) return null;

  // Argument index is the number of top-level commas between '(' and the cursor.
  let argIndex = 0;
  let depth = 0;
  for (const t of model.tokens) {
    if (t.start < best.open + 1) continue;
    if (t.start >= offset) break;
    if (t.kind !== TokKind.Punct) continue;
    if ('(['.includes(t.value) || t.value === '{') depth++;
    else if (')]'.includes(t.value) || t.value === '}') depth--;
    else if (t.value === ',' && depth === 0) argIndex++;
  }
  return { call: best, argIndex };
}

/**
 * Device aliases bound by the script itself.
 *
 * Real scripts rarely name hardware directly. They declare a bare handle and bind it
 * at runtime once the hardware has been detected:
 *
 *     alias MyJoystick;
 *     &MyJoystick = &T16000;
 *     &MyJoystick = &T16000L;
 *
 * so a handle can stand for several devices depending on the branch taken. The result
 * maps each handle to every device it is ever bound to.
 */
export function collectAliasBindings(model: DocModel): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const sig = model.tokens.filter((t) => t.kind !== TokKind.Comment);

  const bind = (name: string, device: string) => {
    if (!out.has(name)) out.set(name, new Set());
    out.get(name)!.add(device);
  };

  for (let i = 0; i < sig.length; i++) {
    // [&] Name = & Device
    let k = i;
    if (sig[k].kind === TokKind.Punct && sig[k].value === '&') k++;
    const name = sig[k];
    if (!name || name.kind !== TokKind.Ident) continue;
    const eq = sig[k + 1];
    if (!eq || eq.kind !== TokKind.Punct || eq.value !== '=') continue;
    const amp = sig[k + 2];
    if (!amp || amp.kind !== TokKind.Punct || amp.value !== '&') continue;
    const dev = sig[k + 3];
    if (!dev || dev.kind !== TokKind.Ident) continue;
    bind(name.value, dev.value);
    i = k + 3;
  }

  // `alias X = "VID_044F&PID_B10A";` names the hardware by its USB id instead.
  for (const d of model.decls) {
    if (d.kind !== 'alias' || !d.value) continue;
    const m = d.value.match(/"(VID_[0-9A-Fa-f]+&PID_[0-9A-Fa-f]+)"/);
    if (m) bind(d.name, `usb:${m[1]}`);
  }

  return out;
}
