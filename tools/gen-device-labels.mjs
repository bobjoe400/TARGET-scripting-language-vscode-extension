#!/usr/bin/env node
// Generates src/data/device-labels.json from the per-device PDFs TARGET installs.
//
// Those PDFs are wiring diagrams: they name each physical control ("Engine Fuel Flow
// Left") beside the script identifier for it (EFLNORM, EFLOVER). Nobody remembers what
// EFLNORM or CHF mean, so surfacing the description in completion and hover is the
// point of this file.
//
// The text comes out of a PDF in drawing order with letters scattered out of words, so
// extraction is heuristic and deliberately conservative: a label is kept only if it
// reads as prose. Devices whose PDF carries no per-control description (the T.16000M
// and the MFDs are tables of group headings) are skipped rather than filled with noise.
//
//   npm run gen

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const RESOURCE_DIRS = [
  '/mnt/c/Program Files (x86)/Thrustmaster/TARGET/Resources',
  'C:\\Program Files (x86)\\Thrustmaster\\TARGET\\Resources',
  '/mnt/c/Program Files/Thrustmaster/TARGET/Resources',
];

/** Which PDF describes which device aliases. */
const SOURCES = [
  { pdf: 'warthog_throttle.pdf', devices: ['Throttle'] },
  { pdf: 'warthog_joystick.pdf', devices: ['Joystick', 'JoystickF18'] },
  { pdf: 'cougar_joystick.pdf', devices: ['HCougar'] },
  { pdf: 'cougar_throttle.pdf', devices: ['HCougar'] },
];

/** Inflate a PDF's streams and pull the text-showing operators out. */
function pdfText(file) {
  const data = fs.readFileSync(file);
  const out = [];
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(data.toString('latin1'))) !== null) {
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

/** Rejoin letters the PDF scattered out of words: "W eapons" -> "Weapons". */
function clean(s) {
  let t = s.replace(/[^A-Za-z0-9 ()\/+.\-]/g, ' ').replace(/\s+/g, ' ').trim();
  t = t.replace(/\b([A-Za-z]) ([a-z])/g, '$1$2');
  t = t.replace(/([a-z]) ([a-z])\b(?= |$)/g, '$1$2');
  // "RDR AL T" -> "RDR ALT": a lone trailing capital belongs to the capitalised word
  // before it. Only a single letter, so "EAC On" is left alone.
  t = t.replace(/\b([A-Z]{2,}) ([A-Z])\b(?![a-z])/g, '$1$2');
  return t.replace(/\s+/g, ' ').trim();
}

/**
 * Keep only labels that read as a description. Diagram headings ("JOYSTICK", "BASE"),
 * DirectX annotations and layout fragments are not descriptions of a control.
 */
function usable(lab) {
  if (lab.length < 4 || lab.length > 60) return false;
  if (!/[a-z]/.test(lab)) return false;
  if (!/^[A-Za-z]/.test(lab)) return false;
  if (/^DX|^LED \d|only$/i.test(lab)) return false;
  // A lone capital followed by more capitals is split-word noise, not prose.
  if (/\b[A-Z] [A-Z]{2,}/.test(lab)) return false;
  return true;
}

const builtins = JSON.parse(fs.readFileSync(path.join(repoRoot, 'src/data/builtins.json'), 'utf8'));
const controlsOf = (alias) => {
  const d = builtins.devices.find((x) => x.alias === alias);
  if (!d) return null;
  return new Set([...d.buttons, ...d.axes, ...d.hats].map((c) => c.name));
};

function extract(text, names) {
  const words = text.replace(/\bDX\s+(\d)/g, 'DX$1').split(/\s+/).filter(Boolean);
  // Recover control names split by stray spaces ("L TB" -> "LTB").
  const glued = [];
  for (let i = 0; i < words.length; i++) {
    let w = words[i];
    for (let k = 1; k <= 3 && i + k < words.length; k++) {
      const cand = words.slice(i, i + k + 1).join('');
      if (names.has(cand)) {
        w = cand;
        i += k;
        break;
      }
    }
    glued.push(w);
  }
  const out = new Map();
  const isCtl = (w) => names.has(w) || /^DX\d+$/.test(w) || /^\(\d+\)$/.test(w);
  let i = 0;
  while (i < glued.length) {
    if (!names.has(glued[i])) {
      i++;
      continue;
    }
    const runStart = i;
    const run = [];
    while (i < glued.length && isCtl(glued[i])) {
      run.push(glued[i]);
      i++;
    }
    const label = [];
    for (let k = runStart - 1; k >= 0 && label.length < 7; k--) {
      if (isCtl(glued[k])) break;
      label.unshift(glued[k]);
    }
    const lab = clean(label.join(' '));
    if (!usable(lab)) continue;
    for (const n of run) if (names.has(n) && !out.has(n)) out.set(n, lab);
  }
  return out;
}

const dir = RESOURCE_DIRS.find((d) => fs.existsSync(d));
if (!dir) {
  console.error('TARGET Resources folder not found; leaving device-labels.json as it is.');
  process.exit(0);
}

const labels = {};
const coverage = [];
for (const { pdf, devices } of SOURCES) {
  const file = path.join(dir, pdf);
  if (!fs.existsSync(file)) {
    coverage.push(`  ! ${pdf} missing`);
    continue;
  }
  const text = pdfText(file);
  for (const alias of devices) {
    const names = controlsOf(alias);
    if (!names) {
      coverage.push(`  ! ${alias} is not a known device`);
      continue;
    }
    const found = extract(text, names);
    labels[alias] = { ...(labels[alias] ?? {}), ...Object.fromEntries(found) };
    coverage.push(`  ${alias.padEnd(14)} ${String(Object.keys(labels[alias]).length).padStart(3)}/${names.size} controls described   (${pdf})`);
  }
}

const out = {
  $generated: {
    by: 'tools/gen-device-labels.mjs',
    from: dir,
    at: new Date().toISOString().slice(0, 10),
    note: 'Heuristic extraction from the per-device PDFs. Only devices whose PDF carries per-control prose are covered; the T.16000M and MFD diagrams are group headings and are deliberately absent.',
  },
  labels,
};
const outPath = path.join(repoRoot, 'src/data/device-labels.json');
fs.writeFileSync(outPath, JSON.stringify(out, null, 1));
console.log(`Wrote ${path.relative(repoRoot, outPath)}`);
console.log(coverage.join('\n'));
console.log(`  total: ${Object.values(labels).reduce((a, o) => a + Object.keys(o).length, 0)} described controls`);
