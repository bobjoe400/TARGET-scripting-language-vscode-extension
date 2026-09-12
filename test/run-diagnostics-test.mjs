// Two-sided test of the diagnostic rules:
//   1. Synthetic broken snippets must produce the expected diagnostic.
//   2. The real-world corpus is known-good, compiling code, so any error-severity
//      diagnostic on it is a false positive and fails the run.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { decode } from './decode.mjs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const { buildModel, collectAliasBindings } = require(path.join(repoRoot, 'out/model.js'));
const { computeDiagnostics } = require(path.join(repoRoot, 'out/diagnostics.js'));

const run = (src, name = 'test.tmh', bindings) => {
  const model = buildModel(src);
  return computeDiagnostics(model, name, { aliasBindings: bindings ?? collectAliasBindings(model) });
};

let pass = 0;
const failures = [];

/** The snippet must produce a diagnostic with this code. */
function expect(label, src, code, name = 'test.tmh') {
  const ds = run(src, name);
  if (ds.some((d) => d.code === code)) { pass++; return; }
  failures.push(`${label}: expected code "${code}", got [${ds.map((d) => d.code).join(', ') || 'none'}]`);
}

/** The snippet must produce no diagnostics at all. */
function expectClean(label, src, name = 'test.tmh') {
  const ds = run(src, name);
  if (ds.length === 0) { pass++; return; }
  failures.push(`${label}: expected no diagnostics, got ${ds.map((d) => `${d.code}: ${d.message.split('\n')[0]}`).join(' | ')}`);
}

console.log('Diagnostic rules');
console.log('----------------');

// -- things that must be flagged ---------------------------------------------
expect('for loop',            'int f() { for(i=0;i<3;i=i+1) x(); }', 'not-in-target');
expect('switch',              'int f() { switch(x) { } }', 'not-in-target');
expect('too few args',        'int f() { MapKey(&Joystick); }', 'arity');
expect('too many args',       'int f() { MapKey(&Joystick, TG1, 0, 0, 9, 9); }', 'arity');
expect('SEQ inside EXEC',     'int f() { MapKey(&Joystick, S1, EXEC("SEQ(a,b);")); }', 'forbidden-in-exec');
expect('CHAIN inside EXEC',   'int f() { MapKey(&Joystick, S1, EXEC("CHAIN(a,b);")); }', 'forbidden-in-exec');
expect('EXEC inside EXEC',    'int f() { MapKey(&Joystick, S1, EXEC("EXEC(\\"x();\\");")); }', 'forbidden-in-exec');
expect('SetCustomCurve EXEC', 'int f() { MapKey(&Joystick, S1, EXEC("SetCustomCurve(&Joystick, JOYX, 0);")); }', 'forbidden-in-exec');
expect('forbidden in REXEC',  'int f() { REXEC(0, 500, "SEQ(a,b);"); }', 'forbidden-in-exec');
expect('REXEC handle high',   'int f() { REXEC(100, 500, "fn();"); }', 'rexec-handle');
expect('REXEC handle neg',    'int f() { REXEC(-1, 500, "fn();"); }', 'rexec-handle');
expect('AXMAP2 zone mismatch','int f() { MapAxis(&Joystick, JOYX, 0); AXMAP2(3, a, b); }', 'axmap2-zones');
expect('AXMAP1 odd + center', 'int f() { AXMAP1(3, u, d, c); }', 'axmap1-center');
expect('SetSCurve curve range','int f() { SetSCurve(&Joystick, JOYX, 0, 0, 0, 99, 0); }', 'range');
expect('SetSCurve deadzone',  'int f() { SetSCurve(&Joystick, JOYX, 150, 0, 0, 5, 0); }', 'range');
expect('LEDV value range',    'int f() { LEDV(&Throttle, 1, 200); }', 'range');
expect('LEDRGB byte range',   'int f() { LEDRGB(&Throttle, 1, 300, 0, 0); }', 'range');
expect('TrimDXAxis range',    'int f() { TrimDXAxis(DX_X_AXIS, 5000); }', 'range');
// A control the device has no index for at all is a real defect.
expect('control absent on device', 'int f() { MapKey(&T16000, APALT, 0); }', 'wrong-device-control');
// A name borrowed from another device that lands on the same index still works; that
// is a clarity hint, not an error, and the corpus genuinely relies on it.
expect('misleading control name',  'int f() { MapKey(&T16000, TG1, 0); }', 'control-name-mismatch');
// The same checks must work through a handle the script binds itself.
expect('through bound alias',      'alias MyJoy;\nint f() { &MyJoy = &T16000; MapKey(&MyJoy, APALT, 0); }', 'wrong-device-control');
expect('bound alias name hint',    'alias MyJoy;\nint f() { &MyJoy = &T16000; MapKey(&MyJoy, TG1, 0); }', 'control-name-mismatch');
expect('tmc missing include', 'int main() { }', 'missing-target-include', 'main.tmc');
expect('tmc wrong first inc', 'include "other.tmh"\nint main() { }', 'target-include-order', 'main.tmc');
expect('CHAIN no delay',      'int f() { MapKey(&Joystick, S1, CHAIN(a,b,c,d,e,f,g)); }', 'chain-no-delay');

