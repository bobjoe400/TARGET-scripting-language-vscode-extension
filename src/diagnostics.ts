// Diagnostics for the sharp edges the TARGET compiler reports poorly or not at all.
//
// Every rule here is grounded in something checkable: a signature or a masking
// expression in target.tmh, or a restriction the manual states outright. Rules that
// would need guesswork are left out rather than shipped with false positives.

import * as path from 'path';
import { DocModel, CallNode } from './model';
import { TokKind, lex, Token } from './lexer';
import { SCRIPT_MODIFIERS, SCRIPT_STATE_FLAGS, parseChord } from './binds';
import {
  functionsByName,
  constantsByName,
  devicesByAlias,
  devices,
  NOT_IN_TARGET,
  FORBIDDEN_IN_EXEC,
  DISPUTED_IN_EXEC,
  normalizeUsbCode,
  own,
  shortKeyName,
  usbKeyName,
  Device,
  devicesForHandle,
} from './builtins';

export const DIAG_SOURCE = 'target';

export type Severity = 'error' | 'warning' | 'info';

/**
 * A diagnostic in plain offsets, with no editor types. Keeping this module free of
 * `vscode` lets the whole rule set run against the real script corpus in a plain
 * node test, which is the only practical way to keep false positives at zero.
 */
export interface RawDiagnostic {
  start: number;
  end: number;
  message: string;
  severity: Severity;
  code: string;
}

/** button/axis name -> the devices that actually have it. */
const controlOwners = (() => {
  const m = new Map<string, Set<string>>();
  for (const d of devices) {
    for (const c of [...d.buttons, ...d.axes, ...d.hats]) {
      if (!m.has(c.name)) m.set(c.name, new Set());
      m.get(c.name)!.add(d.alias);
    }
  }
  return m;
})();

interface ResolvedDevice {
  alias: string;
  label: string;
  controlsByName: Map<string, { name: string; value: string }>;
  controlsByValue: Map<string, { name: string; value: string }>;
}

const resolvedCache = new Map<string, ResolvedDevice>();

/** The control tables for a device, built once and kept. */
function resolved(dev: Device): ResolvedDevice {
  const hit = resolvedCache.get(dev.alias);
  if (hit) return hit;
  const controls = [...dev.buttons, ...dev.axes, ...dev.hats];
  const r: ResolvedDevice = {
    alias: dev.alias,
    label: dev.label,
    controlsByName: new Map(controls.map((c) => [c.name, c])),
    controlsByValue: new Map(),
  };
  // First name wins, so the device's own primary name is reported rather than a synonym.
  for (const c of controls) if (!r.controlsByValue.has(c.value)) r.controlsByValue.set(c.value, c);
  resolvedCache.set(dev.alias, r);
  return r;
}

interface RangeRule {
  /** Argument index (0-based) to check. */
  arg: number;
  min: number;
  max: number;
  what: string;
  why: string;
}

/**
 * Numeric ranges, each derived from target.tmh rather than from the manual:
 *  - SetSCurve's curve parameter is documented in the header as -32..32.
 *  - LEDV masks its value with `& 7` and its index with `& 0x1f`.
 *  - LEDRGB takes `byte` components.
 *  - TrimDXAxis treats |value| < 0x3ff as a relative trim.
 */
const RANGE_RULES: Record<string, RangeRule[]> = {
  SetSCurve: [
    { arg: 2, min: 0, max: 100, what: 'lower deadzone', why: 'percent' },
    { arg: 3, min: 0, max: 100, what: 'center deadzone', why: 'percent' },
    { arg: 4, min: 0, max: 100, what: 'upper deadzone', why: 'percent' },
    { arg: 5, min: -32, max: 32, what: 'curve', why: 'target.tmh documents curve = -32..32' },
  ],
  SetJCurve: [
    { arg: 2, min: 0, max: 100, what: 'in', why: 'percent' },
    { arg: 3, min: 0, max: 100, what: 'out', why: 'percent' },
  ],
  LEDV: [
    { arg: 1, min: 0, max: 31, what: 'led_index', why: 'LEDV masks the index with & 0x1f' },
    { arg: 2, min: 0, max: 7, what: 'value', why: 'LEDV masks the value with & 7' },
  ],
  LEDRGB: [
    { arg: 2, min: 0, max: 255, what: 'red', why: 'declared as byte' },
    { arg: 3, min: 0, max: 255, what: 'green', why: 'declared as byte' },
    { arg: 4, min: 0, max: 255, what: 'blue', why: 'declared as byte' },
  ],
};

/**
 * Operators a C programmer reaches for that TARGET's parser rejects outright.
 * Every entry was confirmed against the real compiler rather than inferred.
 *
 * `&&` is deliberately absent: in TARGET it is address-of-address (`&&tmp` appears
 * throughout target.tmh), not logical and. `&` and `|` serve as the logical
 * operators, and both are accepted.
 */
