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

/**
 * Runs with a symbol table built from the snippet itself, which is what enables the
 * checks that depend on knowing every declared name.
 */
const runFull = (src, name = 'test.tmc', extraSymbols = []) => {
  const model = buildModel(src);
  const symbols = new Set(model.decls.map((d) => d.name));
  for (const e of extraSymbols) symbols.add(e);
  return computeDiagnostics(model, name, {
    aliasBindings: collectAliasBindings(model),
    knownSymbols: symbols,
    closureComplete: true,
    // Only an entry script has the whole project in view, so the checks that need a
    // complete symbol table run there.
    isEntryScript: name.toLowerCase().endsWith('.tmc'),
  });
};

function expectFull(label, src, code, name = 'test.tmc', extraSymbols = []) {
  const ds = runFull(src, name, extraSymbols);
  if (ds.some((d) => d.code === code)) { pass++; return; }
  failures.push(`${label}: expected code "${code}", got [${ds.map((d) => d.code).join(', ') || 'none'}]`);
}

function expectFullClean(label, src, name = 'test.tmc', extraSymbols = []) {
  const ds = runFull(src, name, extraSymbols);
  if (ds.length === 0) { pass++; return; }
  failures.push(`${label}: expected no diagnostics, got ${ds.map((d) => `${d.code}: ${d.message.split('\n')[0]}`).join(' | ')}`);
}

/** The skeleton TARGET's own CodeStart.template produces. */
const SKELETON = [
  'include "target.tmh"',
  '',
  'int main()',
  '{',
  '\tif(Init(&EventHandle)) return 1;',
  '}',
  '',
  'int EventHandle(int type, alias o, int x)',
  '{',
  '\tDefaultMapping(&o, x);',
  '}',
  '',
].join('\n');

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
// Thrustmaster's manual forbids this, their own shipped samples do it, and it
// compiles - so it is a hint that names the disagreement, not an error.
expect('SetCustomCurve in EXEC is disputed', 'int f() { MapKey(&Joystick, S1, EXEC("SetCustomCurve(&Joystick, JOYX, 0);")); }', 'disputed-in-exec');
expect('EXEC second argument is checked too', 'int f() { MapKey(&Joystick, S1, EXEC("a();", "SEQ(x,y);")); }', 'forbidden-in-exec');
expectClean('single-token define is a value',  'define ZOOM(DX5)\nint f() { return ZOOM; }');
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

// -- C syntax the TARGET parser rejects, each confirmed against the real compiler --
expect('i++',            'int f() { int i; i++; }', 'not-in-target');
expect('++i',            'int f() { int i; ++i; }', 'not-in-target');
expect('i--',            'int f() { int i; i--; }', 'not-in-target');
expect('+= compound',    'int f() { int i; i += 1; }', 'not-in-target');
expect('|= compound',    'int f() { int i; i |= 1; }', 'not-in-target');
expect('<<= compound',   'int f() { int i; i <<= 1; }', 'not-in-target');
expect('|| logical or',  'int f() { int i; if(i == 1 || i == 2) i = 3; }', 'not-in-target');
expect('ternary',        'int f() { int i; i = i ? 1 : 0; }', 'not-in-target');
expect('#define',        '#define X 5\nint f() { return X; }', 'not-in-target');
expect('#include',       '#include "target.tmh"\nint f() { return 0; }', 'not-in-target');
expect('angle include',  'include <stdint.h>\nint f() { return 0; }', 'not-in-target');

// ...and the equivalents TARGET does accept must stay silent.
expectClean('i = i + 1',        'int f() { int i; i = i + 1; }');
expectClean('& as logical and', 'int f() { int i; if(i == 1 & i != 2) i = 3; }');
expectClean('| as logical or',  'int f() { int i; if(i == 1 | i == 2) i = 3; }');
expectClean('bitwise shifts',   'int f() { int i; i = i << 1; i = i >> 1; }');
expectClean('comparisons',      'int f() { int i; if(i == 1) i = 2; if(i != 1) i = 3; if(i <= 4) i = 5; if(i >= 6) i = 7; }');
// && is address-of-address in TARGET, not logical and, and is used in target.tmh.
expectClean('&& address-of-address', 'int f() { int tmp; ASMAlloc(1, &&tmp, &tmp); }');
expectClean('unary minus and not',   'int f() { int i; int j; i = -j; i = !j; }');
expectClean('quoted include',        'include "target.tmh"\nint f() { return 0; }');

