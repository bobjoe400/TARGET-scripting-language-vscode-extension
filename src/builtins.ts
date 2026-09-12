// Typed access to the tables generated from the TARGET headers.
// Regenerate with `npm run gen`; never edit src/data/builtins.json by hand.

import raw from './data/builtins.json';
import * as manualDocs from './data/manual-docs.json';
import rawLabels from './data/device-labels.json';
import rawUsb from './data/usb-codes.json';

export interface BuiltinParam {
  name: string;
  type: string | null;
  default: string | null;
}

export interface BuiltinFunction {
  name: string;
  returnType: string;
  params: BuiltinParam[];
  signature: string;
  minArgs: number;
  maxArgs: number;
  doc: string;
  internal: boolean;
  source: string;
}

export interface BuiltinConstant {
  name: string;
  value: string;
  doc: string;
  category: string;
  source: string;
}

export interface DeviceControl {
  name: string;
  value: string;
  kind: 'button' | 'axis' | 'hat';
  doc: string;
  inherited: boolean;
}

export interface Device {
  alias: string;
  label: string;
  usb: string;
  section: string | null;
  buttons: DeviceControl[];
  axes: DeviceControl[];
  hats: DeviceControl[];
  note?: string | null;
}

const data = raw as unknown as {
  $generated: { from: string; at: string; files: { name: string; mtime: string }[] };
  keywords: string[];
  notKeywords: string[];
  functions: BuiltinFunction[];
  constants: BuiltinConstant[];
  devices: Device[];
};

export const generated = data.$generated;
export const keywords = data.keywords;
export const functions = data.functions;
export const constants = data.constants;
export const devices = data.devices;

export const functionsByName = new Map(functions.map((f) => [f.name, f]));
export const constantsByName = new Map(constants.map((c) => [c.name, c]));
export const devicesByAlias = new Map(devices.map((d) => [d.alias, d]));

/**
 * Plain-English descriptions of physical controls, taken from the per-device PDFs
 * TARGET installs. Nobody remembers that EFLNORM is the left engine fuel-flow switch.
 * Only devices whose diagram carries per-control prose are covered.
 */
const labelData = rawLabels as unknown as {
  labels: Record<string, Record<string, string>>;
  defaults: Record<string, Record<string, number>>;
};

/** One control's entry in a per-device table, or undefined where there is none. */
function perDevice<T>(
  table: Record<string, Record<string, T>> | undefined,
  deviceAlias: string,
  control: string
): T | undefined {
  const forDevice = own(table ?? {}, deviceAlias);
  return forDevice ? own(forDevice, control) : undefined;
}

/** The first device whose table describes this control. */
function anyDevice<T>(
  table: Record<string, Record<string, T>> | undefined,
  control: string
): { value: T; device: string } | null {
  for (const [device, map] of Object.entries(table ?? {})) {
    const hit = own(map, control);
    if (hit !== undefined) return { value: hit, device };
  }
  return null;
}

/**
 * The DirectX button a control sends with no script running - the device's
 * out-of-the-box mapping, printed on the per-device diagrams. Worth knowing when a
 * script means to preserve a default, or when working out what a game binding used to
 * refer to.
 */
export function defaultDxButton(deviceAlias: string, control: string): number | null {
  return perDevice(labelData.defaults, deviceAlias, control) ?? null;
}

export function anyDefaultDxButton(control: string): { dx: number; device: string } | null {
  const hit = anyDevice(labelData.defaults, control);
  return hit ? { dx: hit.value, device: hit.device } : null;
}

export function controlLabel(deviceAlias: string, control: string): string | null {
  return perDevice(labelData.labels, deviceAlias, control) ?? null;
}

/**
 * Key names for USB[0xNN]. Neither target.tmh nor defines.tmh carries these - the
 * header only declares `short USB[256]` - so without them a script reads as a wall of
 * opaque hex. They come from the manual's appendix.
 */
const usbData = rawUsb as unknown as { codes: Record<string, string> };

/**
 * A scancode written in a script, in the form the table and the binds index are keyed
 * by: upper case, two digits, no leading zeroes beyond that.
 *
 * Strip leading zeroes BEFORE padding: USB[0x004] is the same key as USB[0x04], and
 * padding without trimming produced '004', which matches nothing. An `0x` prefix is
 * tolerated so callers may pass either the whole literal or just its digits.
 */
