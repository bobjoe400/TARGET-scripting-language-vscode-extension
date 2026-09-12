// Assertions over real TARGET constructs, then a whole-corpus sanity sweep.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokenizeText, tokenizeFull, leaf } from './tokenize.mjs';
import { decode } from './decode.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

let pass = 0;
const failures = [];

/** Assert that `needle` in `src` ends up with a scope containing `expect`. */
async function check(label, src, needle, expect) {
  const toks = await tokenizeText(src);
  // Tokens split at rule boundaries, so a comment arrives as "//" + " note".
  const hit = toks.find((t) => t.text === needle)
    ?? toks.find((t) => t.text.trim() === needle)
    ?? toks.find((t) => t.text.includes(needle));
  if (!hit) {
    failures.push(`${label}: token ${JSON.stringify(needle)} not produced at all`);
    return;
  }
  if (!hit.scopes.some((s) => s.includes(expect))) {
    failures.push(`${label}: ${JSON.stringify(needle)} => ${leaf(hit)}  (wanted a scope containing "${expect}")`);
    return;
  }
  pass++;
}

const T = [
  ['include directive',       'include "target.tmh"', 'include', 'keyword.control.directive.include'],
  ['include path',            'include "target.tmh"', 'target.tmh', 'string.quoted.double.include'],
  ['define name',             'define MapKeyProfile FULL', 'MapKeyProfile', 'entity.name.constant'],
  ['line comment',            'MapKey(&Joystick, TG1, 0); // note', 'note', 'comment.line'],
  ['line comment punctuation','MapKey(&Joystick, TG1, 0); // note', '//', 'punctuation.definition.comment'],
  ['block comment',           '/* hi */', 'hi', 'comment.block'],
  ['block comment multiline', '/* a\n   b */ int x;', 'b', 'comment.block'],
  ['code after block comment','/* a */ int x;', 'int', 'storage.type'],
  ['url in comment ok',       '// see http://x.com/a\nint y;', 'int', 'storage.type'],
  ['define with string value','define VBranch "dev"', 'VBranch', 'entity.name.constant'],
  ['comment-like in string',  'alias u = "http://x/a";', 'http://x/a', 'string.quoted.double'],
  ['device alias',            'MapKey(&Joystick, TG1, 0);', 'Joystick', 'support.class.device'],
  ['address-of device',       'MapKey(&Joystick, TG1, 0);', '&', 'keyword.operator.address-of'],
  ['builtin function',        'MapKey(&Joystick, TG1, 0);', 'MapKey', 'support.function'],
  ['button constant',         'MapKey(&Joystick, TG1, 0);', 'TG1', 'support.constant.button'],
  ['T16000 button',           'MapKey(&T16000, TS1, 0);', 'TS1', 'support.constant.button'],
  ['dx constant',             'MapKey(&Joystick, S1, DX5);', 'DX5', 'support.constant.directx'],
  ['axis constant',           'MapAxis(&Joystick, JOYX, DX_X_AXIS);', 'DX_X_AXIS', 'support.constant.directx'],
  ['event flag',              "ActKey(PULSE+KEYON+'a');", 'PULSE', 'support.constant.flag'],
  ['keyboard constant',       'MapKey(&Joystick, S1, L_CTL+F1);', 'F1', 'support.constant.keyboard'],
  ['char literal',            "ActKey(PULSE+KEYON+'a');", "'a'", 'string.quoted.single'],
  // Layer constants are written 'i', 'o', 'iu', 'ium' - the extension's own parameter
  // help documents that, so a single-character pattern left most of them unstyled.
  ['two-char layer constant',   "KeyAxis(&Joystick, JOYX, 'iu', 0);", "'iu'", 'string.quoted.single'],
  ['three-char layer constant', "KeyAxis(&Joystick, JOYX, 'ium', 0);", "'ium'", 'string.quoted.single'],
  ['hex number',              'int x = 0x2C;', '0x2C', 'constant.numeric.hex'],
  ['float number',            'SetSCurve(&Joystick, JOYX, 0, 0, 0, 5, 0.5);', '0.5', 'constant.numeric.float'],
  ['control keyword',         'if(Joystick[TG1]) ActKey(0);', 'if', 'keyword.control'],
  ['storage type',            'int autopilot;', 'int', 'storage.type'],
  ['function definition',     'int MainKeyMap()\n{\n}', 'MainKeyMap', 'entity.name.function'],
  ['user function call',      'fnAdvFireControl(0);', 'fnAdvFireControl', 'entity.name.function.call'],
  ['USB lookup table',        'MapKey(&Joystick, S1, USB[0x2C]);', 'USB', 'support.constant.usb'],
  ['USB hex index',           'MapKey(&Joystick, S1, USB[0x2C]);', '0x2C', 'constant.numeric.hex'],
  ['plain string',            'alias f = "C:\\\\path.json";', 'alias', 'storage.type'],
  ['for is not a keyword',    'for(i=0;i<3;i++) x();', 'for', 'invalid.illegal'],
  ['switch is not a keyword', 'switch(x) { }', 'switch', 'invalid.illegal'],
  // EXEC: TARGET source inside a string literal
  ['EXEC name',               'MapKey(&Joystick, S4, EXEC("tgTriggerMode(1);"));', 'EXEC', 'support.function.exec'],
  ['EXEC body is embedded',   'MapKey(&Joystick, S4, EXEC("tgTriggerMode(1);"));', 'tgTriggerMode', 'meta.embedded'],
  ['EXEC body call scope',    'MapKey(&Joystick, S4, EXEC("tgTriggerMode(1);"));', 'tgTriggerMode', 'entity.name.function.call'],
  ['EXEC builtin inside',     'EXEC("SetSCurve(&Joystick, JOYX, 0,0,0,5,0);");', 'SetSCurve', 'support.function'],
  ['EXEC device inside',      'EXEC("SetSCurve(&Joystick, JOYX, 0,0,0,5,0);");', 'Joystick', 'support.class.device'],
  ['EXEC number inside',      'EXEC("tgTriggerMode(1);");', '1', 'constant.numeric'],
  ['EXEC nested string',      'EXEC("fnVPOutput(\\"not used\\");");', '\\"', 'string.quoted.double.nested'],
];

