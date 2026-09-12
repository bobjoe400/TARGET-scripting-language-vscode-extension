#!/usr/bin/env node
// Generates src/data/usb-codes.json from the appendix of TARGET's scripting manual.
//
// Scripts address the virtual keyboard as USB[0x2C], and nothing in target.tmh or
// defines.tmh says what a code means - defines.tmh only declares `short USB[256]`.
// The manual's "Appendix: USB Keydown and Keyup codes" is the key, and the test corpus
// uses 123 distinct codes across 318 references, so having the editor name them is the
// difference between reading a script and decoding one.
//
// The PDF scatters spaces through both names and codes ("w W 1 A"), so the table is
// walked by expected code instead of parsed positionally: the codes ascend, so the text
// between one code and the next is that entry's name.
//
//   npm run gen

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const MANUALS = [
  '/mnt/c/Program Files (x86)/Thrustmaster/TARGET/Resources/TARGET_SCRIPT_EDITOR_basics.pdf',
  'C:\\Program Files (x86)\\Thrustmaster\\TARGET\\Resources\\TARGET_SCRIPT_EDITOR_basics.pdf',
  '/mnt/c/Program Files/Thrustmaster/TARGET/Resources/TARGET_SCRIPT_EDITOR_basics.pdf',
];

function pdfText(file) {
  const data = fs.readFileSync(file);
  const hay = data.toString('latin1');
  const out = [];
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(hay)) !== null) {
    const start = m.index + m[0].length;
    const end = data.indexOf(Buffer.from('endstream'), start);
    if (end === -1) continue;
    let raw;
    try {
      raw = zlib.inflateSync(data.subarray(start, end));
    } catch {
      continue;
    }
    const s = raw.toString('latin1');
    for (const t of s.matchAll(/\((?:\\.|[^()\\])*\)/g)) {
      out.push(t[0].slice(1, -1).replace(/\\([nrt])/g, ' ').replace(/\\(.)/g, '$1'));
    }
  }
  return out.join(' ');
}

/**
 * Rejoin letters the PDF scattered out of words: "Up Arro w" -> "Up Arrow",
 * "Ke y pad Ent er" -> "Keypad Enter". A short all-lowercase fragment belongs to the
 * word before it; an uppercase letter starts a new word, which is what keeps
 * "Caps Lock" and "Print Screen" apart.
 */
function rejoin(name) {
  const out = [];
  for (const tok of name.split(/\s+/).filter(Boolean)) {
    const prev = out[out.length - 1];
    const fragment = /^[a-z]{1,3}$/.test(tok);
    const attachable = prev && (/[a-z]$/.test(prev) || /^[A-Z]$/.test(prev)) && /^[A-Za-z]+$/.test(prev);
    if (fragment && attachable) out[out.length - 1] = prev + tok;
    else out.push(tok);
  }
  return out.join(' ');
}

/** Anchors from the USB HID specification, used to prove the parse came out right. */
const ANCHORS = { '04': 'a', '28': 'Return', '29': 'Escape', '2C': 'Space', '3D': 'F4', '52': 'Up' };

const file = MANUALS.find((f) => fs.existsSync(f));
if (!file) {
  console.error('Scripting manual not found; leaving usb-codes.json as it is.');
  process.exit(0);
}

let text = pdfText(file);
const at = text.indexOf('USB HID code');
if (at === -1) {
  console.error('Could not find the USB code appendix in the manual.');
  process.exit(1);
}
text = text.slice(at + 'USB HID code'.length);
// Page furniture repeats through the table and is not part of any key name.
text = text.replace(/\d+\s*\/\s*60[\s\S]{0,120}?v1\.5/g, ' ');
text = text.replace(/T\s*\.?\s*A\.R\.G\.E\.T[\s\S]{0,80}?Manu?\s*al\s*v1\.5/g, ' ');

// Squash whitespace, remembering where each kept character came from.
const chars = [];
const idx = [];
for (let i = 0; i < text.length; i++) {
  if (!/\s/.test(text[i])) {
    chars.push(text[i]);
    idx.push(i);
  }
}
const squashed = chars.join('');

const codes = {};
let cursor = 0;
let lastEnd = 0;
let misses = 0;
for (let code = 0x04; code <= 0xe7; code++) {
  const hex = code.toString(16).toUpperCase().padStart(2, '0');
  const found = squashed.indexOf(hex, cursor);
  if (found === -1 || found - lastEnd > 60) {
    misses++;
    continue; // a gap in the table, or a code the manual does not list
  }
  const name = rejoin(text.slice(idx[lastEnd] ?? 0, idx[found]).replace(/\s+/g, ' ').trim());
  // A name carrying what looks like another code means the walk lost its place;
  // record nothing rather than a run of merged entries.
  const desynced = /\b[0-9A-F]{2}\b/.test(name) && name.length > 12;
  if (name && name.length <= 40 && !desynced) codes[hex] = name;
  lastEnd = found + hex.length;
  cursor = lastEnd;
}

// Verify against the anchors before writing anything.
const bad = [];
for (const [hex, expect] of Object.entries(ANCHORS)) {
  const got = codes[hex];
  if (!got || !got.toLowerCase().replace(/\s+/g, '').startsWith(expect.toLowerCase())) {
    bad.push(`0x${hex}: expected "${expect}...", parsed ${JSON.stringify(got ?? null)}`);
  }
}
if (bad.length) {
  console.error('USB table parse failed its anchor checks; refusing to write:');
  for (const b of bad) console.error(`  ${b}`);
  process.exit(1);
}

const outPath = path.join(repoRoot, 'src/data/usb-codes.json');
fs.writeFileSync(
  outPath,
  JSON.stringify(
    {
      $generated: {
        by: 'tools/gen-usb-codes.mjs',
        from: path.basename(file),
        at: new Date().toISOString().slice(0, 10),
        note: 'Key names for USB[0xNN], from the manual appendix. Not present in target.tmh or defines.tmh.',
      },
      codes,
    },
    null,
    1
  )
);
console.log(`Wrote ${path.relative(repoRoot, outPath)}`);
console.log(`  ${Object.keys(codes).length} codes named (${misses} not listed by the manual)`);
console.log(`  anchors ok: ${Object.entries(ANCHORS).map(([h, v]) => `0x${h}=${codes[h]}`).join(', ')}`);