const REJECTED_OPERATORS: Record<string, string> = {
  '++': 'TARGET has no `++`. Write `i = i + 1`.',
  '--': 'TARGET has no `--`. Write `i = i - 1`.',
  '+=': 'TARGET has no compound assignment. Write `x = x + y`.',
  '-=': 'TARGET has no compound assignment. Write `x = x - y`.',
  '*=': 'TARGET has no compound assignment. Write `x = x * y`.',
  '/=': 'TARGET has no compound assignment. Write `x = x / y`.',
  '%=': 'TARGET has no compound assignment. Write `x = x % y`.',
  '&=': 'TARGET has no compound assignment. Write `x = x & y`.',
  '|=': 'TARGET has no compound assignment. Write `x = x | y`.',
  '^=': 'TARGET has no compound assignment. Write `x = x ^ y`.',
  '<<=': 'TARGET has no compound assignment. Write `x = x << y`.',
  '>>=': 'TARGET has no compound assignment. Write `x = x >> y`.',
  '||': 'TARGET has no `||`. Use `|`, which TARGET uses for logical or.',
  '?': 'TARGET has no ternary `? :`. Use `if` / `else`.',
};

/** Multi-character operators TARGET does accept, so they are stepped over intact. */
const VALID_OPERATORS = ['<<', '>>', '==', '!=', '<=', '>=', '&&'];

/** Keywords that parse as a call because they are followed by a parenthesis. */
const CONTROL_WORDS = new Set(['if', 'while', 'do', 'else', 'return', 'switch', 'for', 'goto', 'break', 'sizeof']);

const intLiteral = (s: string): number | null => {
  const t = s.trim();
  if (/^-?\d+$/.test(t)) return parseInt(t, 10);
  if (/^0[xX][0-9A-Fa-f]+$/.test(t)) return parseInt(t, 16);
  return null;
};

export interface DiagnosticOptions {
  /**
   * Device handles bound by the script, gathered across the include graph.
   * Without this, a script that maps through its own alias cannot be checked at all.
   */
  aliasBindings?: Map<string, Set<string>>;
  /**
   * Every name declared anywhere in the include graph.
   *
   * The TARGET compiler resolves symbols lazily: a call to a function that does not
   * exist compiles perfectly and fails only when that line is reached at runtime. So
   * knowing what is declared is the only way to catch a typo before the hardware is
   * live.
   */
  knownSymbols?: Set<string>;
  /**
   * True when this document is a `.tmc` entry script - the unit the compiler actually
   * sees. A header opened on its own has no includes of its own, so its closure is
   * structurally incomplete however well it resolves.
   */
  isEntryScript?: boolean;
  /**
   * Names declared anywhere in the PROJECT, resolved from the entry script. Headers are
   * judged against this rather than their own closure, which they routinely outgrow.
   */
  projectSymbols?: Set<string>;
  projectComplete?: boolean;
  /**
   * Whether the game binds a chord: true, false, or null when nothing can be said.
   *
   * Off unless the user asks for it, because the answer depends on machine-local state -
   * which preset the game has loaded, and which .binds files happen to be on this disk.
   * A clone of the same project on another machine would light up differently, and a
   * script written for one stick while another preset is loaded would light up almost
   * everywhere.
   */
  isChordBound?: (usbCode: string, modifiers: string[]) => boolean | null;
  /**
   * True only when every `include` in the graph was resolved. When a file could not
   * be found, the symbol table is incomplete and the checks that rely on it are
   * skipped rather than reporting names that are declared in a file we cannot see.
   */
  closureComplete?: boolean;
  /**
   * Problems found in the include graph, which needs file access and so is computed
   * by the caller. Each is anchored on the matching `include` statement when one is
   * present in this document.
   */
  includeProblems?: { includePath: string | null; message: string; code: string; severity: Severity }[];
  /** Names declared in more than one file of the include graph. */
  duplicateSymbols?: Map<string, string[]>;
}