export function normalizeUsbCode(hex: string): string {
  return hex.toUpperCase().replace(/^0X/, '').replace(/^0+(?=.)/, '').padStart(2, '0');
}

export function usbKeyName(hex: string): string | null {
  return own(usbData.codes, normalizeUsbCode(hex)) ?? null;
}

export function allUsbCodes(): { hex: string; name: string }[] {
  return Object.entries(usbData.codes).map(([hex, name]) => ({ hex, name }));
}

/**
 * The two halves of a USB table name that lists a key by both its cases - "u U",
 * "1 !" - or null for a name that is not of that shape. The notation means unshifted
 * and shifted, so both halves name the same key; "Keypad *" is a name in its own right
 * and is not split.
 */
export function usbNamePair(name: string): [string, string] | null {
  const parts = name.split(/\s+/);
  return parts.length === 2 && parts.every((p) => p.length <= 2) ? [parts[0], parts[1]] : null;
}

/**
 * The USB table names a key by both its cases - "u U", "s S" - which is the table's
 * notation for unshifted and shifted, not the key's name. Showing both reads as a
 * stutter, so the pair collapses to the first, which is the key.
 */
export function shortKeyName(name: string): string {
  return usbNamePair(name)?.[0] ?? name;
}

/** Any description for a control name, whichever device it belongs to. */
export function anyControlLabel(control: string): { label: string; device: string } | null {
  const hit = anyDevice(labelData.labels, control);
  return hit ? { label: hit.value, device: hit.device } : null;
}

/** Words a C programmer reaches for that TARGET does not have. */
/**
 * Looks a user-supplied identifier up in a plain object safely.
 *
 * These tables are indexed by names taken straight from the source, so without a
 * guard `toString`, `constructor` and `__proto__` reach Object.prototype and return
 * a function. That escapes `?? []` and throws out of computeDiagnostics, which runs
 * during activate() - taking the command registrations down with it.
 */
export function own<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

export const NOT_IN_TARGET: Record<string, string> = {
  for: 'TARGET has no `for` loop. Use `while` or `do ... while`.',
  switch: 'TARGET has no `switch`. Use `if` / `else if`.',
  case: 'TARGET has no `switch`/`case`. Use `if` / `else if`.',
  continue: 'TARGET has no `continue`.',
  typedef: 'TARGET has no `typedef`.',
  enum: 'TARGET has no `enum`. Use `define`.',
  const: 'TARGET has no `const`. Use `define`.',
  static: 'TARGET has no `static`.',
  unsigned: 'TARGET has no `unsigned`. Use `byte`, `word` or `int`.',
  signed: 'TARGET has no `signed`.',
};

/**
 * Constructs forbidden inside an EXEC/REXEC argument.
 *
 * The manual enumerates them exactly: "using SEQ, CHAIN, EXEC, TEMPO, AXIS, LIST
 * inside an EXEC is forbidden. This limit can be overcome by creating a function which
 * contains the SEQ, CHAIN, EXEC, TEMPO, AXIS, LIST and calls up that function in the
 * EXEC statement." SetCustomCurve is documented separately, but see DISPUTED_IN_EXEC.
 *
 * REXEC is deliberately absent. It is not in the manual's list, and the manual shows
 * EXEC("StopAutoRepeat(4);") as the supported way to interact with a running REXEC, so
 * flagging it would be asserting a restriction nothing supports.
 */
export const FORBIDDEN_IN_EXEC = new Set(['SEQ', 'CHAIN', 'EXEC', 'TEMPO', 'AXIS']);

/**
 * Documented as forbidden inside EXEC, but contradicted by Thrustmaster's own code.
 *
 * The manual states plainly: "a SetCustomCurve Statement cannot be used in an EXEC
 * function." Yet DCS BlackShark.tmc, DCS FC2 A-10A.tmc and DCS FC2 Mig29.tmc - all
 * shipped in the TARGET install - do exactly that, and those samples are what users
 * copy. Compile acceptance settles nothing either way, since SEQ inside EXEC also
 * compiles and is genuinely forbidden; the restriction is a runtime one and needs
 * hardware to test. So this is a hint naming the disagreement, not an error on code
 * that ships with the product.
 *
 * LIST joined it for the same reason from the other direction: the manual lists it as
 * forbidden, the compiler accepts it, and TarodBOFH's published Elite Dangerous macros
 * use it inside EXEC fourteen times in a script that builds.
 */
