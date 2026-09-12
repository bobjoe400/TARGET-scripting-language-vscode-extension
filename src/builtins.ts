// Typed access to the tables generated from the TARGET headers.
// Regenerate with `npm run gen`; never edit src/data/builtins.json by hand.

import raw from './data/builtins.json';
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

/**
 * The DirectX button a control sends with no script running - the device's
 * out-of-the-box mapping, printed on the per-device diagrams. Worth knowing when a
 * script means to preserve a default, or when working out what a game binding used to
 * refer to.
 */
export function defaultDxButton(deviceAlias: string, control: string): number | null {
  return labelData.defaults?.[deviceAlias]?.[control] ?? null;
}

export function anyDefaultDxButton(control: string): { dx: number; device: string } | null {
  for (const [device, map] of Object.entries(labelData.defaults ?? {})) {
    if (map[control] !== undefined) return { dx: map[control], device };
  }
  return null;
}

export function controlLabel(deviceAlias: string, control: string): string | null {
  return labelData.labels?.[deviceAlias]?.[control] ?? null;
}

/**
 * Key names for USB[0xNN]. Neither target.tmh nor defines.tmh carries these - the
 * header only declares `short USB[256]` - so without them a script reads as a wall of
 * opaque hex. They come from the manual's appendix.
 */
const usbData = rawUsb as unknown as { codes: Record<string, string> };

export function usbKeyName(hex: string): string | null {
  return usbData.codes[hex.toUpperCase().replace(/^0X/, '').padStart(2, '0')] ?? null;
}

export function allUsbCodes(): { hex: string; name: string }[] {
  return Object.entries(usbData.codes).map(([hex, name]) => ({ hex, name }));
}

/** Any description for a control name, whichever device it belongs to. */
export function anyControlLabel(control: string): { label: string; device: string } | null {
  for (const [device, map] of Object.entries(labelData.labels ?? {})) {
    if (map[control]) return { label: map[control], device };
  }
  return null;
}

/** Words a C programmer reaches for that TARGET does not have. */
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
 * EXEC statement." SetCustomCurve is documented separately with the same restriction.
 *
 * REXEC is deliberately absent. It is not in the manual's list, and the manual shows
 * EXEC("StopAutoRepeat(4);") as the supported way to interact with a running REXEC, so
 * flagging it would be asserting a restriction nothing supports.
 */
export const FORBIDDEN_IN_EXEC = new Set(['SEQ', 'CHAIN', 'EXEC', 'TEMPO', 'AXIS', 'LIST', 'SetCustomCurve']);

/** Which builtins take a device alias as their first argument. */
export const DEVICE_FIRST_ARG = new Set(
  functions.filter((f) => f.params[0]?.type === 'alias' && /^(dev|o|a|h)$/.test(f.params[0].name)).map((f) => f.name)
);

/** Builtins whose second argument names a button or axis on that device. */
export const BUTTON_SECOND_ARG = new Set(
  functions
    .filter((f) => f.params[0]?.type === 'alias' && /^(btnidx)$/.test(f.params[1]?.name ?? ''))
    .map((f) => f.name)
);

export const AXIS_SECOND_ARG = new Set(
  functions
    .filter((f) => f.params[0]?.type === 'alias' && f.params[1]?.name === 'x' && /Axis|Curve/.test(f.name))
    .map((f) => f.name)
);

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

/** Everything that can stand as the event a button fires. */
const EVENT_FUNCTIONS = ['SEQ', 'CHAIN', 'TEMPO', 'EXEC', 'REXEC', 'D', 'LOCK', 'AXIS', 'LIST', 'AXMAP1', 'AXMAP2', 'X'];
const EVENT_FLAGS = [
  'PULSE', 'DOWN', 'UP', 'KEYON', 'LOCK', 'RNOSTOP', 'DELAY', 'JUMP', 'PROC',
  'L_SHIFT', 'R_SHIFT', 'L_ALT', 'R_ALT', 'L_CTL', 'R_CTL', 'L_WIN', 'R_WIN',
];

export function eventDomainNames(): { functions: string[]; constants: string[] } {
  const keyboard = constants.filter((c) => c.category === 'Virtual keyboard interface').map((c) => c.name);
  const dx = constants.filter((c) => c.category === 'virtual joystick interface' || c.category === 'virtual mouse interface').map((c) => c.name);
  return {
    functions: EVENT_FUNCTIONS,
    constants: [...new Set([...EVENT_FLAGS, ...dx, ...keyboard, 'USB'])],
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
      return { kind: 'constants', names: constants.filter((c) => /_AXIS$/.test(c.name) && /^(DX|MOUSE)_/.test(c.name)).map((c) => c.name), title: 'DirectX axis' };
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
      return { kind: 'constants', names: [...family('LED'), 'LED_CURRENT'].filter((n) => /^LED\d|LED_CURRENT/.test(n)), title: 'which LED' };
    // Axis index arguments, which take a DirectX axis rather than a device axis.
    case 'DXAxis:0':
    case 'DXSetAxis:0':
    case 'TrimDXAxis:0':
    case 'LockDXAxis:0':
    case 'RotateDXAxis:0':
    case 'RotateDXAxis:1':
      return { kind: 'constants', names: constants.filter((c) => /_AXIS$/.test(c.name) && /^(DX|MOUSE)_/.test(c.name)).map((c) => c.name), title: 'DirectX axis' };
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

export function describeFunction(f: BuiltinFunction): string {
  const parts = ['```c', f.signature, '```'];
  if (f.doc) parts.push('', f.doc);
  const layered = f.params
    .map((p) => ({ p, d: describeParam(f.name, p.name) }))
    .filter((x) => x.d);
  if (layered.length) {
    parts.push('', ...layered.map((x) => `- \`${x.p.name}\` \u2014 ${x.d}`));
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
