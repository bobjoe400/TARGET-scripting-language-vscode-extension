// Typed access to the tables generated from the TARGET headers.
// Regenerate with `npm run gen`; never edit src/data/builtins.json by hand.

import raw from './data/builtins.json';

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
 * Constructs the manual forbids inside EXEC/REXEC, because the argument is compiled
 * separately and these build event structures that cannot be nested there.
 */
export const FORBIDDEN_IN_EXEC = new Set(['SEQ', 'CHAIN', 'EXEC', 'REXEC', 'TEMPO', 'AXIS', 'LIST', 'SetCustomCurve']);

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

export function describeFunction(f: BuiltinFunction): string {
  const parts = ['```c', f.signature, '```'];
  if (f.doc) parts.push('', f.doc);
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
