#!/usr/bin/env node
// Generates src/data/builtins.json from the headers shipped with a TARGET install.
//
// The headers are ground truth for the installed version; the published PDF manual is
// both older and incomplete. Re-run this after a TARGET update:
//     npm run gen -- --scripts "/path/to/TARGET/scripts"
//
// Anything the parser cannot place is reported rather than guessed at, so that new
// hardware in a future TARGET release surfaces as a warning instead of silently
// missing from completion.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const DEFAULT_SCRIPT_DIRS = [
  '/mnt/c/Program Files (x86)/Thrustmaster/TARGET/scripts',
  'C:\\Program Files (x86)\\Thrustmaster\\TARGET\\scripts',
  '/mnt/c/Program Files/Thrustmaster/TARGET/scripts',
];

/** Decode a buffer, sniffing the BOM. Real TARGET scripts in the wild are often UTF-16. */
export function decodeBuffer(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.slice(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.slice(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.slice(3).toString('utf8');
  }
  return buf.toString('utf8');
}

const readText = (p) => decodeBuffer(fs.readFileSync(p)).replace(/\r\n/g, '\n');

// ---------------------------------------------------------------- argument handling
const argv = process.argv.slice(2);
let scriptsDir = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--scripts') scriptsDir = argv[++i];
}
if (!scriptsDir) scriptsDir = DEFAULT_SCRIPT_DIRS.find((d) => fs.existsSync(path.join(d, 'target.tmh')));
if (!scriptsDir || !fs.existsSync(path.join(scriptsDir, 'target.tmh'))) {
  console.error('Could not find target.tmh. Pass --scripts "<TARGET>/scripts".');
  process.exit(1);
}
console.log(`Reading headers from: ${scriptsDir}`);

const deviceMap = JSON.parse(readText(path.join(__dirname, 'device-map.json')));

// ---------------------------------------------------------------- doc extraction
/**
 * Doc comment for a declaration: the trailing `// ...` on its own line, plus any
 * run of full-line `//` comments immediately above it.
 */
function docFor(lines, index, trailing) {
  const parts = [];
  for (let i = index - 1; i >= 0; i--) {
    const m = lines[i].match(/^\s*\/\/\s?(.*)$/);
    // A section banner ("// ---- X ----") heads a block, it does not document one line.
    if (!m || /^\s*[-=]{3,}/.test(m[1]) || /^\s*\/\/\s*define\b/.test(lines[i])) break;
    if (!m[1].trim()) break;
    parts.unshift(m[1].trim());
    if (parts.length > 6) break;
  }
  if (trailing && trailing.trim()) parts.push(trailing.trim());
  return parts.join('\n');
}

const splitTrailingComment = (line) => {
  // Naive but sufficient here: these headers have no `//` inside string literals on
  // declaration lines. Verified against the shipped headers.
  const i = line.indexOf('//');
  return i === -1 ? [line, ''] : [line.slice(0, i), line.slice(i + 2)];
};

// ---------------------------------------------------------------- functions
const TYPES = ['int', 'float', 'char', 'short', 'void', 'byte', 'word', 'alias'];
const FUNC_RE = new RegExp(`^\\s*(${TYPES.join('|')})\\s+([A-Za-z_]\\w*)\\s*\\(([^)]*)\\)`);

/** Implementation details of the runtime: callable, but never what a user means to write. */
const INTERNAL = new Set([
  '_SEQ', '_CHAIN', '_AXMAP2', '_key', '_GetMouse', 'execproc', 'seqproc', 'chaincall',
  'chainproc', 'tempo1', 'tempoproc', 'rexecproc', 'axis1', 'axisproc', 'ledproc',
  'axmap1proc', 'axmap2proc', 'ASMAlloc', 'ASMFind', 'RJLoop', 'HatUp', 'GetListPos',
  'fcurve', 'P2Curve', 'LI', 'cleanup', 'GetIndexJoy', 'AxisVal', 'GetLayerBits',
]);

function parseParams(raw) {
  const s = raw.trim();
  if (!s) return [];
  return s.split(',').map((p) => {
    const part = p.trim();
    const m = part.match(/^(?:(\w+)\s+)?([A-Za-z_]\w*)\s*(?:=\s*(.+))?$/);
    if (!m) return { name: part, type: null, default: null };
    return { name: m[2], type: m[1] ?? null, default: m[3]?.trim() ?? null };
  });
}