export function computeDiagnostics(
  model: DocModel,
  fileName: string,
  opts: DiagnosticOptions = {}
): RawDiagnostic[] {
  const out: RawDiagnostic[] = [];

  const add = (start: number, end: number, message: string, severity: Severity, code: string) => {
    out.push({ start, end, message, severity, code });
  };

  // ---- words TARGET does not have -------------------------------------------
  for (const t of model.tokens) {
    if (t.kind !== TokKind.Ident) continue;
    const why = own(NOT_IN_TARGET, t.value);
    if (why) add(t.start, t.end, why, 'error', 'not-in-target');
  }

  // ---- operators and directives TARGET's parser rejects ---------------------
  checkRejectedSyntax();
  checkDirectXButtonCeiling();
  checkRejectedDeclarations();

  // ---- include "target.tmh" must come first ---------------------------------
  if (fileName.toLowerCase().endsWith('.tmc')) {
    const first = model.includes[0];
    if (!first) {
      add(0, 0, 'A TARGET script must begin with `include "target.tmh"`.', 'warning', 'missing-target-include');
    } else if (first.path.toLowerCase() !== 'target.tmh') {
      add(
        first.start,
        first.end,
        '`include "target.tmh"` must be the first include: it declares every builtin and must load before anything that uses them.',
        'warning',
        'target-include-order'
      );
    }
  }

  // ---- the include graph -----------------------------------------------------
  for (const p of opts.includeProblems ?? []) {
    const anchor = p.includePath
      ? model.includes.find((i) => i.path.toLowerCase() === p.includePath!.toLowerCase())
      : undefined;
    add(anchor?.start ?? 0, anchor?.end ?? 0, p.message, p.severity, p.code);
  }

  // A name declared in two files of the graph is compiled twice. Anchored on the
  // declaration in this document, which is the one the user can act on.
  if (opts.duplicateSymbols?.size) {
    const here = path.basename(fileName);
    for (const d of model.decls) {
      if (!d.global) continue;
      const others = opts.duplicateSymbols.get(d.name);
      if (!others) continue;
      const elsewhere = others.filter((f) => f.toLowerCase() !== here.toLowerCase());
      if (elsewhere.length === 0) continue;
      add(
        d.start,
        d.end,
        `${d.name} is also declared in ${elsewhere.join(', ')}. TARGET compiles every included file once and rejects a second declaration with "Name already defined: ${d.name}".`,
        'error',
        'duplicate-symbol'
      );
    }
  }

  // ---- structure a runnable script must have --------------------------------
  // None of this is enforced by the TARGET compiler, which only reports syntax
  // errors. A script missing main() compiles and then does nothing at all.
  // The caller decides what an entry script is, because the filename cannot: real
  // projects use .tmc for library files too, and one that another script includes needs
  // no main() of its own. The filename is only the fallback for callers that say nothing.
  const looksLikeEntry = opts.isEntryScript ?? fileName.toLowerCase().endsWith('.tmc');
  if (looksLikeEntry) checkEntryScriptStructure();

  for (const call of model.allCalls) {
    checkCall(call);
  }

  /**
   * Declaration-level constructs the TARGET parser rejects, each confirmed by
   * compiling it. None is reported before build time, and a C or C++ habit produces
   * every one of them.
   */
  function checkRejectedDeclarations(): void {
    const sig = model.tokens.filter((t) => t.kind !== TokKind.Comment);

    for (let i = 0; i < sig.length; i++) {
      const t = sig[i];
      if (t.kind !== TokKind.Ident) continue;

      // define NAME(a,b) - TARGET has object-like macros only. `define X (1+2)` is
      // fine, so the two are told apart by whether the parenthesis touches the name.
      if (t.value === 'define') {
        const name = sig[i + 1];
        const paren = sig[i + 2];
        // What the compiler actually rejects is *using* a macro with arguments, not
        // writing '(' next to the name: `define FOO(1+2)` compiles and works, with or
        // without a space. So the parameter list is what identifies a function-like
        // macro - a comma-separated list of bare identifiers - and the declaration is
        // accepted, failing only at the point of use.
        if (name?.kind === TokKind.Ident && paren?.kind === TokKind.Punct && paren.value === '(' && name.end === paren.start) {
          const close = sig.findIndex((x, k) => k > i + 2 && x.kind === TokKind.Punct && x.value === ')');
          const inner = close > i + 2 ? sig.slice(i + 3, close) : [];
          // At least one comma. With a single token there is nothing to distinguish a
          // parameter list from a parenthesised body, and `define ZOOM(DX5)` - an
          // ordinary object-like macro that compiles - matched the looser test.
          const looksParameterised =
            inner.length >= 3 &&
            inner.some((x) => x.kind === TokKind.Punct && x.value === ',') &&
            inner.every((x, k) => (k % 2 === 0 ? x.kind === TokKind.Ident : x.kind === TokKind.Punct && x.value === ','));
          if (looksParameterised) {
            add(
              t.start,
              paren.end,
              `TARGET has no function-like macros. The compiler accepts this declaration but rejects any use of \`${name.value}(...)\` with arguments. Use a function instead.`,
              'warning',
              'not-in-target'
            );
          }
        }
        continue;
      }

      // `return;` - TARGET requires a value.
      if (t.value === 'return') {
        const next = sig[i + 1];
        if (next?.kind === TokKind.Punct && next.value === ';') {
          add(
            t.start,
            next.end,
            'TARGET requires a value: `return;` is a syntax error. Write `return 0;`.',
            'error',
            'not-in-target'
          );
        }
      }
    }

    // A name the runtime already owns cannot be *declared* again.
    //
    // `define` is exempt: it is a text substitution in its own namespace and may
    // legally shadow a builtin. The test corpus relies on this - it carries
    // `define SET 1` while target.tmh declares `int SET(int i)`, and compiles.
    for (const d of model.decls) {
      if (!d.global || d.kind === 'define') continue;
      const kind = functionsByName.has(d.name)
        ? 'a builtin function'
        : devicesByAlias.has(d.name)
          ? 'a device alias'
          : constantsByName.has(d.name)
            ? 'a builtin constant'
            : null;
      if (!kind) continue;
      add(
        d.start,
        d.end,
        `${d.name} is already ${kind} declared by target.tmh. The compiler rejects this with "Name already defined: ${d.name}".`,
        'error',
        'redefines-builtin'
      );
    }

    // An executable statement at file scope. Declarations are fine; a bare call is
    // not, and the compiler reports only "Type required".
    const fnRanges = model.decls
      .filter((d) => d.kind === 'function')
      .map((d) => [d.fullStart, d.fullEnd] as const);
    const insideFunction = (o: number) => fnRanges.some(([a, b]) => o >= a && o <= b);
    const posOf = new Map(sig.map((t, i) => [t.start, i]));
    const inInitialiser = (o: number) => model.initialiserSpans.some(([a, b]) => o >= a && o <= b);
    for (const call of model.allCalls) {
      if (insideFunction(call.nameStart)) continue;
      // A declaration's initialiser is not a statement, however it is wrapped. The
      // newline rule below treats a fresh line as a statement boundary, which is right
      // for `include "x.tmh"` but wrong for `int q =\n    fn(1);`.
      if (inInitialiser(call.nameStart)) continue;
      // Only a call that *starts* a statement: `int g = fn();` is a declaration.
      const idx = posOf.get(call.nameStart);
      const prev = idx !== undefined && idx > 0 ? sig[idx - 1] : null;
      // A new line also starts a statement: `include "x.tmh"` has no semicolon, so the
      // token before a following call is the include's string literal.
      const startsStatement =
        !prev ||
        (prev.kind === TokKind.Punct && [';', '}', '{'].includes(prev.value)) ||
        model.text.slice(prev.end, call.nameStart).includes('\n');
      if (!startsStatement) continue;
      add(
        call.nameStart,
        call.close === -1 ? call.nameEnd : call.close,
        'Statements must live inside a function. At file scope the compiler expects a declaration and reports only "Type required". Move this call into main() or another function.',
        'error',
        'statement-at-file-scope'
      );
    }
  }

  /**
   * Two separate facts about DX button numbers, from two different sources.
   *
   * 1. What TARGET declares. Measured by running a script that creates only a virtual
   *    joystick and reading the resulting device's HID capabilities live
   *    (HidP_GetCaps / HidP_GetButtonCaps on HID\THRUSTMASTERGAMEDEVICE):
   *
   *      usagePage=0x01 usage=0x04 (Joystick)   inputReport=33 bytes
   *      button caps: page=0x09 usage 1..120    value caps: 9
   *
   *    120 buttons, and the report length corroborates it: 1 report id + 15 bytes of
   *    button bits (120) + 8 axes at 16 bits + 1 byte of hat = 33. The 9 value caps
   *    are those 8 axes plus the hat, matching the eight DX_*_AXIS constants exactly.
   *
   *    defines.tmh nevertheless names DX1..DX128, so DX121..DX128 are names with no
   *    button behind them. Those can never work, whatever the game.
   *
   * 2. What a game reads. DirectInput defines two joystick data formats and the game
   *    chooses: c_dfDIJoystick gives DIJOYSTATE with BYTE rgbButtons[32];
   *    c_dfDIJoystick2 gives DIJOYSTATE2 with BYTE rgbButtons[128]. So a button above
   *    32 reaches a game reading the second and is invisible to one reading the first.
   *    Elite Dangerous reads 32.
   *
   * Hence a warning above 120, where nothing exists to send, and a hint between 33 and
   * 120, where it depends on the game. Neither is ever an error: exceeding either limit
   * is silent, never a failure the script can see.
   */
  function checkDirectXButtonCeiling(): void {
    const reported = new Set<string>();
    for (const t of model.tokens) {
      if (t.kind !== TokKind.Ident) continue;
      const m = /^DX(\d+)$/.exec(t.value);
      if (!m) continue;
      const n = parseInt(m[1], 10);
      if (n <= 32 || reported.has(t.value)) continue;
      reported.add(t.value);

      if (n > 120) {
        add(
          t.start,
          t.end,
          `${t.value} has no button behind it. TARGET's virtual controller declares 120 buttons (HID usage 1..120), so although defines.tmh names DX1..DX128, anything above DX120 is never sent to any game.`,
          'warning',
          'directx-button-ceiling'
        );
        continue;
      }

      add(
        t.start,
        t.end,
        `${t.value} is above DX32. TARGET's virtual controller does declare it - it offers 120 buttons - but whether the game reads it depends on the DirectInput data format that game requests: DIJOYSTATE (c_dfDIJoystick) carries 32 buttons, DIJOYSTATE2 (c_dfDIJoystick2) carries 128. Elite Dangerous reads 32. A button past the game's limit is silently never reported.`,
        'info',
        'directx-button-ceiling'
      );
    }
  }

  /**
   * Flags C syntax the TARGET parser refuses. Operators are rebuilt from adjacent
   * punctuation tokens, and only when the characters actually touch: `a & &b` is
   * two operators, `a && b` is one. Comments and strings never reach here, so a
   * `//-----` banner or a `||||||` divider cannot be mistaken for code.
   */
  function checkRejectedSyntax(): void {
    const toks = model.tokens.filter((t) => t.kind !== TokKind.Comment);

    /**
     * Whether `++` or `--` here is two signs rather than an increment.
     *
     * `L_CTL++USB[0x09]` is a modifier flag plus a unary-plus scancode, and the
     * compiler accepts it - verified. Real scripts in the wild write it that way. An
     * increment has an operand on exactly one side; a sign run has operands on both.
     */
    const isSignRun = (op: string, at: number): boolean => {
      if (op !== '++' && op !== '--') return false;
      const operand = (t?: Token) =>
        !!t && (t.kind === TokKind.Ident || t.kind === TokKind.Number || (t.kind === TokKind.Punct && t.value === '('));
      const before = toks[at - 1];
      const after = toks[at + 2];
      const leftIsOperand = !!before && (before.kind === TokKind.Ident || before.kind === TokKind.Number);
      return leftIsOperand && operand(after);
    };
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];

      // `#include` / `#define`: TARGET's directives carry no '#'.
      if (t.kind === TokKind.Punct && t.value === '#') {
        const next = toks[i + 1];
        if (next?.kind === TokKind.Ident && (next.value === 'include' || next.value === 'define')) {
          add(
            t.start,
            next.end,
            `TARGET has no preprocessor. Write \`${next.value}\` without the '#'.`,
            'error',
            'not-in-target'
          );
          i++;
          continue;
        }
      }

      // `include <file>`: TARGET takes a quoted filename only.
      if (t.kind === TokKind.Ident && t.value === 'include') {
        const next = toks[i + 1];
        if (next?.kind === TokKind.Punct && next.value === '<') {
          add(
            t.start,
            next.end,
            'TARGET includes take a quoted filename: `include "file.tmh"`. Angle brackets are not supported, and there is no C standard library to include.',
            'error',
            'not-in-target'
          );
          continue;
        }
      }

      if (t.kind !== TokKind.Punct) continue;

      // Longest match first, so `<<=` is not read as a valid `<<`.
      const joined = (n: number): string | null => {
        let out = t.value;
        for (let k = 1; k < n; k++) {
          const prev = toks[i + k - 1];
          const cur = toks[i + k];
          if (!cur || cur.kind !== TokKind.Punct || prev.end !== cur.start) return null;
          out += cur.value;
        }
        return out;
      };

      const three = joined(3);
      const threeMsg = three ? own(REJECTED_OPERATORS, three) : undefined;
      if (three && threeMsg) {
        add(t.start, toks[i + 2].end, threeMsg, 'error', 'not-in-target');
        i += 2;
        continue;
      }
      const two = joined(2);
      const twoMsg = two ? own(REJECTED_OPERATORS, two) : undefined;
      if (two && twoMsg && !isSignRun(two, i)) {
        add(t.start, toks[i + 1].end, twoMsg, 'error', 'not-in-target');
        i += 1;
        continue;
      }
      if (two && VALID_OPERATORS.includes(two)) {
        i += 1;
        continue;
      }
      const oneMsg = own(REJECTED_OPERATORS, t.value);
      if (oneMsg) {
        add(t.start, t.end, oneMsg, 'error', 'not-in-target');
      }
    }
  }

  /**
   * Calls made between two offsets, i.e. within one function body.
   * A function declaration, not a const arrow: it is used by the structural checks
   * that run above this point.
   */
  function callsWithin(start: number, end: number, name: string): CallNode[] {
    return model.allCalls.filter((c) => c.name === name && c.nameStart >= start && c.nameStart <= end);
  }

  function checkEntryScriptStructure(): void {
    const known = opts.knownSymbols;
    const localFn = (n: string) => model.decls.find((d) => d.kind === 'function' && d.name === n);
    const declaredAnywhere = (n: string) => (known ? known.has(n) : !!localFn(n));

    const main = localFn('main');
    if (!main) {
      // main() could legitimately live in an included header, so only speak up when
      // the symbol table says it exists nowhere.
      if (!declaredAnywhere('main')) {
        add(
          0,
          0,
          'This script has no main(). TARGET runs main() when the script starts, so without it nothing happens. The TARGET compiler does not report this.',
          'error',
          'missing-main'
        );
      }
      return;
    }

    const initCalls = callsWithin(main.fullStart, main.fullEnd, 'Init');
    if (initCalls.length === 0) {
      add(
        main.start,
        main.end,
        'main() never calls Init(). Init() selects the physical devices and creates the virtual ones; without it no mapping takes effect.',
        'warning',
        'missing-init'
      );
      return;
    }

    const handlerArg = initCalls[0].args[0]?.text ?? '';
    const m = handlerArg.match(/^&\s*([A-Za-z_]\w*)$/);
    if (!m) return;
    const handlerName = m[1];

    if (!declaredAnywhere(handlerName)) {
      // Only trustworthy once every include resolved, or the handler is simply in a
      // file this could not read.
      if (opts.closureComplete !== false) {
        add(
          initCalls[0].args[0].start,
          initCalls[0].args[0].end,
          `Init() is given the event handler ${handlerName}, which is not defined anywhere. The compiler accepts this and the script fails at runtime with "Symbol not found: ${handlerName}".`,
          'error',
          'undefined-event-handler'
        );
      }
      return;
    }

    // The handler must pass events on, or layers, shift states and axis handling
    // silently stop working. Only checkable when the handler is in this file.
    const handler = localFn(handlerName);
    if (handler && callsWithin(handler.fullStart, handler.fullEnd, 'DefaultMapping').length === 0) {
      add(
        handler.start,
        handler.end,
        `${handlerName}() does not call DefaultMapping(&o, x). Without it TARGET never applies your mappings, and shift layers stop working.`,
        'warning',
        'handler-missing-defaultmapping'
      );
    }
  }

  // ---- calls to functions that do not exist ---------------------------------
  // Worth checking precisely because the compiler will not: the failure surfaces at
  // runtime, mid-flight, as a cryptic "Symbol not found".
  // Only for an entry script. A project is one .tmc including N headers that do not
  // include each other, so a header analysed alone is missing the rest of the project
  // and every call into it looks undefined - 39 false positives on the known-good
  // corpus. closureComplete does not catch this: a header with no includes trivially
  // has nothing that failed to resolve.
  if (opts.knownSymbols && opts.closureComplete && opts.isEntryScript) {
    const known = opts.knownSymbols;
    const reported = new Set<string>();
    for (const call of model.allCalls) {
      const n = call.name;
      if (reported.has(n)) continue;
      if (functionsByName.has(n) || constantsByName.has(n) || devicesByAlias.has(n)) continue;
      if (known.has(n)) continue;
      // Control-flow keywords parse as calls: `if(x)`, `while(x)`.
      if (CONTROL_WORDS.has(n)) continue;
      reported.add(n);
      add(
        call.nameStart,
        call.nameEnd,
        `${n}() is not defined in this script or any file it includes. The TARGET compiler does not check this; it fails at runtime with "Symbol not found: ${n}".`,
        'warning',
        'unknown-function'
      );
    }

  }

  // ---- a key the game does nothing with -----------------------------------
  if (opts.isChordBound) {
    const seen = new Set<string>();
    for (const t of model.tokens) {
      if (t.kind !== TokKind.Ident || t.value !== 'USB') continue;
      const m = /^USB\s*\[\s*0[xX]([0-9A-Fa-f]+)\s*\]/.exec(model.text.slice(t.start));
      if (!m) continue;
      const end = t.start + m[0].length;
      const code = normalizeUsbCode(m[1]);
      const lineStart = model.text.lastIndexOf('\n', t.start) + 1;
      const chord = parseChord(model.text.slice(lineStart, t.start));
      // An unrecognised term means the chord is not known, so it cannot be called
      // unbound; that case has its own report.
      if (chord.unknown.length) continue;
      const bound = opts.isChordBound(code, chord.modifiers);
      if (bound !== false) continue;
      // The key by name where the table knows it; the hex alone reads as a riddle.
      const named = usbKeyName(code);
      const label = [...chord.modifiers, named ? shortKeyName(named) : `0x${code}`].join(' + ');
      if (seen.has(label + lineStart)) continue;
      seen.add(label + lineStart);
      // Underline the whole chord. Marking only the scancode pointed at half of what is
      // wrong, and the modifier is the half more likely to be the mistake. The caveat
      // about which preset is loaded lives in the setting's own description rather than
      // being repeated on every one of these.
      add(
        t.start - chord.length,
        end,
        `Nothing in the game's loaded bindings uses ${label}.`,
        'info',
        'unbound-key'
      );
    }
  }

  // ---- a name used in a define's value that nothing declares ---------------
  // Gated on the PROJECT table, not this file's own: a header legitimately uses names
  // its includer defined first, so judging it alone invents errors in working code.
  const projectKnown = opts.projectSymbols;
  if (projectKnown && opts.projectComplete) {
  // `define CameraPreset1  L+CTL+USB[0x1E]` compiles clean even when the define is
  // used - verified against Interpreter.exe - because the compiler resolves symbols
  // lazily and never checks. So this is not redundant with the build: it is the only
  // place a typo of this shape can be caught at all. Scoped to define VALUES, where a
  // bare undeclared word is always wrong; elsewhere it would need full scope
  // tracking for locals and parameters.
  for (const d of model.decls) {
    if (d.kind !== 'define' || !d.value) continue;
    const base = model.text.indexOf(d.value, d.end);
    if (base === -1) continue;
    for (const t of lex(d.value)) {
      if (t.kind !== TokKind.Ident) continue;
      const id = d.value.slice(t.start, t.end);
      if (projectKnown.has(id) || functionsByName.has(id) || constantsByName.has(id) || devicesByAlias.has(id)) continue;
      if (id === 'USB' || CONTROL_WORDS.has(id)) continue;
      if (own(SCRIPT_MODIFIERS, id) || SCRIPT_STATE_FLAGS.has(id)) continue;
      add(
        base + t.start,
        base + t.end,
        `${id} is not defined in this script or any file it includes, so ${d.name} does not send what it looks like it sends. The TARGET compiler does not check this.`,
        'warning',
        'unknown-identifier'
      );
    }
  }
  }
  function checkCall(call: CallNode): void {
    const fn = functionsByName.get(call.name);

    // ---- arity ---------------------------------------------------------------
    if (fn && call.close !== -1) {
      const n = call.args.filter((a, i) => a.text !== '' || i < call.args.length - 1).length;
      const given = call.args.length === 1 && call.args[0].text === '' ? 0 : n;
      if (given < fn.minArgs) {
        add(
          call.nameStart,
          call.close,
          `${fn.name} needs at least ${fn.minArgs} argument${fn.minArgs === 1 ? '' : 's'}, got ${given}.\n${fn.signature}`,
          'error',
          'arity'
        );
      } else if (given > fn.maxArgs && fn.maxArgs > 0) {
        add(
          call.nameStart,
          call.close,
          `${fn.name} takes at most ${fn.maxArgs} argument${fn.maxArgs === 1 ? '' : 's'}, got ${given}.\n${fn.signature}`,
          'error',
          'arity'
        );
      }
    }

    // ---- constructs forbidden inside EXEC / REXEC ----------------------------
    if (call.name === 'EXEC' || call.name === 'REXEC') {
      // EXEC's code is its first argument; REXEC's is its third.
      // EXEC(alias cmdon, int cmdoff) carries code in BOTH arguments - the shipped
      // DCS FC2 A-10A.tmc uses that form - so only checking the first under-reported.
      const codeArgIndexes = call.name === 'EXEC' ? [0, 1] : [2];
      for (const i of codeArgIndexes) {
        const arg = call.args[i];
        if (arg) checkExecBody(arg.start, arg.end, call.name);
      }
    }

    // ---- REXEC handle must be 0..99 -----------------------------------------
    if (call.name === 'REXEC' && call.args[0]) {
      const h = intLiteral(call.args[0].text);
      // A warning, not an error. The manual documents 0-99, but Interpreter.exe accepts
      // any value - verified up to 65536 - and published DCS profiles use 100 and 101
      // in scripts that work. A negative handle is still reported as an error: there is
      // no reading under which that is intended.
      if (h !== null && (h < 0 || h > 99)) {
        add(
          call.args[0].start,
          call.args[0].end,
          h < 0
            ? `REXEC handle cannot be negative, got ${h}.`
            : `The manual documents REXEC handles as 0-99, and this is ${h}. The compiler accepts it and scripts in the wild use higher handles, so this is a note rather than an error.`,
          h < 0 ? 'error' : 'warning',
          'rexec-handle'
        );
      }
    }

    // ---- AXMAP2: one event per zone -----------------------------------------
    // Only under the name AXMAP2. `define LIST AXMAP2` makes them the same variadic,
    // but LIST is called with coordinate pairs for SetCustomCurve - position, value,
    // position, value - where the first argument is an axis position, not a zone
    // count. Checking LIST reported valid curves as errors.
    if (call.name === 'AXMAP2') {
      const zones = call.args[0] ? intLiteral(call.args[0].text) : null;
      const events = call.args.length - 1;
      if (zones !== null && zones > 0 && call.close !== -1 && events !== zones) {
        add(
          call.nameStart,
          call.close,
          `${call.name} declares ${zones} zone${zones === 1 ? '' : 's'} but supplies ${events} event${events === 1 ? '' : 's'}. They must match.`,
          'error',
          'axmap2-zones'
        );
      }
    }

    // ---- AXMAP1: the center event needs an even zone count -------------------
    if (call.name === 'AXMAP1' && call.args.length >= 4) {
      const zones = intLiteral(call.args[0].text);
      if (zones !== null && zones % 2 === 1) {
        add(
          call.args[3].start,
          call.args[3].end,
          `AXMAP1 ignores the center event when the zone count is odd (${zones}): with an odd number of equal divisions no zone boundary lands on center. Use an even zone count.`,
          'warning',
          'axmap1-center'
        );
      }
    }

    // ---- CHAIN without delays -----------------------------------------------
    if (call.name === 'CHAIN' && call.close !== -1) {
      const hasDelay = call.children.some((c) => c.name === 'D');
      const keystrokes = call.args.filter((a) => a.text && !/^D\s*\(/.test(a.text)).length;
      if (!hasDelay && keystrokes > 5) {
        add(
          call.nameStart,
          call.close,
          `CHAIN sends ${keystrokes} keystrokes with no D() delay. Windows silently drops keystrokes past roughly five sent back to back; insert D() between them.`,
          'warning',
          'chain-no-delay'
        );
      }
    }

    // ---- numeric ranges ------------------------------------------------------
    for (const rule of own(RANGE_RULES, call.name) ?? []) {
      const arg = call.args[rule.arg];
      if (!arg) continue;
      const v = intLiteral(arg.text);
      if (v === null || (v >= rule.min && v <= rule.max)) continue;
      add(
        arg.start,
        arg.end,
        `${call.name}: ${rule.what} must be ${rule.min}..${rule.max}, got ${v} (${rule.why}).`,
        'warning',
        'range'
      );
    }
    if (call.name === 'TrimDXAxis' && call.args[1]) {
      const v = intLiteral(call.args[1].text);
      if (v !== null && Math.abs(v) > 1023) {
        add(
          call.args[1].start,
          call.args[1].end,
          `TrimDXAxis takes a relative trim of -1023..1023 (1024 steps), got ${v}. Larger values are only meaningful combined with CURRENT.`,
          'warning',
          'range'
        );
      }
    }

    // ---- button named on the wrong device ------------------------------------
    checkDeviceControl(call);
  }

  /**
   * Catches a control named for the wrong device, e.g. `MapKey(&T16000, TG1, ...)`
   * where TG1 is a Warthog name.
   *
   * Control names are just integer constants, so a name from another device still
   * works whenever the index happens to coincide - TG1 and TS1 are both 0, and real
   * scripts do rely on that. Those cases are reported as a hint about clarity, not as
   * a defect; only an index the device has no control at is a genuine warning.
   */
  function checkDeviceControl(call: CallNode): void {
    const fn = functionsByName.get(call.name);
    if (!fn || fn.params[0]?.type !== 'alias' || call.args.length < 2) return;

    const devMatch = call.args[0].text.match(/^&\s*([A-Za-z_]\w*)$/);
    if (!devMatch) return;

    const candidates = resolveDevices(devMatch[1]);
    if (candidates.length === 0) return;

    const ctrlArg = call.args[1];
    if (!/^[A-Za-z_]\w*$/.test(ctrlArg.text)) return;
    const name = ctrlArg.text;

    // Only a name that is a control on some device carries information here. Anything
    // else is a user define or variable this cannot see, and must not be guessed at.
    const owners = controlOwners.get(name);
    if (!owners) return;
    // Valid under any branch the handle can take: nothing to say.
    if (candidates.some((d) => d.controlsByName.has(name))) return;

    const constValue = constantsByName.get(name)?.value ?? null;
    const sameIndexOn = candidates
      .map((d) => ({ dev: d, alt: constValue === null ? undefined : d.controlsByValue.get(constValue) }))
      .filter((x) => x.alt);

    const handle = devMatch[1];
    const via = handle === candidates[0].alias ? '' : ` (${handle} is bound to ${candidates.map((d) => d.alias).join(' / ')})`;

    if (sameIndexOn.length === candidates.length && sameIndexOn.length > 0) {
      const first = sameIndexOn[0];
      add(
        ctrlArg.start,
        ctrlArg.end,
        `${name} is a ${[...owners][0]} control name, but index ${constValue} on ${first.dev.alias} is ${first.alt!.name}. This works, since both resolve to the same index - using ${first.alt!.name} would say what is meant${via}.`,
        'info',
        'control-name-mismatch'
      );
      return;
    }

    const unusable = candidates.filter((d) => constValue === null || !d.controlsByValue.has(constValue));
    if (unusable.length === candidates.length) {
      add(
        ctrlArg.start,
        ctrlArg.end,
        `${name} is not a control on ${candidates.map((d) => `${d.alias} (${d.label})`).join(' or ')}${via}. It belongs to ${[...owners].slice(0, 3).join(', ')}${owners.size > 3 ? ', \u2026' : ''}.`,
        'warning',
        'wrong-device-control'
      );
    }
  }

  /**
   * Devices a first-argument handle can refer to: itself, or whatever it is bound to.
   * An empty answer means the handle could not be pinned down, and the checks that use
   * it stay quiet rather than guess.
   */
  function resolveDevices(handle: string): ResolvedDevice[] {
    return devicesForHandle(handle, opts.aliasBindings).map(resolved);
  }

  /**
   * The manual forbids SEQ, CHAIN, EXEC, REXEC, TEMPO, AXIS and LIST inside an
   * EXEC/REXEC argument, and SetCustomCurve too: the argument is compiled on its own
   * and cannot build nested event structures. The workaround is a named function.
   */
  function checkExecBody(argStart: number, argEnd: number, outer: string): void {
    const raw = model.text.slice(argStart, argEnd);
    if (!raw.includes('"')) return;

    // Walk the argument's string literals, skipping escaped quotes so that an inner
    // \"...\" literal's contents are not mistaken for code.
    let i = 0;
    while (i < raw.length) {
      if (raw[i] !== '"') {
        i++;
        continue;
      }
      const contentStart = i + 1;
      let j = contentStart;
      while (j < raw.length && raw[j] !== '"') {
        if (raw[j] === '\\') j++;
        j++;
      }
      const body = raw.slice(contentStart, j);
      scanExecCode(body, argStart + contentStart, outer);
      i = j + 1;
    }
  }

  function scanExecCode(body: string, baseOffset: number, outer: string): void {
    // Blank out nested \"...\" literals so identifiers inside them are not scanned.
    const masked = body.replace(/\\"(?:\\.|[^"\\])*\\"/g, (m) => ' '.repeat(m.length));
    const toks = lex(masked);
    for (let k = 0; k < toks.length; k++) {
      const t = toks[k];
      if (t.kind !== TokKind.Ident) continue;
      const next = toks[k + 1];
      if (!next || next.kind !== TokKind.Punct || next.value !== '(') continue;
      if (DISPUTED_IN_EXEC.has(t.value)) {
        add(
          baseOffset + t.start,
          baseOffset + t.end,
          `The manual says ${t.value}() cannot be used inside ${outer}(), but Thrustmaster's own sample scripts do exactly this and it compiles. If it does not behave, move it into a named function and call that from ${outer}().`,
          'info',
          'disputed-in-exec'
        );
        continue;
      }
      if (!FORBIDDEN_IN_EXEC.has(t.value)) continue;
      add(
        baseOffset + t.start,
        baseOffset + t.end,
        `${t.value}() cannot be used inside ${outer}(). Move it into a named function and call that function from ${outer}() instead.`,
        'error',
        'forbidden-in-exec'
      );
    }
  }

  return out;
}
