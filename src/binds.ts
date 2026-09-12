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
import * as os from 'os';
import * as path from 'path';
import { readTextFile } from './encoding';
import { own, usbKeyName, usbNamePair } from './builtins';

/** What the script produced: a keystroke, a virtual button, or an axis. */
export type InputKind = 'key' | 'button' | 'axis';

export interface BindingRef {
  action: string;
  /** Primary or Secondary where the game has two slots; empty where it has one. */
  slot: string;
  /** The game's own token, e.g. Key_U, Joy_25, JOY_BTN6, js3_button30. */
  key: string;
  modifiers: string[];
  /** Basename, for display. */
  file: string;
  /** Absolute path, for the link back to the file that decides this. */
  path: string;
  /** 1-based line of the action in that file. */
  line: number;
  /** The game this binding belongs to, for the hover to name. */
  game: string;
  kind: InputKind;
  /** Virtual-device button number, when kind is 'button'. DX1 is button 1. */
  button?: number;
  /** Which aircraft or profile this came from, where the game has such a thing. */
  context?: string;
}

export interface BindsIndex {
  /** USB HID code (uppercase hex, 2 digits) -> the actions bound to that key. */
  byUsbCode: Map<string, BindingRef[]>;
  /** Virtual-device button number -> the actions bound to it. DX1 is button 1. */
  byButton: Map<number, BindingRef[]>;
  actions: string[];
  files: string[];
  /** The preset the game will actually load, if it could be determined. */
  activePreset: string | null;
  /** The games whose binding files were read. */
  games: string[];
}

/**
 * A script-to-game association, as recorded by the TARGET GUI itself.
 *
 * TARGET's "associations" pane stores, per entry, the game executable and the .tmc it
 * should run with. That is the authoritative answer to a question the extension was
 * otherwise guessing at - which game a script is written for - so the binding files of
 * every OTHER game can be left out instead of merged into one contradictory list.
 */
export interface GameAssociation {
  /** The name the user gave the association. */
  name: string;
  /** Absolute path of the game executable. */
  gameExe: string;
  /** Absolute path of the .tmc it runs. */
  script: string;
  /** The game this resolves to, or null when it is one we have no parser for. */
  game: string | null;
}

export const GAME_ELITE = 'Elite Dangerous';
export const GAME_DCS = 'DCS World';
export const GAME_STAR_CITIZEN = 'Star Citizen';

/**
 * Which game a binding file belongs to, from its contents rather than its name.
 *
 * Only .binds is unambiguous. Star Citizen exports a plain .xml, which sits in the same
 * folder as TrackIR profiles and anything else, and DCS writes .diff.lua per aircraft.
 */
/**
 * A path reduced to something two spellings of the same file agree on.
 *
 * TARGET records `C:\\Thrustmaster\\x\\y.tmc` while the editor under WSL knows the same
 * file as `/mnt/c/Thrustmaster/x/y.tmc`. Dropping the drive or mount prefix and
 * lower-casing makes them comparable without asking the OS to translate.
 */