console.log('Grammar assertions');
console.log('------------------');
for (const [label, src, needle, expect] of T) await check(label, src, needle, expect);

for (const f of failures) console.log(`  FAIL  ${f}`);
console.log(`  ${pass}/${T.length} assertions passed`);

// ---- corpus sweep ----------------------------------------------------------
// What matters is that the tokenizer never gets stuck: a string or block comment it
// opens and never closes would mis-colour the entire rest of the file. Unscoped
// punctuation and plain identifiers are expected and not interesting.
const corpusDir = process.env.TARGET_CORPUS || path.join(repoRoot, 'test/fixtures');
let sweepFiles = [];
if (fs.existsSync(corpusDir)) {
  sweepFiles = fs.readdirSync(corpusDir)
    .filter((f) => /\.(tmc|tmh|ttm)$/i.test(f))
    .map((f) => path.join(corpusDir, f));
}

if (sweepFiles.length) {
  console.log(`\nCorpus sweep (${sweepFiles.length} files from ${corpusDir})`);
  console.log('------------------');
  let totalTokens = 0;
  const scopeCounts = new Map();
  const reserved = [];
  for (const file of sweepFiles) {
    const text = decode(fs.readFileSync(file));
    const { tokens, endedClean, endDepth } = await tokenizeFull(text);
    totalTokens += tokens.length;
    if (!endedClean) {
      failures.push(`${path.basename(file)}: tokenizer left ${endDepth - 1} rule(s) open at EOF (unterminated string or comment)`);
    }
    for (const t of tokens) {
      for (const sc of t.scopes) {
        if (sc === 'source.target') continue;
        const fam = sc.split('.').slice(0, 2).join('.');
        scopeCounts.set(fam, (scopeCounts.get(fam) ?? 0) + 1);
      }
      if (t.scopes.some((sc) => sc.includes('invalid.illegal'))) {
        reserved.push(`${path.basename(file)}:${t.line}  ${JSON.stringify(t.text.trim())}`);
      }
    }
    console.log(`  ${endedClean ? 'ok  ' : 'STUCK'} ${path.basename(file).padEnd(26)} ${String(tokens.length).padStart(6)} tokens`);
  }
  console.log(`\n  ${totalTokens} tokens total. Scope families:`);
  for (const [k, v] of [...scopeCounts].sort((a, x) => x[1] - a[1]).slice(0, 14)) {
    console.log(`    ${String(v).padStart(6)}  ${k}`);
  }
  // Every corpus file must actually light up the TARGET-specific scopes; if a grammar
  // change broke the builtin tables these counts would collapse to zero.
  for (const need of ['support.function', 'support.constant', 'support.class', 'meta.embedded']) {
    if (!(scopeCounts.get(need) > 0)) failures.push(`corpus produced no ${need} tokens`);
  }
  if (reserved.length) {
    console.log(`\n  ${reserved.length} use(s) of words that are not TARGET keywords:`);
    for (const r of reserved.slice(0, 10)) console.log(`    ${r}`);
  } else {
    console.log('\n  No non-TARGET reserved words used in the corpus.');
  }
} else {
  console.log(`\nNo corpus files in ${corpusDir} - skipping sweep.`);
}

// The grammar too: a rule that assumed LF would mis-scope every real TARGET file.
if (sweepFiles.length) {
  let crlfStuck = 0;
  for (const file of sweepFiles) {
    const text = decode(fs.readFileSync(file)).replace(/\r?\n/g, '\r\n');
    const { endedClean } = await tokenizeFull(text);
    if (!endedClean) {
      crlfStuck++;
      console.log(`  STUCK (CRLF) ${path.basename(file)}`);
    }
  }
  if (crlfStuck === 0) {
    console.log(`\n  All ${sweepFiles.length} files tokenize cleanly as CRLF as well.`);
  } else {
    failures.push(`${crlfStuck} file(s) leave the tokenizer stuck when converted to CRLF`);
  }
}

if (failures.length) {
  console.log(`\n${failures.length} failure(s).`);
  process.exit(1);
}
console.log('\nAll grammar assertions passed.');