export const DISPUTED_IN_EXEC = new Set(['SetCustomCurve', 'LIST']);

/**
 * The set of values an argument can sensibly take.
 *
 * Without this, every argument offers all 1049 symbols - so writing the third argument
 * of MapKey suggests OSB01, QT_BTN1 and SOL_B5, none of which belong to the device in
 * hand or even to that position. Each entry below is grounded in the declaration in
 * target.tmh and the constants defined beside it.
 */
export type ArgDomain =
  | { kind: 'constants'; names: string[]; title: string }
  | { kind: 'event'; title: string }
  | null;

/** Constant families, each named by the prefix its members share. */
const family = (prefix: string) => constants.filter((c) => c.name.startsWith(prefix)).map((c) => c.name);

/**
 * The axes of the virtual devices, which several arguments take in place of a physical
 * device axis. Named once: MapAxis's third argument and the DXAxis family's index
 * argument mean exactly the same thing.
 */
const dxAxisDomain = (): ArgDomain => ({
  kind: 'constants',
  names: constants.filter((c) => /_AXIS$/.test(c.name) && /^(DX|MOUSE)_/.test(c.name)).map((c) => c.name),
  title: 'DirectX axis',
});

/** Everything that can stand as the event a button fires. */
// LIST is absent deliberately: `define LIST AXMAP2` makes it a define rather than a
// function, so it is offered through the constant list below instead. Including it
// here meant it was looked up as a function, not found, and silently dropped.
const EVENT_FUNCTIONS = ['SEQ', 'CHAIN', 'TEMPO', 'EXEC', 'REXEC', 'D', 'LOCK', 'AXIS', 'AXMAP1', 'AXMAP2', 'X'];
const EVENT_FLAGS = [
  'PULSE', 'DOWN', 'UP', 'KEYON', 'LOCK', 'RNOSTOP', 'DELAY', 'JUMP', 'PROC',
  'L_SHIFT', 'R_SHIFT', 'L_ALT', 'R_ALT', 'L_CTL', 'R_CTL', 'L_WIN', 'R_WIN',
];

export function eventDomainNames(): { functions: string[]; constants: string[] } {
  const keyboard = constants.filter((c) => c.category === 'Virtual keyboard interface').map((c) => c.name);
  const dx = constants.filter((c) => c.category === 'virtual joystick interface' || c.category === 'virtual mouse interface').map((c) => c.name);
  return {
    functions: EVENT_FUNCTIONS,
    constants: [...new Set([...EVENT_FLAGS, ...dx, ...keyboard, 'USB', 'LIST'])],
  };
}

/**
 * Which domain an argument belongs to, by function and position.
 * Positions are 0-based and match the declarations in target.tmh.
 */