export function comparablePath(p: string): string {
  return p
    .replace(/\\/g, '/')
    .replace(/^[A-Za-z]:\//, '')
    .replace(/^\/mnt\/[a-z]\//i, '')
    .replace(/^\//, '')
    .toLowerCase();
}

/** Basename of a path written with either separator. */
function anyBasename(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] ?? '';
}

/**
 * The virtual DirectInput device a script creates.
 *
 * target.tmh's Init() calls `PlugGame(&virtualj, "Thrustmaster Combined")`, and that
 * string is the name the games see - so it is what DCS puts in its filenames. It is an
 * argument, though, so a script that calls PlugGame itself picks its own name and the
 * script has to be asked rather than assumed.
 */
export const DEFAULT_VIRTUAL_DEVICE = 'Thrustmaster Combined';

export function virtualDeviceName(scriptText: string): string {
  const m = /\bPlugGame\s*\(\s*&\s*\w+\s*,\s*"([^"]+)"/.exec(scriptText);
  return m ? m[1] : DEFAULT_VIRTUAL_DEVICE;
}

/**
 * A path under each Windows user profile.
 *
 * On Windows that is the running user's own profile. From WSL it has to be found on the
 * mounted drive and every profile is a candidate, since os.homedir() there is the Linux
 * home and tells us nothing about the Windows user.
 */
function inWindowsProfiles(windowsRoot: string | null, ...rel: string[]): string[] {
  if (process.platform === 'win32') return [path.join(os.homedir(), ...rel)];
  if (!windowsRoot) return [];
  const users = path.join(windowsRoot, 'Users');
  try {
    return fs.readdirSync(users).map((u) => path.join(users, u, ...rel));
  } catch {
    /* no mounted profile */
    return [];
  }
}

/**
 * Where DCS keeps its input profiles.
 *
 *   Saved Games/DCS[.openbeta]/Config/Input/<Module>/<category>/<Device> {GUID}.diff.lua
 *
 * There is no "active" profile the way Elite has one: every module's bindings are live
 * at once and which applies depends on the aircraft being flown. So the module is
 * context to report, not something to filter by - the thing to filter by is the DEVICE,
 * since a file for somebody's rudder pedals says nothing about what a TARGET script does.
 */
export function dcsInputRoots(windowsRoot: string | null): string[] {
  const homes = inWindowsProfiles(windowsRoot, 'Saved Games');
  const roots: string[] = [];
  for (const home of homes) {
    let entries: string[];
    try {
      entries = fs.readdirSync(home);
    } catch {
      continue;
    }
    // DCS, DCS.openbeta, DCS.release - installs sit side by side.
    for (const e of entries) {
      if (!/^DCS(\.|$)/i.test(e)) continue;
      const input = path.join(home, e, 'Config', 'Input');
      try {
        if (fs.statSync(input).isDirectory()) roots.push(input);
      } catch {
        /* not this one */
      }
    }
  }
  return roots;
}

/**
 * Every .diff.lua under a DCS Input tree that belongs to the named device, with the
 * module it was found under.
 */
export function dcsProfilesFor(inputRoot: string, device: string): { file: string; module: string }[] {
  const wanted = device.toLowerCase();
  const out: { file: string; module: string }[] = [];
  let modules: string[];
  try {
    modules = fs.readdirSync(inputRoot);
  } catch {
    return out;
  }
  for (const mod of modules) {
    for (const category of ['joystick', 'keyboard']) {
      const dir = path.join(inputRoot, mod, category);
      let files: string[];
      try {
        files = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!/\.diff\.lua$/i.test(f)) continue;
        // "Thrustmaster Combined {GUID}.diff.lua" - the GUID varies per machine, so the
        // match is on the device name that precedes it.
        if (!f.toLowerCase().startsWith(wanted)) continue;
        out.push({ file: path.join(dir, f), module: mod });
      }
    }
  }
  return out;
}

/** Which game an executable belongs to, by its own name then by its install path. */
export function gameForExecutable(exe: string): string | null {
  const base = anyBasename(exe).toLowerCase();
  const full = exe.toLowerCase();
  if (/^elitedangerous/.test(base)) return GAME_ELITE;
  if (base === 'dcs.exe' || /\bdcs world\b/.test(full)) return GAME_DCS;
  if (base === 'starcitizen.exe' || /\bstarcitizen\b/.test(full)) return GAME_STAR_CITIZEN;
  return null;
}

/**
 * Where the TARGET GUI keeps its settings. Under every Windows profile, then narrowed
 * to the ones that are actually there - from WSL there may be several, and only some
 * of them have ever run TARGET.
 */
export function targetSettingsPaths(windowsRoot: string | null): string[] {
  return inWindowsProfiles(
    windowsRoot,
    'AppData', 'Roaming', 'Thrustmaster', 'TARGET', 'TargetSettings.xml'
  ).filter((p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  });
}

/** Reads the script-to-game associations the TARGET GUI has recorded. */
export function readAssociations(settingsFile: string): GameAssociation[] {
  const xml = readTextFile(settingsFile);
  if (xml === null) return [];
  const out: GameAssociation[] = [];
  const block = /<GameConfigAssociations>([\s\S]*?)<\/GameConfigAssociations>/.exec(xml);
  if (!block) return out;
  const tag = (body: string, name: string): string =>
    new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body)?.[1].trim() ?? '';
  for (const entry of block[1].matchAll(/<Game\d+>([\s\S]*?)<\/Game\d+>/g)) {
    const gameExe = tag(entry[1], 'Game');
    const script = tag(entry[1], 'Configuration');
    if (!script) continue;
    out.push({ name: tag(entry[1], 'Name'), gameExe, script, game: gameForExecutable(gameExe) });
  }
  return out;
}

