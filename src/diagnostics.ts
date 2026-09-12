// Diagnostics for the sharp edges the TARGET compiler reports poorly or not at all.
//
// Every rule here is grounded in something checkable: a signature or a masking
// expression in target.tmh, or a restriction the manual states outright. Rules that
// would need guesswork are left out rather than shipped with false positives.

import { DocModel, CallNode } from './model';
import { TokKind, lex } from './lexer';
import {
  functionsByName,
  constantsByName,
  devicesByAlias,
  devices,
  NOT_IN_TARGET,
  FORBIDDEN_IN_EXEC,
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

const resolvedCache = new Map<string, ResolvedDevice | null>();

function lookupDevice(aliasOrUsb: string): ResolvedDevice | null {
  if (resolvedCache.has(aliasOrUsb)) return resolvedCache.get(aliasOrUsb)!;
  let dev = devicesByAlias.get(aliasOrUsb);
  if (!dev && aliasOrUsb.startsWith('usb:')) {
    const usb = aliasOrUsb.slice(4).toLowerCase();
    dev = devices.find((d) => d.usb.toLowerCase() === usb);
  }
  if (!dev || (dev.buttons.length === 0 && dev.axes.length === 0)) {
    resolvedCache.set(aliasOrUsb, null);
    return null;
  }
  const controls = [...dev.buttons, ...dev.axes, ...dev.hats];
  const r: ResolvedDevice = {
    alias: dev.alias,
    label: dev.label,
    controlsByName: new Map(controls.map((c) => [c.name, c])),
    controlsByValue: new Map(),
  };
  // First name wins, so the device's own primary name is reported rather than a synonym.
  for (const c of controls) if (!r.controlsByValue.has(c.value)) r.controlsByValue.set(c.value, c);
  resolvedCache.set(aliasOrUsb, r);
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
    const why = NOT_IN_TARGET[t.value];
    if (why) add(t.start, t.end, why, 'error', 'not-in-target');
  }

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

  for (const call of model.allCalls) {
    checkCall(call);
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
      const codeArgIndex = call.name === 'EXEC' ? 0 : 2;
      const arg = call.args[codeArgIndex];
      if (arg) checkExecBody(arg.start, arg.end, call.name);
    }

    // ---- REXEC handle must be 0..99 -----------------------------------------
    if (call.name === 'REXEC' && call.args[0]) {
      const h = intLiteral(call.args[0].text);
      if (h !== null && (h < 0 || h > 99)) {
        add(
          call.args[0].start,
          call.args[0].end,
          `REXEC handle must be 0-99, got ${h}.`,
          'error',
          'rexec-handle'
        );
      }
    }

    // ---- AXMAP2: one event per zone -----------------------------------------
    if (call.name === 'AXMAP2' || call.name === 'LIST') {
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
    for (const rule of RANGE_RULES[call.name] ?? []) {
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

  /** Devices a first-argument handle can refer to: itself, or whatever it is bound to. */
  function resolveDevices(handle: string): ResolvedDevice[] {
    const direct = lookupDevice(handle);
    if (direct) return [direct];

    const bound = opts.aliasBindings?.get(handle);
    if (!bound) return [];
    const out: ResolvedDevice[] = [];
    for (const b of bound) {
      const d = lookupDevice(b);
      // An unresolvable binding (a generic handle such as joy0) means the handle may
      // point at hardware not described here, so stay quiet rather than guess.
      if (!d) return [];
      out.push(d);
    }
    return out;
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