export function argumentDomain(fnName: string, index: number): ArgDomain {
  const key = `${fnName}:${index}`;
  switch (key) {
    // int Configure(alias a, int mode)
    case 'Configure:1':
      return { kind: 'constants', names: family('MODE_'), title: 'device mode' };
    // int Init(alias h, int cfg = CREATE_JOYSTICK+CREATE_KEYBOARD+CREATE_MOUSE)
    case 'Init:1':
      return { kind: 'constants', names: family('CREATE_'), title: 'virtual devices to create' };
    // int MapAxis(alias o, int x, int dx, int dir = AXIS_NORMAL, int relative = MAP_ABSOLUTE)
    case 'MapAxis:2':
      return dxAxisDomain();
    case 'MapAxis:3':
      return { kind: 'constants', names: family('AXIS_'), title: 'axis direction' };
    case 'MapAxis:4':
      // Named explicitly: MAP_* also covers sys.tmh's MAP_IPTR and MAP_THISCALL, which
      // belong to Map() and have nothing to do with axes.
      return { kind: 'constants', names: ['MAP_ABSOLUTE', 'MAP_RELATIVE'], title: 'absolute or relative' };
    // int SetKBLayout(int layout)
    case 'SetKBLayout:0':
      return { kind: 'constants', names: family('KB_'), title: 'keyboard layout' };
    // int LED(alias dev, int mode, int led)
    case 'LED:1':
      return { kind: 'constants', names: ['LED_ONOFF', 'LED_INTENSITY'], title: 'LED mode' };
    case 'LED:2':
      // family('LED') already contains LED_CURRENT, so the explicit one was a duplicate.
      return {
        kind: 'constants',
        names: [...new Set([...family('LED'), 'LED_CURRENT'])].filter((n) => /^LED\d|LED_CURRENT/.test(n)),
        title: 'which LED',
      };
    // Axis index arguments, which take a DirectX axis rather than a device axis.
    case 'DXAxis:0':
    case 'DXSetAxis:0':
    case 'TrimDXAxis:0':
    case 'LockDXAxis:0':
    case 'RotateDXAxis:0':
    case 'RotateDXAxis:1':
      return dxAxisDomain();
    default:
      break;
  }

  // The event argument of the MapKey family: everything a button can fire.
  if (/^MapKey/.test(fnName) && index >= 2) return { kind: 'event', title: 'event' };
  if (fnName === 'ActKey' && index === 0) return { kind: 'event', title: 'event' };
  return null;
}

/**
 * Explains a layer parameter of the MapKey family.
 *
 * The headers name these `keyIU`, `keyOM`, `keyID` and so on, which says nothing
 * unless you already know the scheme. From the manual: the main layers are Up, Middle
 * and Down, selected by a three-position switch, and "by default, you program the
 * Middle layer". Each has an In/Out sub-layer, "traditionally used as a momentary
 * layer, activated from a button used as a kind of Shift" - the one named by
 * SetShiftButton.
 */
/**
 * Builtins whose first argument is a device.
 *
 * `alias` is not the signal: target.tmh also declares strings, code fragments and
 * variable references that way, so 57 builtins have an alias first parameter while
 * only 25 take a device. Testing the type alone made `Init(&`, `EXEC("`, `strlen(`
 * and `fopen(` all offer 38 joystick names and suppress everything else - including
 * `EventHandle`, which is what `Init(&` actually wants.
 *
 * The parameter *name* is the reliable signal, and it comes from the header: device
 * parameters are named dev, o, a or id; the others are h, cmdon, handle_func, s, var,
 * dst, name and so on.
 */
const DEVICE_PARAM_NAMES = new Set(['dev', 'o', 'a', 'id']);

/**
 * Every device a `&handle` argument could refer to: the handle itself when it names a
 * device, otherwise whatever the script bound it to.
 *
 * Two rules that both callers need, and which used to exist in only one of the two
 * copies of this:
 *
 * - A handle may be written as `usb:VID_044F&PID_0402` rather than as an alias, and
 *   that still names a specific device.
 * - If ANY binding cannot be resolved the answer is nothing at all, not the subset that
 *   could be. A handle bound to both a known stick and a generic `joy0` may be either,
 *   so narrowing to the known one offers a control list missing everything valid on the
 *   other. An empty answer is what both callers want here - diagnostics skip the check,
 *   completion stops narrowing and offers the full list.
 *
 * A device describing no controls resolves to nothing for the same reason: it cannot
 * narrow anything, and pretending otherwise would offer an empty list.
 */
export function deviceByHandleName(name: string): Device | undefined {
  const direct = devicesByAlias.get(name);
  const dev =
    direct ??
    (name.startsWith('usb:')
      ? devices.find((d) => d.usb.toLowerCase() === name.slice(4).toLowerCase())
      : undefined);
  if (!dev) return undefined;
  return dev.buttons.length === 0 && dev.axes.length === 0 ? undefined : dev;
}

export function devicesForHandle(handle: string, bindings?: Map<string, Set<string>>): Device[] {
  const direct = deviceByHandleName(handle);
  if (direct) return [direct];
  const bound = bindings?.get(handle);
  if (!bound) return [];
  const out: Device[] = [];
  for (const b of bound) {
    const d = deviceByHandleName(b);
    if (!d) return [];
    out.push(d);
  }
  return out;
}