export function bindingFormat(file: string): string | null {
  if (/\.binds$/i.test(file)) return GAME_ELITE;
  if (/\.diff\.lua$/i.test(file)) return GAME_DCS;
  if (/\.xml$/i.test(file)) {
    const head = readTextFile(file)?.slice(0, 4000) ?? '';
    return /<ActionMaps\b/i.test(head) ? GAME_STAR_CITIZEN : null;
  }
  return null;
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
 * How a modifier written in a script maps onto the name the binding files use.
 *
 * TARGET spells the same modifier two ways and both appear in real scripts. target.tmh
 * defines L_SHIFT..R_WIN as bit flags to OR onto a scancode; defines.tmh defines CTL,
 * SHF, ALT, LCTL, LALT and friends as key IDs in the 1000 range. They are NOT synonyms
 * for "either side": CTL and LCTL are both 1224, and SHF and LSHF are both 1225, so an
 * unqualified one is the LEFT key. USB[0xE0]..USB[0xE7] are the same eight keys again as
 * raw HID codes, which is the idiom the vendor header itself uses.
 */
export const SCRIPT_MODIFIERS: Record<string, string> = {
  L_SHIFT: 'L_SHIFT', R_SHIFT: 'R_SHIFT', L_CTL: 'L_CTL', R_CTL: 'R_CTL',
  L_ALT: 'L_ALT', R_ALT: 'R_ALT', L_WIN: 'L_WIN', R_WIN: 'R_WIN',
  CTL: 'L_CTL', LCTL: 'L_CTL', RCTL: 'R_CTL',
  ALT: 'L_ALT', LALT: 'L_ALT', RALT: 'R_ALT',
  SHF: 'L_SHIFT', LSHF: 'L_SHIFT', RSHF: 'R_SHIFT',
  LWIN: 'L_WIN', RWIN: 'R_WIN',
};

/**
 * Flags that share the `+` position with a modifier but say how the key is sent, not
 * which key it is: PULSE+L_ALT+USB[0x4F] still sends L_ALT + Right Arrow. They are
 * recognised so they are neither matched against the game's modifiers nor reported as
 * unknown - PULSE alone appears 268 times in the known-good corpus.
 */
export const SCRIPT_STATE_FLAGS = new Set(['PULSE', 'DOWN', 'UP', 'LOCK', 'KEYON', 'DELAY', 'REL']);

/** The same eight keys as raw HID codes. */
export const USB_MODIFIERS: Record<string, string> = {
  E0: 'L_CTL', E1: 'L_SHIFT', E2: 'L_ALT', E3: 'L_WIN',
  E4: 'R_CTL', E5: 'R_SHIFT', E6: 'R_ALT', E7: 'R_WIN',
};

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
    for (const p of usbNamePair(name) ?? []) if (!m.has(norm(p))) m.set(norm(p), hex);
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

export interface Chord {
  /** Canonical modifier names, sorted, e.g. ['L_ALT']. */
  modifiers: string[];
  /** Terms that are not modifiers this code knows. */
  unknown: string[];
  /**
   * How many characters before the key the chord occupies, so a caller can underline
   * `L_CTL+USB[0x1F]` rather than just the half of it the token happens to cover.
   */
  length: number;
}

/**
 * The modifiers written before a key on a script line.
 *
 * `L_ALT+USB[0x4F]` and `USB[0x4F]` send different things, and a binding that needs
 * L_SHIFT does not fire for either of them - so the modifiers are part of the question,
 * not decoration. The hover used to match on the scancode alone and present every
 * binding on that key as if it were an answer.
 *
 * An unrecognised term is reported rather than dropped: falling back to the bare key
 * would answer a question the author did not ask. The user's own corpus has nine lines
 * reading `L+CTL+USB[0x1E]`, where `L` is defined nowhere - a typo for `L_CTL`, and
 * exactly the case that must not silently become "no modifier".
 */
export function parseChord(before: string): Chord {
  const modifiers = new Set<string>();
  const unknown: string[] = [];
  const m = /((?:(?:[A-Za-z_]\w*|USB\s*\[[^\]]*\])\s*\+\s*)+)$/.exec(before);
  if (!m) return { modifiers: [], unknown: [], length: 0 };
  for (const raw of m[1].split('+')) {
    const term = raw.trim();
    if (!term) continue;
    const usb = /^USB\s*\[\s*0[xX]([0-9A-Fa-f]+)\s*\]$/.exec(term);
    if (SCRIPT_STATE_FLAGS.has(term)) continue;
    const name = usb ? own(USB_MODIFIERS, usb[1].toUpperCase().padStart(2, '0')) : own(SCRIPT_MODIFIERS, term);
    if (name) modifiers.add(name);
    else unknown.push(term);
  }
  return { modifiers: [...modifiers].sort(), unknown, length: m[1].length };
}