// -- declaration forms the TARGET parser rejects --------------------------------
expect('function-like define', 'define ADD(a,b) a+b\nint f() { return ADD(1,2); }', 'not-in-target');
expect('return with no value',  'int f() { return; }', 'not-in-target');
expect('redeclaring a builtin', 'int MapKey(int a) { return a; }', 'redefines-builtin');
expect('redeclaring a device',  'int Joystick;', 'redefines-builtin');
expect('statement at file scope', 'include "target.tmh"\nMapKey(&Joystick, TG1, DX1);\nint main() { return 0; }', 'statement-at-file-scope', 'm.tmc');
// ...and the legal forms next to them must stay silent.
expectClean('parenthesised define value', 'define MYVAL (1+2)\nint f() { return MYVAL; }');
expectClean('return with a value',        'int f() { return 0; }');
// A define may shadow a builtin: separate namespace, and the corpus depends on it.
expectClean('define shadowing a builtin', 'define SET 1\nint f() { return SET; }');
expectClean('global initialised by call', 'int fnH() { return 1; }\nint g = fnH();\nint f() { return g; }');
expectClean('call inside a function',     'int f() { MapKey(&Joystick, TG1, DX1); }');

// A call in a variable initialiser is still a call. The declaration parser consumes
// those tokens, so they were invisible to every check keyed on the call list.
expect('range check inside an initialiser', 'int q = SetSCurve(&Joystick, JOYX, 0, 0, 0, 999, 0);', 'range');
expect('arity check inside an initialiser', 'int q = MapKey(&Joystick);', 'arity');
expectClean('a valid initialiser call',     'int q = SetSCurve(&Joystick, JOYX, 0, 0, 0, 5, 0);');

// Identifiers come straight from user source, so a name that collides with
// Object.prototype must not reach it. These threw out of computeDiagnostics, which
// runs during activate() and took the command registrations down with it.
for (const name of ['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__']) {
  try {
    run(`int main() { ${name}(1); return 0; }`, 'm.tmc');
    pass++;
  } catch (e) {
    failures.push(`prototype key "${name}": ${e.message}`);
  }
}

// A declaration's initialiser is not a statement, however it is wrapped. Asserted
// against the specific rule, since a bare .tmc legitimately reports missing main().
function expectNotCode(label, src, code, name = 'test.tmh') {
  const ds = run(src, name);
  if (!ds.some((d) => d.code === code)) { pass++; return; }
  failures.push(`${label}: expected no "${code}", got ${ds.filter((d) => d.code === code).map((d) => d.message.split('\n')[0]).join(' | ')}`);
}
expectNotCode('initialiser wrapped after =', 'int q =\n    fnDbl(21);\n', 'statement-at-file-scope', 'm.tmc');
expectNotCode('nested call starting a line', 'int q = fnAdd(1, 2,\n    fnDbl(3));\n', 'statement-at-file-scope', 'm.tmc');
expect('a real file-scope statement still flags',
  'include "target.tmh"\nMapKey(&Joystick, TG1, DX1);\nint main() { return 0; }', 'statement-at-file-scope', 'm.tmc');

// -- the DirectX button ceiling, where the sources disagree ---------------------
expect('DX40 needs the newer data format', 'int f() { MapKey(&Joystick, TG1, DX40); }', 'directx-button-ceiling');
expect('DX120 is the last real button',     'int f() { MapKey(&Joystick, TG1, DX120); }', 'directx-button-ceiling');
expect('DX121 has no button behind it',     'int f() { MapKey(&Joystick, TG1, DX121); }', 'directx-button-ceiling');
expect('DX128 has no button behind it',     'int f() { MapKey(&Joystick, TG1, DX128); }', 'directx-button-ceiling');
expectClean('DX32 is at the limit', 'int f() { MapKey(&Joystick, TG1, DX32); }');
expectClean('DX11 well under',      'int f() { MapKey(&Joystick, TG1, DX11); }');

// -- structure a runnable script needs, none of which TARGET's compiler checks --
expectFull('no main()',            'include "target.tmh"\n\nint helper(int a) { return a; }\n', 'missing-main');
expectFull('main without Init()',  'include "target.tmh"\n\nint main()\n{\n\tMapKey(&Joystick, TG1, DX1);\n}\n', 'missing-init');
expectFull('undefined handler',    'include "target.tmh"\n\nint main()\n{\n\tif(Init(&NoSuchHandler)) return 1;\n}\n', 'undefined-event-handler');
expectFull('handler without DefaultMapping',
  'include "target.tmh"\n\nint main()\n{\n\tif(Init(&EventHandle)) return 1;\n}\n\nint EventHandle(int type, alias o, int x)\n{\n}\n',
  'handler-missing-defaultmapping');
expectFull('call to an undefined function',
  SKELETON + '\nint other()\n{\n\tfnNeverDefined(1);\n}\n', 'unknown-function', 'test.tmc');
// A header analysed on its own is missing the rest of the project, so the check that
// needs a complete symbol table must stay quiet there.
expectFullClean('a header alone is not checked for unknown calls',
  'int other()\n{\n\tfnDefinedElsewhere(1);\n}\n', 'helpers.tmh');