export function takesDeviceFirst(fnName: string): boolean {
  const f = functionsByName.get(fnName);
  return !!f && f.params[0]?.type === 'alias' && DEVICE_PARAM_NAMES.has(f.params[0].name);
}

export function describeParam(fnName: string, paramName: string): string | null {
  const SHIFT_IN = 'shift button held';
  const SHIFT_OUT = 'shift button not held';
  const MAIN: Record<string, string> = {
    U: 'Up layer',
    M: 'Middle layer (the default)',
    D: 'Down layer',
  };

  const m = /^key([IO])?([UMD])?$/.exec(paramName);
  if (m && (m[1] || m[2])) {
    const io = m[1] ? `In (${SHIFT_IN})` : '';
    const ioOut = m[1] === 'O' ? `Out (${SHIFT_OUT})` : io;
    const parts = [m[1] ? (m[1] === 'I' ? `In (${SHIFT_IN})` : ioOut) : '', m[2] ? MAIN[m[2]] : ''].filter(Boolean);
    return parts.join(' \u00b7 ');
  }

  if (fnName === 'SetShiftButton') {
    switch (paramName) {
      case 'devI':
        return 'Device carrying the In/Out shift button.';
      case 'indexI':
        return 'Button that selects the In sub-layer. Momentary unless IOTOGGLE is set.';
      case 'devUMD':
        return 'Device carrying the Up/Down layer switch.';
      case 'indexU':
        return 'Button that selects the Up layer. Middle is the layer when neither is held.';
      case 'indexD':
        return 'Button that selects the Down layer.';
      case 'flag':
        return 'IOTOGGLE and/or UDTOGGLE to make those layers latch instead of being momentary.';
      default:
        return null;
    }
  }

  if (paramName === 'layer' && fnName.startsWith('MapKey')) {
    return "Layer bits, as a character constant such as 'i', 'o' or 'iu'.";
  }
  return null;
}

/**
 * Builtins that take any number of arguments.
 *
 * The headers cannot express it - they are declared `int SEQ(){...}` and mapped as
 * variadic at runtime - so the generated table records minArgs 0, maxArgs 0. Reporting
 * that as fact told the reader that SEQ, the most idiomatic construct in the language,
 * takes no arguments. The arity check already skips them via `maxArgs > 0`.
 */
export const VARIADIC = new Set(['SEQ', 'CHAIN', 'AXMAP2', 'LIST', 'printf', 'sprintf']);

/**
 * What a variadic builtin actually takes, since its declaration cannot say.
 *
 * `int printf(){}` in sys.tmh is the whole declaration - the body is empty and the
 * host binds it at load time - so the generated table is honest but useless: it shows
 * a function taking nothing, next to scripts calling it with a format string and three
 * arguments.
 *
 * These are cint's implementations, and the shapes below are what 236 published scripts
 * actually use: %d 351 times, %s 177, %i 28, %u 6, and %0.2f / %0.3f for floats. The
 * newline is worth stating outright - TARGET scripts write `\x0a`, and `\n` appears in
 * none of them.
 */
export const VARIADIC_DOCS: Record<string, { args: string; doc: string }> = {
  printf: {
    args: 'alias fmt, ...',
    doc:
      'Prints to the TARGET event log. Takes a C format string followed by one argument ' +
      'per specifier: `%d` or `%i` for an int, `%u` unsigned, `%s` for a string, `%f` for ' +
      'a float (`%0.2f` to set the precision).\n\nWrite a newline as `\\x0a` — TARGET ' +
      'scripts use the hex escape, not `\\n`.',
  },
  sprintf: {
    args: 'alias dst, alias fmt, ...',
    doc:
      'Formats into a string rather than printing it. Same specifiers as `printf`, with ' +
      'the destination first.',
  },
  SEQ: { args: '...', doc: 'Each press runs the next argument in turn, wrapping at the end.' },
  CHAIN: { args: '...', doc: 'Runs its arguments one after another on a single press.' },
  LIST: { args: '...', doc: 'A list of values, used by the axis-mapping functions.' },
  AXMAP2: { args: '...', doc: 'Zone boundaries followed by the event for each zone.' },
};

