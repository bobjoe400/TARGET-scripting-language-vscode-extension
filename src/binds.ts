// Reading Elite Dangerous binding files (.binds).
//
// A TARGET script sends keystrokes; the game decides what they do. That mapping lives
// in the game's .binds file and nowhere in the script, so `USB[0x18]` gives no hint
// that it deploys hardpoints. Indexing the binds by key answers that.
//
// The lookup is deliberately key-first rather than name-first. Script authors name
// their defines however they like - of 200 defines in the test corpus only 15 match a
// game action name, and the game calls "deploy hardpoints" DeployHardpointToggle -
// so matching by name would be mostly wrong. Keys are unambiguous.

import * as fs from 'fs';
import * as path from 'path';
import { readTextFile } from './encoding';
import { own, usbKeyName } from './builtins';

export interface BindingRef {
  action: string;
  /** Primary or Secondary, as the game calls its two slots. */
  slot: string;
  /** The game's own key name, e.g. Key_U. */
  key: string;
  modifiers: string[];
  file: string;
}

export interface BindsIndex {
  /** USB HID code (uppercase hex, 2 digits) -> the actions bound to that key. */
  byUsbCode: Map<string, BindingRef[]>;
  actions: string[];
  files: string[];
  /** The preset the game will actually load, if it could be determined. */
  activePreset: string | null;
}

/**
 * The preset Elite Dangerous will actually load.
 *
 * The game records it in StartPreset.start next to the binding files - one preset name
 * per line, because the bindings are split into groups that can each come from a
 * different preset. Later game versions use a numbered name (StartPreset.4.start) and
 * ignore the unnumbered one, so the highest number wins.
 *
 * This matters more than it looks. A Bindings folder accumulates every preset the
 * player has ever tried, plus the community ones shipped beside a script, and they all
 * bind the same keys to different things. Without this, a hover is a pile of
 * contradictory answers from files the game is not reading.
 */
export function activePresetNames(dir: string): string[] {
  let best: { version: number; file: string } | null = null;
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  for (const name of entries) {
    // z_StartPreset.start and friends are the game's own disabled copies.
    const m = /^StartPreset(?:\.(\d+))?\.start$/i.exec(name);
    if (!m) continue;
    const version = m[1] ? Number(m[1]) : 0;
    if (!best || version > best.version) best = { version, file: path.join(dir, name) };
  }
  if (!best) return [];
  const text = readTextFile(best.file);
  if (text === null) return [];
  const names = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return [...new Set(names)];
}

/** Whether a .binds filename belongs to the named preset. */
export function fileMatchesPreset(file: string, preset: string): boolean {
  // Clicker-ENHANCED_Warthog.4.2.binds belongs to preset Clicker-ENHANCED_Warthog.
  const base = path.basename(file).replace(/\.binds$/i, '');
  return base === preset || new RegExp(`^${preset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\.[\\d.]+)?$`).test(base);
}

/**
 * Elite Dangerous key names that do not simply match a name in the manual's table.
 * Each is a plain equivalence: the game's word for a key, and the character or name
 * the USB table uses for it.
 */
const ED_KEY_ALIASES: Record<string, string> = {
  Equals: '=',
  Minus: '-',
  Period: '.',
  Comma: ',',
  SemiColon: ';',
  Apostrophe: "'",
  Grave: '`',
  Slash: '/',
  BackSlash: '\\',
  LeftBracket: '[',
  RightBracket: ']',
  Enter: 'Return',
  Escape: 'Escape',
  Backspace: 'Backspace',
  CapsLock: 'Caps Lock',
  NumLock: 'Num Lock',
  ScrollLock: 'Scroll Lock',
  PageUp: 'Page Up',
  PageDown: 'Page Down',
  UpArrow: 'Up Arrow',
  DownArrow: 'Down Arrow',
  LeftArrow: 'Left Arrow',
  RightArrow: 'Right Arrow',
  PrintScreen: 'Print Screen',
  Apps: 'Application',
  Numpad_Divide: 'Keypad /',
  Numpad_Multiply: 'Keypad *',
  Numpad_Subtract: 'Keypad -',
  Numpad_Add: 'Keypad +',
  Numpad_Decimal: 'Keypad . Delete',
  Numpad_Enter: 'Keypad Enter',
};

/** Modifier keys, which TARGET expresses as flags rather than scancodes. */
export const ED_MODIFIERS: Record<string, string> = {
  LeftShift: 'L_SHIFT',
  RightShift: 'R_SHIFT',
  LeftControl: 'L_CTL',
  RightControl: 'R_CTL',
  LeftAlt: 'L_ALT',
  RightAlt: 'R_ALT',
  LeftWin: 'L_WIN',
  RightWin: 'R_WIN',
};