function parseFunctions(text, source) {
  const lines = text.split('\n');
  const out = [];
  lines.forEach((line, i) => {
    // Skip commented-out declarations.
    if (/^\s*\/\//.test(line)) return;
    const m = line.match(FUNC_RE);
    if (!m) return;
    const [, returnType, name, rawParams] = m;
    // A declaration, not a call: what follows the `)` must open a body or end the line.
    const after = line.slice(m[0].length).trim();
    if (after && !/^[{;]/.test(after) && !after.startsWith('//')) return;
    const params = parseParams(rawParams);
    const [, trailing] = splitTrailingComment(line);
    out.push({
      name,
      returnType,
      params,
      signature: `${returnType} ${name}(${params
        .map((p) => `${p.type ? p.type + ' ' : ''}${p.name}${p.default ? ' = ' + p.default : ''}`)
        .join(', ')})`,
      minArgs: params.filter((p) => p.default === null).length,
      maxArgs: params.length,
      doc: docFor(lines, i, trailing),
      internal: INTERNAL.has(name) || name.startsWith('_'),
      source,
    });
  });
  return out;
}

// ---------------------------------------------------------------- defines / constants
const DEFINE_RE = /^\s*define\s+([A-Za-z_]\w*)\s+(.*?)\s*$/;
const COMMENTED_DEFINE_RE = /^\s*\/\/\s*define\s+([A-Za-z_]\w*)\s+(\S+)/;

function parseDefines(text, source) {
  const lines = text.split('\n');
  const out = [];
  lines.forEach((line, i) => {
    const m = line.match(DEFINE_RE);
    if (!m) return;
    const [body, trailing] = splitTrailingComment(m[2]);
    out.push({
      name: m[1],
      value: body.trim(),
      doc: docFor(lines, i, trailing),
      line: i,
      source,
    });
  });
  return out;
}

// ---------------------------------------------------------------- device sections
const SECTION_RE = /^\s*\/\/\s*-{3,}\s*(.*?)\s*-{3,}\s*$/;

function parseSections(text) {
  const lines = text.split('\n');
  const sections = [];
  let current = null;
  lines.forEach((line, i) => {
    const m = line.match(SECTION_RE);
    if (m) {
      if (current) current.end = i;
      current = { title: m[1].trim(), start: i, end: lines.length, names: [] };
      sections.push(current);
      return;
    }
    if (!current) return;
    const d = line.match(DEFINE_RE);
    if (d) {
      const [body, trailing] = splitTrailingComment(d[2]);
      current.names.push({ name: d[1], value: body.trim(), doc: trailing.trim(), shared: false });
      return;
    }
    // A commented-out define inside a device section marks a control that device also
    // has, whose name is defined in another section. Those identifiers are real.
    const c = line.match(COMMENTED_DEFINE_RE);
    if (c) current.names.push({ name: c[1], value: c[2], doc: '', shared: true });
  });
  return sections;
}

/** Buttons carry a plain ordinal; axes and hats resolve through IN_POSITION_*. */
const classify = (value) => (/IN_POSITION|IN_OFFSET/.test(value) ? (/HAT/.test(value) ? 'hat' : 'axis') : 'button');

// ---------------------------------------------------------------- device aliases
function parseDeviceAliases(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (/^\s*\/\//.test(line)) continue;
    const m = line.match(/^\s*alias\s+(.*?);\s*$/);
    if (!m) continue;
    const re = /([A-Za-z_]\w*)\s*=\s*"(VID_[0-9A-Fa-f]+&PID_[0-9A-Fa-f]+)"/g;
    let d;
    while ((d = re.exec(m[1])) !== null) out.push({ alias: d[1], usb: d[2] });
  }
  return out;
}

// ================================================================== build
const files = ['target.tmh', 'defines.tmh', 'hid.tmh', 'sys.tmh'];
const texts = Object.fromEntries(files.map((f) => [f, readText(path.join(scriptsDir, f))]));

const functions = [];
const seenFn = new Map();
for (const f of files) {
  for (const fn of parseFunctions(texts[f], f)) {
    if (seenFn.has(fn.name)) continue; // first declaration wins
    seenFn.set(fn.name, fn);
    functions.push(fn);
  }
}

const constants = [];
const seenConst = new Set();
for (const f of files) {
  for (const c of parseDefines(texts[f], f)) {
    if (seenConst.has(c.name)) continue;
    seenConst.add(c.name);
    constants.push(c);
  }
}

const sections = parseSections(texts['defines.tmh']);
const sectionsByTitle = new Map(sections.map((s) => [s.title, s]));
const aliases = parseDeviceAliases(texts['target.tmh']);

const warnings = [];
const mappedSectionTitles = new Set([
  ...Object.keys(deviceMap.sections),
  ...deviceMap.globalSections,
]);
for (const s of sections) {
  if (!mappedSectionTitles.has(s.title)) {
    warnings.push(`defines.tmh section "${s.title}" is not in tools/device-map.json (${s.names.length} names unused)`);
  }
}

// Tag every constant with the section it came from, so the UI can group them.
const sectionOfConstant = new Map();
for (const s of sections) for (const n of s.names) if (!sectionOfConstant.has(n.name)) sectionOfConstant.set(n.name, s.title);
for (const c of constants) c.category = sectionOfConstant.get(c.name) ?? 'general';

const devices = [];
const deviceOfAlias = new Map();
for (const [title, spec] of Object.entries(deviceMap.sections)) {
  const section = sectionsByTitle.get(title);
  if (!section) {
    warnings.push(`device-map.json references section "${title}", absent from this defines.tmh`);
    continue;
  }
  const collected = [];
  const seen = new Set();
  const take = (sec, inherited) => {
    for (const n of sec.names) {
      if (seen.has(n.name)) continue;
      seen.add(n.name);
      collected.push({
        name: n.name,
        value: n.value,
        kind: classify(n.value),
        doc: n.doc,
        inherited: inherited || n.shared,
      });
    }
  };
  take(section, false);
  for (const inh of spec.inherits ?? []) {
    const s = sectionsByTitle.get(inh);
    if (s) take(s, true);
    else warnings.push(`device-map.json: "${title}" inherits unknown section "${inh}"`);
  }
  for (const alias of spec.devices) {
    const usb = aliases.find((a) => a.alias === alias);
    if (!usb) {
      warnings.push(`device-map.json lists alias "${alias}", not declared in target.tmh`);
      continue;
    }
    deviceOfAlias.set(alias, true);
    devices.push({
      alias,
      label: spec.label,
      usb: usb.usb,
      section: title,
      buttons: collected.filter((c) => c.kind === 'button'),
      axes: collected.filter((c) => c.kind === 'axis'),
      hats: collected.filter((c) => c.kind === 'hat'),
    });
  }
}
for (const a of aliases) {
  if (deviceOfAlias.has(a.alias)) continue;
  const note = deviceMap.unmappedDeviceNote?.[a.alias];
  // Still offered for completion as a device, just with no button table of its own.
  devices.push({ alias: a.alias, label: a.alias, usb: a.usb, section: null, buttons: [], axes: [], hats: [], note: note ?? null });
  if (!note) warnings.push(`target.tmh declares device "${a.alias}" with no section mapping`);
}

const out = {
  $generated: {
    by: 'tools/gen-builtins.mjs',
    from: scriptsDir,
    files: files.map((f) => ({
      name: f,
      bytes: fs.statSync(path.join(scriptsDir, f)).size,
      mtime: fs.statSync(path.join(scriptsDir, f)).mtime.toISOString().slice(0, 10),
    })),
    at: new Date().toISOString().slice(0, 10),
    note: 'Do not edit by hand. Regenerate with: npm run gen',
  },
  keywords: ['char', 'byte', 'short', 'word', 'int', 'alias', 'float', 'struct', 'include', 'define', 'if', 'else', 'do', 'while', 'return', 'goto', 'break'],
  notKeywords: ['for', 'switch', 'continue', 'case', 'default', 'typedef', 'enum', 'const', 'static', 'void', 'sizeof_'],
  functions,
  constants,
  devices,
};

const outPath = path.join(repoRoot, 'src', 'data', 'builtins.json');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(out, null, 1));

console.log(`\nWrote ${path.relative(repoRoot, outPath)}`);
console.log(`  functions : ${functions.length} (${functions.filter((f) => !f.internal).length} public)`);
console.log(`  constants : ${constants.length}`);
console.log(`  devices   : ${devices.length} (${devices.filter((d) => d.buttons.length).length} with button tables)`);
if (warnings.length) {
  console.log(`\n${warnings.length} warning(s):`);
  for (const w of warnings) console.log(`  ! ${w}`);
} else {
  console.log('\nNo warnings: every section and device alias accounted for.');
}
