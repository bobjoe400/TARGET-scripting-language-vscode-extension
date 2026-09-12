// Function descriptions from Thrustmaster's Script Editor manual.
//
// 96 of the 171 builtins carry no comment in the headers, so their hover could only
// show a signature. The manual describes some of them in prose - and with positional
// text extraction that prose comes out clean enough to use.
//
// It is deliberately conservative. A sentence is taken only when the manual introduces
// the function by name and follows it with a definition, and it is discarded if it has
// run into a code sample, describes a restriction rather than the function, or reads as
// commentary on an example. A wrong description is worse than none: it would be shown
// as fact, in the editor, next to the reader's own code.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pdfPages, pageLines } from './pdf-text.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

const MANUALS = [
  '/mnt/c/Program Files (x86)/Thrustmaster/TARGET/Resources/TARGET_SCRIPT_EDITOR_basics.pdf',
  'C:\\Program Files (x86)\\Thrustmaster\\TARGET\\Resources\\TARGET_SCRIPT_EDITOR_basics.pdf',
  '/mnt/c/Program Files/Thrustmaster/TARGET/Resources/TARGET_SCRIPT_EDITOR_basics.pdf',
];

const VERB =
  '(?:is|are|allows|lets|works|gives|provides|generates|returns|sets|defines|creates|maps|protects|simulates|reads|dedicated)';

/** Something from the language or the hardware, so the sentence says something. */
const CONCRETE =
  /\b(axis|axes|button|key|keystroke|event|layer|delay|value|zone|output|curve|device|joystick|throttle|trigger|function|script|shift|mouse|directx|led|sequence|deadzone)\b/i;

/** The sentence the manual uses to introduce `name`, or null. */
export function definitionFor(text, name) {
  // The manual heads a section with the function's name and then repeats it to start
  // the sentence - "MapKeyIOUMD MapKeyIOUMD allows you to..." - which is a far stronger
  // signal than a passing mention elsewhere in the prose.
  const patterns = [
    new RegExp(`\\b${name}\\s+${name}\\s+(${VERB}\\b[\\s\\S]{18,300}?[.!])(?:\\s|$)`, 'g'),
    new RegExp(`\\b${name}\\s+(${VERB}\\b[\\s\\S]{18,300}?[.!])(?:\\s|$)`, 'g'),
  ];
  // Every match, not just the first, and a low minimum length so each sentence is judged
  // on its own. A section often opens with one that leans on the paragraph above it -
  // "AXMAP2 is the second Digital axis mode" - and follows it with one that stands
  // alone; with a longer floor the two matched as a single candidate and both were lost.
  const candidates = patterns.flatMap((re) => [...text.matchAll(re)].map((m) => m[1]));
  for (const raw of candidates) {
    const s = raw.trim().replace(/\s+/g, ' ');
    if (/[;{}]|\/\/|\(&|=/.test(s)) continue;                       // ran into code
    if (/^is forbidden|^is not|^are not/.test(s)) continue;          // a restriction
    if (/illustration|example of|for instance/i.test(s)) continue;   // about an example
    if (s.split(' ').length < 6) continue;
    // A sentence that leans on context the reader does not have. "AXMAP1 is the first
    // one." means nothing in a hover, however well it reads after the paragraph above it.
    if (/^is the (?:first|second|third|next|other|same|last)\b/i.test(s)) continue;
    // And one that says nothing at all. "SetCustomCurve gives you the opportunity to do
    // exactly what you want" is true of most functions and informs no one, so a
    // description has to mention something in the language to earn its place.
    if (!CONCRETE.test(s)) continue;
    return s;
  }
  return null;
}

export function manualText(file) {
  return pdfPages(file)
    .map(pageLines)
    .flat()
    .join(' ')
    .replace(/\s*\d+\/60\s*-?\s*/g, ' ')
    .replace(/T\.?A\.?R\.?G\.?E\.?T Script Editor Basics User Manual v1\.5\s*/g, ' ')
    .replace(/\s+/g, ' ');
}

/** Sentences that must come out right, or the parse is not trustworthy. */
const ANCHORS = {
  CHAIN: 'multiple outputs by pressing a button once',
  MapKeyR: 'activated when the controller button turns',
  SetSCurve: 'fine-tune your Joystick axis',
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = MANUALS.find((f) => fs.existsSync(f));
  if (!file) {
    console.error('Script Editor manual not found; leaving manual-docs.json as it is.');
    process.exit(0);
  }
  const text = manualText(file);
  const builtins = JSON.parse(fs.readFileSync(path.join(repoRoot, 'src/data/builtins.json'), 'utf8'));
  const docs = {};
  for (const f of builtins.functions) {
    const d = definitionFor(text, f.name);
    if (d) docs[f.name] = d;
  }

  const bad = Object.entries(ANCHORS).filter(([n, must]) => !(docs[n] ?? '').includes(must));
  if (bad.length) {
    console.error('Manual parse failed its anchor checks; refusing to write:');
    for (const [n, must] of bad) console.error(`  ${n}: expected to contain "${must}", got ${JSON.stringify(docs[n] ?? null)}`);
    process.exit(1);
  }

  const out = {
    $generated: {
      by: 'tools/gen-manual-docs.mjs',
      from: file,
      bytes: fs.statSync(file).size,
      at: new Date().toISOString().slice(0, 10),
    },
    docs,
  };
  fs.writeFileSync(path.join(repoRoot, 'src/data/manual-docs.json'), JSON.stringify(out, null, 2) + '\n');
  const undocumented = builtins.functions.filter((f) => !f.doc && docs[f.name]).length;
  console.log('Wrote src/data/manual-docs.json');
  console.log(`  ${Object.keys(docs).length} descriptions, ${undocumented} for builtins the headers do not comment`);
  console.log(`  anchors ok: ${Object.keys(ANCHORS).join(', ')}`);
}
