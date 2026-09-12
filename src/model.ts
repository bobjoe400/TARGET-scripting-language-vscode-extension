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

export function buildModel(text: string): DocModel {
  const tokens = lex(text);
  const sig = tokens.filter((t) => t.kind !== TokKind.Comment);

  const calls: CallNode[] = [];
  const allCalls: CallNode[] = [];
  const decls: Decl[] = [];
  const includes: IncludeRef[] = [];

  const frames: Frame[] = [];
  const callStack: CallNode[] = [];
  let braceDepth = 0;

  const lineOf = (offset: number) => {
    let line = 0;
    for (let i = 0; i < offset && i < text.length; i++) if (text[i] === '\n') line++;
    return line;
  };

  for (let i = 0; i < sig.length; i++) {
    const t = sig[i];

    if (t.kind === TokKind.Punct) {
      if (t.value === '(') {
        const prev = sig[i - 1];
        let node: CallNode | null = null;
        if (prev && prev.kind === TokKind.Ident) {
          node = {
            name: prev.value,
            nameStart: prev.start,
            nameEnd: prev.end,
            open: t.start,
            close: -1,
            args: [],
            parent: callStack.length ? callStack[callStack.length - 1] : null,
            children: [],
          };
          if (node.parent) node.parent.children.push(node);
          else calls.push(node);
          allCalls.push(node);
          callStack.push(node);
        }
        frames.push({ call: node, argStart: t.end });
        continue;
      }

      if (t.value === ')') {
        const frame = frames.pop();
        if (frame?.call) {
          const raw = text.slice(frame.argStart, t.start);
          if (raw.trim() || frame.call.args.length > 0) {
            frame.call.args.push({ start: frame.argStart, end: t.start, text: raw.trim() });
          }
          frame.call.close = t.end;
          callStack.pop();
        }
        continue;
      }

      if (t.value === ',') {
        const frame = frames[frames.length - 1];
        if (frame?.call) {
          frame.call.args.push({
            start: frame.argStart,
            end: t.start,
            text: text.slice(frame.argStart, t.start).trim(),
          });
          frame.argStart = t.end;
        }
        continue;
      }

      if (t.value === '{') braceDepth++;
      else if (t.value === '}') braceDepth = Math.max(0, braceDepth - 1);
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
      frames.length === 0 &&
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
      }
      continue;
    }

    if (TYPE_KEYWORDS.has(t.value)) {
      i = parseDeclaration(text, sig, i, braceDepth, decls);
      continue;
    }
  }

  return { text, tokens, calls, allCalls, decls, includes };
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
  out: Decl[]
): number {
  const typeTok = sig[start];
  const type = typeTok.value;
  let i = start + 1;

  if (type === 'struct') {
    const name = sig[i];
    if (name?.kind === TokKind.Ident) {
      out.push({
        kind: 'struct',
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
      if (afterParen?.kind === TokKind.Punct && afterParen.value === '{') {
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
        out.push({
          kind: 'function',
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
        // Stop at the parameter list's ')' rather than at the end of the body: the
        // caller resumes scanning inside the body, where the calls actually live.
        return j;
      }
      out.push({
        kind: 'function',
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
    }

    const isArray = next?.kind === TokKind.Punct && next.value === '[';
    out.push({
      kind: type === 'alias' ? 'alias' : 'variable',
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

/** The innermost call containing `offset`, plus which argument the cursor is in. */
export function callContextAt(
  model: DocModel,
  offset: number
): { call: CallNode; argIndex: number } | null {
  let best: CallNode | null = null;
  for (const c of model.allCalls) {
    const end = c.close === -1 ? model.text.length : c.close;
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