// A header is not an entry point, so the structural rules must not apply to it.
expectFullClean('header needs no main', 'int helperFn(int a)\n{\n\treturn a * 2;\n}\n', 'helpers.tmh');
// A name declared in an included file is not unknown.
expectFullClean('function from an include is known',
  SKELETON + '\nint other()\n{\n\tfnFromHeader(1);\n}\n', 'test.tmc', ['fnFromHeader']);

// -- things that must NOT be flagged ------------------------------------------
expectClean('valid MapKey',        'int f() { MapKey(&Joystick, TG1, 0); }');
expectClean('valid full MapKey',   'int f() { MapKeyIOUMD(&Joystick, TG1, 0,0,0,0,0,0); }');
expectClean('optional args left off','int f() { MapKey(&Joystick, TG1); }');
expectClean('valid EXEC',          'int f() { MapKey(&Joystick, S1, EXEC("fnFoo(1);")); }');
expectClean('EXEC nested string',  'int f() { MapKey(&Joystick, S1, EXEC("fnVPOutput(\\"not used\\");")); }');
expectClean('valid REXEC',         'int f() { REXEC(0, 500, "fnFoo();", RNOSTOP); }');
expectClean('valid AXMAP2',        'int f() { AXMAP2(2, a, b); }');
// `define LIST AXMAP2` makes them one function, but LIST is called with curve
// coordinate pairs, so the zone rule must not apply to it.
expectClean('LIST curve coordinates', 'int f() { SetCustomCurve(&Joystick, JOYX, LIST(10,0, 50,50, 100,100)); }');
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
expectFullClean('complete skeleton', SKELETON);
expectClean('SetSCurve valid',     'int f() { SetSCurve(&Joystick, JOYX, 0, 0, 0, 5, 0); }');
expectClean('negative curve ok',   'int f() { SetSCurve(&Joystick, JOYX, 0, 0, 0, -20, 0); }');
expectClean('TrimDXAxis w/ CURRENT','int f() { TrimDXAxis(DX_X_AXIS, CURRENT); }');

// --- keys the game does nothing with (opt-in) ------------------------------
// Off unless asked for: the answer depends on which preset the game has loaded and
// which .binds files are on this disk, so the same project reports differently on
// another machine. An unrecognised modifier is NOT reported as unbound - that chord is
// unknown, not empty, and it has its own report.
{
  const src = 'define A  L_ALT+USB[0x4F]\ndefine B  USB[0x4F]\ndefine C  L_BOGUS+USB[0x4F]\n';
  const model = buildModel(src);
  const bound = (code, mods) => (code === '4F' ? mods.length === 1 && mods[0] === 'L_ALT' : null);

  const off = computeDiagnostics(model, 'x.tmh', {});
  if (!off.some((d) => d.code === 'unbound-key')) {
    pass++; console.log('  ok    unbound keys are silent unless asked for');
  } else failures.push('unbound-key fired with no lookup supplied');

  const on = computeDiagnostics(model, 'x.tmh', { isChordBound: bound }).filter((d) => d.code === 'unbound-key');
  const msgs = on.map((d) => d.message);
  // The key by name, not its scancode: "Right Arrow" over "0x4F".
  if (on.length === 1 && /Right Arrow/.test(msgs[0]) && on[0].severity === 'info') {
    pass++; console.log('  ok    only the chord the game ignores is reported, as information');
  } else failures.push(`unbound-key: ${on.length} -> ${JSON.stringify(msgs)}`);

  // The whole chord is underlined. Marking only the scancode pointed at half of what
  // is wrong - and the modifier is the half more likely to be the mistake.
  {
    const src2 = 'define B  L_SHIFT+USB[0x4F]\n';
    const only = computeDiagnostics(buildModel(src2), 'x.tmh', { isChordBound: () => false })
      .filter((d) => d.code === 'unbound-key');
    const span = only.length === 1 ? src2.slice(only[0].start, only[0].end) : '';
    if (span === 'L_SHIFT+USB[0x4F]') {
      pass++; console.log('  ok    the whole chord is underlined, not just the scancode');
    } else failures.push(`unbound-key range: ${JSON.stringify(span)}`);
  }

  // Nothing to compare against must not read as "bound to nothing".
  const noData = computeDiagnostics(model, 'x.tmh', { isChordBound: () => null }).filter((d) => d.code === 'unbound-key');
  if (noData.length === 0) {
    pass++; console.log('  ok    no binding files means no answer, not a wrong one');
  } else failures.push(`unbound-key with no data: ${noData.length}`);
}

for (const f of failures) console.log(`  FAIL  ${f}`);
console.log(`  ${pass}/${pass + failures.length} rule assertions passed`);