/**
 * The signature to show. For a variadic builtin the declared one reads `int printf()`,
 * which says the opposite of the truth, so the real argument shape replaces it - in the
 * completion list and signature help as well as the hover, or they disagree.
 */
export function functionSignature(f: BuiltinFunction): string {
  const extra = own(VARIADIC_DOCS, f.name);
  return extra ? f.signature.replace(/\(\s*\)/, `(${extra.args})`) : f.signature;
}

/**
 * @param withSignature false for a completion item, whose `detail` already shows the
 *   signature - VS Code renders detail above the documentation, so including it here
 *   too printed `int printf(alias fmt, ...)` twice in the same panel.
 */
/**
 * The Script Editor manual's description of a builtin, where it has one.
 *
 * Extracted by tools/gen-manual-docs.mjs, conservatively: 12 of the 171 builtins, ten
 * of which the headers do not comment at all. The manual is prose written for a reader,
 * not a reference, so most functions simply are not described in it.
 */
export function manualDoc(name: string): string | undefined {
  return own((manualDocs as { docs: Record<string, string> }).docs, name);
}

export function describeFunction(f: BuiltinFunction, withSignature = true): string {
  const extra = own(VARIADIC_DOCS, f.name);
  const parts = withSignature ? ['```c', functionSignature(f), '```'] : [];
  if (extra) parts.push('', extra.doc);
  if (f.doc) parts.push('', f.doc);
  // The manual's own words, attributed. Shown alongside a header comment rather than
  // instead of it: the two answer different questions, and the header's is often a
  // note about the parameters - SetJCurve's is "in, out = percents" - while the manual
  // says what the function is for.
  const fromManual = manualDoc(f.name);
  if (fromManual) parts.push('', `${f.name} ${fromManual}`, '', '*\u2014 TARGET Script Editor manual*');
  // What each parameter means, and what it accepts. The values come from the constants
  // table - the same domain the completion list narrows to - so a function with no
  // comment anywhere in the headers still says something true about its arguments.
  // 96 of the 171 builtins carry no documentation at all: the headers do not comment
  // them, and the manual's PDF text is too interleaved to extract prose from safely.
  const described = f.params.map((p, i) => {
    const bits: string[] = [];
    const d = describeParam(f.name, p.name);
    if (d) bits.push(d);
    const domain = argumentDomain(f.name, i);
    // Only a short, closed list. An event argument accepts most of the language, and
    // printing that would bury the parameter it is meant to explain.
    if (domain && domain.kind === 'constants' && domain.names.length && domain.names.length <= 10) {
      bits.push(`${domain.title}: ${domain.names.map((n) => `\`${n}\``).join(', ')}`);
    }
    return { p, text: bits.join(' \u2014 ') };
  }).filter((x) => x.text);
  if (described.length) {
    parts.push('', ...described.map((x) => `- \`${x.p.name}\` \u2014 ${x.text}`));
  }
  if (VARIADIC.has(f.name)) {
    parts.push('', `*Takes any number of arguments · declared in \`${f.source}\`*`);
    return parts.join('\n');
  }
  const arity = f.minArgs === f.maxArgs ? `${f.minArgs}` : `${f.minArgs}–${f.maxArgs}`;
  parts.push('', `*${arity} argument${f.maxArgs === 1 ? '' : 's'} · declared in \`${f.source}\`*`);
  return parts.join('\n');
}

export function describeConstant(c: BuiltinConstant): string {
  const parts = ['```c', `define ${c.name} ${c.value}`, '```'];
  if (c.doc) parts.push('', c.doc);
  parts.push('', `*${c.category} · \`${c.source}\`*`);
  return parts.join('\n');
}

export function describeDevice(d: Device): string {
  const parts = ['```c', `alias ${d.alias} = "${d.usb}";`, '```', '', `**${d.label}**`];
  if (d.buttons.length || d.axes.length) {
    parts.push('', `${d.buttons.length} buttons, ${d.axes.length} axes${d.hats.length ? `, ${d.hats.length} hat` : ''}`);
  }
  if (d.note) parts.push('', `*${d.note}*`);
  return parts.join('\n');
}