/**
 * Whether a binding fires for exactly this chord. Set equality, not subset.
 *
 * Both sides are sorted here rather than relying on the caller: parseChord already
 * returns its modifiers sorted, but the diagnostic's lookup is handed a plain array
 * and had grown its own copy of this comparison to be safe.
 */
export function chordMatches(ref: BindingRef, chord: string[]): boolean {
  const a = [...ref.modifiers].sort();
  const b = [...chord].sort();
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

/** Turns a character offset into a 1-based line, scanning the file once. */
function lineCounter(text: string): (offset: number) => number {
  const starts: number[] = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return (offset: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/** Parses one .binds file into its action bindings. */
export function parseBinds(file: string): BindingRef[] {
  // Through the same BOM sniffing as every other read: this was the one place that
  // assumed UTF-8, and Windows tools write UTF-16 often enough to matter.
  const xml = readTextFile(file);
  if (xml === null) return [];
  const out: BindingRef[] = [];
  const base = path.basename(file);
  const lineAt = lineCounter(xml);
  // <ActionName> ... <Primary Device="Keyboard" Key="Key_U"><Modifier .../></Primary>
  for (const block of xml.matchAll(/<([A-Za-z_][\w]*)>([\s\S]*?)<\/\1>/g)) {
    const action = block[1];
    const body = block[2];
    const line = lineAt(block.index ?? 0);
    // Either self-closing, or an element whose body carries the modifier keys. The
    // closing tag must not be optional: with a lazy body and an optional close, the
    // body matches empty and every modifier is lost.
    // The virtual device TARGET creates. Its name varies with the hardware
    // (ThrustMasterWarthogCombined, T16000MTHROTTLE, ...), so it is identified by what
    // it is not: the keyboard, the mouse, and the game's word for "unbound". Joy_25
    // here is the button DX25 presses - roughly as many bindings as the keyboard ones
    // in a real profile, and the half a script author most often wants to look up.
    for (const slot of body.matchAll(
      /<(Primary|Secondary)\s+(?=[^>]*Device="(?!Keyboard|Mouse|\{NoDevice\})[^"]+")(?=[^>]*Key="Joy_(\d+)")[^>]*?(?:\/>|>([\s\S]*?)<\/\1>)/g
    )) {
      out.push({
        action,
        slot: slot[1],
        key: `Joy_${slot[2]}`,
        modifiers: [],
        file: base,
        path: file,
        line,
        game: GAME_ELITE,
        kind: 'button',
        button: Number(slot[2]),
      });
    }
    for (const slot of body.matchAll(
      /<(Primary|Secondary)\s+(?=[^>]*Device="Keyboard")(?=[^>]*Key="(Key_[A-Za-z0-9_]+)")[^>]*?(?:\/>|>([\s\S]*?)<\/\1>)/g
    )) {
      const modifiers: string[] = [];
      for (const mod of (slot[3] ?? '').matchAll(/<Modifier\s+(?=[^>]*Device="Keyboard")[^>]*Key="Key_([A-Za-z0-9_]+)"/g)) {
        const flag = own(ED_MODIFIERS, mod[1]);
        if (flag) modifiers.push(flag);
      }
      out.push({ action, slot: slot[1], key: slot[2], modifiers, file: base, path: file, line, game: GAME_ELITE, kind: 'key' });
    }
  }
  return out;
}

/**
 * A DCS input profile (`<Aircraft>.diff.lua`, one per module and device).
 *
 * DCS serialises a Lua table with its keys in alphabetical order, so within one entry
 * "added" comes before "name" and "removed" after it. That ordering is what lets the
 * buttons be attributed without a Lua parser: buttons seen since the last name belong
 * to the name about to appear, and anything under "removed" is a binding being taken
 * away, not one to report.
 */
export function parseDcsDiff(file: string, module?: string): BindingRef[] {
  const text = readTextFile(file);
  if (text === null) return [];
  const base = path.basename(file);
  const lineAt = lineCounter(text);
  const out: BindingRef[] = [];
  let section: 'added' | 'removed' | null = null;
  let pending: { token: string; button: number }[] = [];
  const token = /\["(added|removed|name)"\]\s*=\s*(?:"((?:[^"\\]|\\.)*)")?|\["key"\]\s*=\s*"(JOY_BTN(\d+))"/g;
  for (const m of text.matchAll(token)) {
    if (m[1] === 'added' || m[1] === 'removed') {
      section = m[1];
      if (m[1] === 'added') pending = [];
      continue;
    }
    if (m[1] === 'name') {
      const action = (m[2] ?? '').replace(/\\(.)/g, '$1').trim();
      const line = lineAt(m.index ?? 0);
      if (action) for (const p of pending) out.push({ action, slot: '', key: p.token, modifiers: [], file: base, path: file, line, game: GAME_DCS, kind: 'button', button: p.button, context: module });
      pending = [];
      continue;
    }
    if (m[3] && section === 'added') pending.push({ token: m[3], button: Number(m[4]) });
  }
  return out;
}

/**
 * A Star Citizen exported control mapping (ActionMaps XML).
 *
 * Inputs are written `js<device>_button<n>`; the device index is the game's own
 * enumeration order and says nothing useful here, so only the button number is kept.
 * An input of a single space is the game's way of writing "unbound".
 */
export function parseStarCitizen(file: string): BindingRef[] {
  const xml = readTextFile(file);
  if (xml === null) return [];
  const base = path.basename(file);
  const lineAt = lineCounter(xml);
  const out: BindingRef[] = [];
  for (const m of xml.matchAll(
    /<action\s+name=['"]([^'"]+)['"]\s*>([\s\S]*?)<\/action>/g
  )) {
    const action = m[1];
    for (const r of m[2].matchAll(/<rebind\s+[^>]*input=['"]([^'"]+)['"]/g)) {
      const btn = /^(?:js\d+_)?button(\d+)$/i.exec(r[1].trim());
      if (!btn) continue;
      out.push({ action, slot: '', key: r[1].trim(), modifiers: [], file: base, path: file, line: lineAt(m.index ?? 0), game: GAME_STAR_CITIZEN, kind: 'button', button: Number(btn[1]) });
    }
  }
  return out;
}

/** Parses any supported binding file, choosing the parser by what the file is. */
export function parseBindingFile(file: string, module?: string): BindingRef[] {
  switch (bindingFormat(file)) {
    case GAME_ELITE: return parseBinds(file);
    case GAME_DCS: return parseDcsDiff(file, module);
    case GAME_STAR_CITIZEN: return parseStarCitizen(file);
    default: return [];
  }
}

/** Builds a key-indexed view of every binding in the given files. */
export function buildBindsIndex(
  files: string[],
  activePreset: string | null = null,
  /** Absolute file path -> the DCS module it was found under. */
  modules: Map<string, string> = new Map()
): BindsIndex {
  const byUsbCode = new Map<string, BindingRef[]>();
  const byButton = new Map<number, BindingRef[]>();
  const actions = new Set<string>();
  const games = new Set<string>();
  const used: string[] = [];
  for (const file of files) {
    const refs = parseBindingFile(file, modules.get(file));
    if (refs.length) used.push(file);
    for (const ref of refs) {
      actions.add(ref.action);
      games.add(ref.game);
      if (ref.kind === 'button' && ref.button !== undefined) {
        if (!byButton.has(ref.button)) byButton.set(ref.button, []);
        byButton.get(ref.button)!.push(ref);
        continue;
      }
      const hex = usbCodeForEdKey(ref.key);
      if (!hex) continue;
      if (!byUsbCode.has(hex)) byUsbCode.set(hex, []);
      byUsbCode.get(hex)!.push(ref);
    }
  }
  // The same preset is routinely present twice - the copy shipped beside a script and
  // the one installed in the game's folder - and identical entries from two paths are
  // one fact, not two. Dedupe on what the binding actually says.
  const dedupe = (refs: BindingRef[]): BindingRef[] => {
    const seen = new Set<string>();
    const unique: BindingRef[] = [];
    for (const r of refs) {
      // The context is part of the identity: DCS ships the same action name for every
      // aircraft, and folding "Gun Trigger" in the A-10 together with the same name in
      // the Hornet loses the only thing that made each row mean something. Two copies of
      // ONE preset still collapse, which is what this is for.
      const key = `${r.game}\u0000${r.context ?? ''}\u0000${r.action}\u0000${r.slot}\u0000${r.modifiers.join('+')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(r);
    }
    return unique;
  };
  for (const [hex, refs] of byUsbCode) byUsbCode.set(hex, dedupe(refs));
  for (const [btn, refs] of byButton) byButton.set(btn, dedupe(refs));
  return {
    byUsbCode,
    byButton,
    actions: [...actions].sort(),
    files: used,
    activePreset,
    games: [...games].sort(),
  };
}