// -- the corpus must stay clean ------------------------------------------------
const corpusDir = process.env.TARGET_CORPUS || path.join(repoRoot, 'test/fixtures');
if (fs.existsSync(corpusDir)) {
  // DEMO.tmc is deliberately broken and is checked separately, below.
  const files = fs
    .readdirSync(corpusDir)
    .filter((f) => /\.(tmc|tmh|ttm)$/i.test(f) && f !== 'DEMO.tmc');
  console.log(`\nCorpus false-positive check (${files.length} known-good files)`);
  console.log('----------------');
  const byCode = new Map();
  let errors = 0;

  // The corpus binds its device handles in one file and uses them in another, so the
  // bindings are merged across the whole set the way the include closure does.
  const corpusBindings = new Map();
  const models = new Map();
  // The corpus includes target.tmh, so the TARGET headers are part of its symbol
  // table too; without them every builtin-adjacent name would look undefined.
  const corpusSymbols = new Set();
  const headerDir = '/mnt/c/Program Files (x86)/Thrustmaster/TARGET/scripts';
  const extraFiles = [];
  if (fs.existsSync(headerDir)) {
    for (const h of ['target.tmh', 'defines.tmh', 'hid.tmh', 'sys.tmh']) {
      const p2 = path.join(headerDir, h);
      if (fs.existsSync(p2)) extraFiles.push(p2);
    }
  }
  for (const f of [...files.map((f) => path.join(corpusDir, f)), ...extraFiles]) {
    const model = buildModel(decode(fs.readFileSync(f)));
    for (const d of model.decls) corpusSymbols.add(d.name);
  }
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
    const ds = computeDiagnostics(model, f, {
      aliasBindings: corpusBindings,
      knownSymbols: corpusSymbols,
      closureComplete: true,
    });
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

  // Every fixture in this repo is LF, while real TARGET files are CRLF - the vendor
  // headers are, and so is anything Thrustmaster's own editor writes. That gap hid a
  // bound that never matched on CRLF, so the corpus is swept in both forms.
  console.log('\n  ...and again with CRLF line endings');
  let crlfNoise = 0;
  for (const f of files) {
    const text = decode(fs.readFileSync(path.join(corpusDir, f))).replace(/\r?\n/g, '\r\n');
    const ds = computeDiagnostics(buildModel(text), f, {
      aliasBindings: corpusBindings,
      knownSymbols: corpusSymbols,
      closureComplete: true,
      isEntryScript: f.toLowerCase().endsWith('.tmc'),
    }).filter((d) => d.severity === 'error' || d.severity === 'warning');
    if (ds.length) {
      crlfNoise += ds.length;
      console.log(`  NOISE ${f.padEnd(26)} ${ds.slice(0, 3).map((d) => d.code).join(', ')}`);
    }
  }
  if (crlfNoise === 0) console.log(`  ok    all ${files.length} known-good files stay clean as CRLF too`);
  else failures.push(`${crlfNoise} diagnostics on known-good code once converted to CRLF`);

}

// -- the demo file must keep demonstrating what it claims to ------------------
const demoPath = path.join(corpusDir, 'DEMO.tmc');
if (fs.existsSync(demoPath)) {
  console.log('\nDemo file (deliberately broken)');
  console.log('----------------');
  const text = decode(fs.readFileSync(demoPath));
  const model = buildModel(text);
  const ds = computeDiagnostics(model, 'DEMO.tmc', { aliasBindings: collectAliasBindings(model) });
  const codes = new Set(ds.map((d) => d.code));
  const wanted = [
    'not-in-target', 'arity', 'wrong-device-control', 'control-name-mismatch',
    'rexec-handle', 'forbidden-in-exec', 'range', 'axmap2-zones',
  ];
  for (const w of wanted) {
    if (codes.has(w)) pass++;
    else failures.push(`DEMO.tmc no longer demonstrates "${w}"`);
  }
  console.log(`  ${ds.length} diagnostics, codes: ${[...codes].join(', ')}`);
  // The lines marked correct in the demo must stay unflagged.
  const flaggedLines = new Set(ds.map((d) => text.slice(0, d.start).split('\n').length));
  const correctSection = text.split('\n').slice(13, 21);
  let leaked = 0;
  correctSection.forEach((_, i) => { if (flaggedLines.has(14 + i)) leaked++; });
  if (leaked) failures.push(`${leaked} diagnostic(s) on the lines DEMO.tmc marks as correct`);
  else { pass++; console.log('  none of the lines marked correct are flagged'); }
}

if (failures.length) {
  console.log(`\n${failures.length} failure(s).`);
  process.exit(1);
}
console.log('\nAll diagnostic assertions passed.');