// -- things that must NOT be flagged ------------------------------------------
expectClean('valid MapKey',        'int f() { MapKey(&Joystick, TG1, 0); }');
expectClean('valid full MapKey',   'int f() { MapKeyIOUMD(&Joystick, TG1, 0,0,0,0,0,0); }');
expectClean('optional args left off','int f() { MapKey(&Joystick, TG1); }');
expectClean('valid EXEC',          'int f() { MapKey(&Joystick, S1, EXEC("fnFoo(1);")); }');
expectClean('EXEC nested string',  'int f() { MapKey(&Joystick, S1, EXEC("fnVPOutput(\\"not used\\");")); }');
expectClean('valid REXEC',         'int f() { REXEC(0, 500, "fnFoo();", RNOSTOP); }');
expectClean('valid AXMAP2',        'int f() { AXMAP2(2, a, b); }');
expectClean('AXMAP1 even+center',  'int f() { AXMAP1(4, u, d, c); }');
expectClean('AXMAP1 odd no center','int f() { AXMAP1(3, u, d); }');
expectClean('device correct btn',  'int f() { MapKey(&T16000, TS1, 0); }');
expectClean('bound alias correct',  'alias MyJoy;\nint f() { &MyJoy = &T16000; MapKey(&MyJoy, TS1, 0); }');
// A handle that can also be bound to hardware this has no table for must stay quiet.
expectClean('alias bound to unknown','alias MyJoy;\nint f() { &MyJoy = &joy0; &MyJoy = &T16000; MapKey(&MyJoy, APALT, 0); }');
expectClean('unbound alias quiet',  'alias MyJoy;\nint f() { MapKey(&MyJoy, APALT, 0); }');
// Valid under either branch the handle can take.
expectClean('multi-bound alias ok', 'alias MyJoy;\nint f() { &MyJoy = &T16000; &MyJoy = &T16000L; MapKey(&MyJoy, TS1, 0); }');
expectClean('user define as btn',  'int f() { MapKey(&T16000, MY_OWN_BUTTON, 0); }');
expectClean('CHAIN with delays',   'int f() { MapKey(&Joystick, S1, CHAIN(a,D(),b,D(),c,D(),d,D(),e,D(),f,D(),g)); }');
expectClean('valid tmc',           'include "target.tmh"\nint main() { }', 'main.tmc');
expectClean('SetSCurve valid',     'int f() { SetSCurve(&Joystick, JOYX, 0, 0, 0, 5, 0); }');
expectClean('negative curve ok',   'int f() { SetSCurve(&Joystick, JOYX, 0, 0, 0, -20, 0); }');
expectClean('TrimDXAxis w/ CURRENT','int f() { TrimDXAxis(DX_X_AXIS, CURRENT); }');

for (const f of failures) console.log(`  FAIL  ${f}`);
console.log(`  ${pass}/${pass + failures.length} rule assertions passed`);

// -- the corpus must stay clean ------------------------------------------------
const corpusDir = process.env.TARGET_CORPUS || path.join(repoRoot, 'test/fixtures');
if (fs.existsSync(corpusDir)) {
  const files = fs.readdirSync(corpusDir).filter((f) => /\.(tmc|tmh|ttm)$/i.test(f));
  console.log(`\nCorpus false-positive check (${files.length} known-good files)`);
  console.log('----------------');
  const byCode = new Map();
  let errors = 0;

  // The corpus binds its device handles in one file and uses them in another, so the
  // bindings are merged across the whole set the way the include closure does.
  const corpusBindings = new Map();
  const models = new Map();
  for (const f of files) {
    const text = decode(fs.readFileSync(path.join(corpusDir, f)));
    const model = buildModel(text);
    models.set(f, { text, model });
    for (const [k, v] of collectAliasBindings(model)) {
      if (!corpusBindings.has(k)) corpusBindings.set(k, new Set());
      for (const d of v) corpusBindings.get(k).add(d);
    }
  }
  console.log(`  device handles bound by the corpus: ${[...corpusBindings].map(([k, v]) => `${k}->{${[...v].join(',')}}`).join(' ') || 'none'}\n`);

  for (const f of files) {
    const { text, model } = models.get(f);
    const ds = computeDiagnostics(model, f, { aliasBindings: corpusBindings });
    const errs = ds.filter((d) => d.severity === 'error');
    errors += errs.length;
    for (const d of ds) byCode.set(d.code, (byCode.get(d.code) ?? 0) + 1);
    const warns = ds.filter((d) => d.severity === 'warning').length;
    const infos = ds.filter((d) => d.severity === 'info').length;
    console.log(`  ${errs.length ? 'ERR ' : 'ok  '} ${f.padEnd(26)} ${errs.length} error, ${warns} warning, ${infos} hint`);
    for (const d of errs.slice(0, 4)) {
      const line = text.slice(0, d.start).split('\n').length;
      console.log(`        ${f}:${line}  [${d.code}] ${d.message.split('\n')[0]}`);
    }
  }
  console.log(`\n  by code: ${[...byCode].map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}`);
  if (errors) failures.push(`${errors} error-severity diagnostic(s) on known-good corpus code`);
  else console.log('  No error-severity diagnostics on known-good code.');

  // Warnings are also assertions of a defect, so known-good code must not raise them
  // either. Hints about naming clarity are fine and expected.
  const warnTotal = [...byCode].filter(([k]) => k !== 'control-name-mismatch').reduce((a, [, v]) => a + v, 0);
  if (warnTotal) failures.push(`${warnTotal} warning-severity diagnostic(s) on known-good corpus code`);
}

if (failures.length) {
  console.log(`\n${failures.length} failure(s).`);
  process.exit(1);
}
console.log('\nAll diagnostic assertions passed.');