/** All USB codes, indexed by their exact name and by each alternative in it. */
let nameIndex: Map<string, string> | null = null;
function usbNameIndex(): Map<string, string> {
  if (nameIndex) return nameIndex;
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, '');
  const m = new Map<string, string>();
  for (let code = 0; code <= 0xff; code++) {
    const hex = code.toString(16).toUpperCase().padStart(2, '0');
    const name = usbKeyName(hex);
    if (!name) continue;
    // The exact name wins, and is registered first so it is never displaced.
    if (!m.has(norm(name))) m.set(norm(name), hex);
    // "a A" and "1 !" list a key and its shifted form; both name the same key. Only
    // whole alternatives are registered - indexing every word would let "Home" match
    // "Keypad 7 Home", which is a different key.
    const parts = name.split(/\s+/);
    if (parts.length === 2 && parts[0].length <= 2 && parts[1].length <= 2) {
      for (const p of parts) if (!m.has(norm(p))) m.set(norm(p), hex);
    }
  }
  nameIndex = m;
  return m;
}

/** The USB HID code for an Elite Dangerous key name, or null if it is not a key. */
export function usbCodeForEdKey(edKey: string): string | null {
  const bare = edKey.replace(/^Key_/, '');
  if (own(ED_MODIFIERS, bare)) return null; // a modifier, not a scancode
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, '');
  const index = usbNameIndex();

  const candidates = [
    own(ED_KEY_ALIASES, bare),
    bare,
    bare.replace(/^Numpad_/, 'Keypad '),
    bare.replace(/_/g, ' '),
  ].filter(Boolean) as string[];

  for (const c of candidates) {
    const hit = index.get(norm(c));
    if (hit) return hit;
  }
  // "Keypad 7 Home" and friends carry the digit plus its secondary function.
  const numpad = /^Numpad_(\d)$/.exec(bare);
  if (numpad) {
    for (const [name, hex] of index) {
      if (name.startsWith(`keypad${numpad[1]}`)) return hex;
    }
  }
  return null;
}

/** Parses one .binds file into its action bindings. */
export function parseBinds(file: string): BindingRef[] {
  // Through the same BOM sniffing as every other read: this was the one place that
  // assumed UTF-8, and Windows tools write UTF-16 often enough to matter.
  const xml = readTextFile(file);
  if (xml === null) return [];
  const out: BindingRef[] = [];
  const base = path.basename(file);
  // <ActionName> ... <Primary Device="Keyboard" Key="Key_U"><Modifier .../></Primary>
  for (const block of xml.matchAll(/<([A-Za-z_][\w]*)>([\s\S]*?)<\/\1>/g)) {
    const action = block[1];
    const body = block[2];
    // Either self-closing, or an element whose body carries the modifier keys. The
    // closing tag must not be optional: with a lazy body and an optional close, the
    // body matches empty and every modifier is lost.
    for (const slot of body.matchAll(
      /<(Primary|Secondary)\s+(?=[^>]*Device="Keyboard")(?=[^>]*Key="(Key_[A-Za-z0-9_]+)")[^>]*?(?:\/>|>([\s\S]*?)<\/\1>)/g
    )) {
      const modifiers: string[] = [];
      for (const mod of (slot[3] ?? '').matchAll(/<Modifier\s+(?=[^>]*Device="Keyboard")[^>]*Key="Key_([A-Za-z0-9_]+)"/g)) {
        const flag = own(ED_MODIFIERS, mod[1]);
        if (flag) modifiers.push(flag);
      }
      out.push({ action, slot: slot[1], key: slot[2], modifiers, file: base });
    }
  }
  return out;
}

/** Builds a key-indexed view of every binding in the given files. */
export function buildBindsIndex(files: string[], activePreset: string | null = null): BindsIndex {
  const byUsbCode = new Map<string, BindingRef[]>();
  const actions = new Set<string>();
  const used: string[] = [];
  for (const file of files) {
    const refs = parseBinds(file);
    if (refs.length) used.push(file);
    for (const ref of refs) {
      actions.add(ref.action);
      const hex = usbCodeForEdKey(ref.key);
      if (!hex) continue;
      if (!byUsbCode.has(hex)) byUsbCode.set(hex, []);
      byUsbCode.get(hex)!.push(ref);
    }
  }
  // The same preset is routinely present twice - the copy shipped beside a script and
  // the one installed in the game's folder - and identical entries from two paths are
  // one fact, not two. Dedupe on what the binding actually says.
  for (const [hex, refs] of byUsbCode) {
    const seen = new Set<string>();
    const unique: BindingRef[] = [];
    for (const r of refs) {
      const key = `${r.action}\u0000${r.slot}\u0000${r.modifiers.join('+')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(r);
    }
    byUsbCode.set(hex, unique);
  }
  return { byUsbCode, actions: [...actions].sort(), files: used, activePreset };
}

/**
 * The game's action name as a reader would say it: DeployHardpointToggle ->
 * "Deploy Hardpoint Toggle". Acronyms and digits are kept together.
 */
export function humanizeAction(action: string): string {
  return action
    .replace(/_/g, ' ')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim();
}
