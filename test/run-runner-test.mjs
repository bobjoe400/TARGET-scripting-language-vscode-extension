// Exercises the real TARGET toolchain. Skips cleanly where TARGET is not installed,
// so the suite still runs on a machine without the hardware software.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const R = require(path.join(repoRoot, 'out/runner.js'));

let pass = 0;
const failures = [];

console.log('Toolchain integration');
console.log('---------------------');
console.log(`  host: ${R.detectHost()}`);

const install = R.findInstall();
if (!install) {
  console.log('  TARGET is not installed here - skipping (not a failure).');
  process.exit(0);
}
console.log(`  install    : ${install.root}`);
console.log(`  TARGETGUI  : ${install.targetGui ? 'found' : 'MISSING'}`);
console.log(`  Interpreter: ${install.interpreter ? 'found' : 'MISSING'}`);
if (!install.interpreter) {
  console.log('  Interpreter.exe missing - cannot compile-check. Skipping.');
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'target-runner-test-'));
const write = (name, body) => fs.writeFileSync(path.join(tmp, name), body);

async function check(label, files, entry, assert) {
  for (const [n, b] of Object.entries(files)) write(n, b);
  const res = await R.compileCheck(path.join(tmp, entry), install);
  const problem = assert(res);
  if (problem) failures.push(`${label}: ${problem}`);
  else {
    pass++;
    console.log(`  ok    ${label}`);
  }
  for (const n of Object.keys(files)) fs.rmSync(path.join(tmp, n), { force: true });
}

// A valid project, including a local header, must compile clean.
await check(
  'valid project compiles',
  {
    'helper.tmh': 'int helperFn(int a)\n{\n\treturn a * 2;\n}\n',
    'good.tmc': 'include "target.tmh"\ninclude "helper.tmh"\n\nint main()\n{\n\tMapKey(&Joystick, TG1, DX1);\n}\n',
  },
  'good.tmc',
  (r) => (r.ok && r.problems.length === 0 ? null : `expected clean, got ok=${r.ok} problems=${JSON.stringify(r.problems)} err=${r.error}`)
);

// A syntax error in the .tmc is reported at the right file and line.
await check(
  'error located in the .tmc',
  { 'bad.tmc': 'include "target.tmh"\n\nint main()\n{\n\tMapKey(&Joystick, TG1 DX1);\n}\n' },
  'bad.tmc',
  (r) => {
    if (r.problems.length !== 1) return `expected 1 problem, got ${r.problems.length}`;
    const p = r.problems[0];
    if (path.basename(p.file) !== 'bad.tmc') return `wrong file: ${p.file}`;
    if (p.line !== 5) return `wrong line: ${p.line} (expected 5)`;
    return null;
  }
);

// An error inside an included header is attributed to that header, not the .tmc.
await check(
  'error located in an included header',
  {
    'broken.tmh': 'int brokenFn(int a)\n{\n\treturn a ** ;\n}\n',
    'main2.tmc': 'include "target.tmh"\ninclude "broken.tmh"\n\nint main()\n{\n\tMapKey(&Joystick, TG1, DX1);\n}\n',
  },
  'main2.tmc',
  (r) => {
    if (r.problems.length !== 1) return `expected 1 problem, got ${r.problems.length}`;
    const p = r.problems[0];
    if (path.basename(p.file) !== 'broken.tmh') return `wrong file: ${path.basename(p.file)}`;
    if (p.line !== 3) return `wrong line: ${p.line} (expected 3)`;
    return null;
  }
);

// A missing include must be reported rather than silently producing a clean result.
await check(
  'missing include reported',
  { 'missing.tmc': 'include "target.tmh"\ninclude "nope.tmh"\n\nint main() { }\n' },
  'missing.tmc',
  (r) => (r.problems.some((p) => /not found/i.test(p.message)) ? null : `expected a file-not-found problem, got ${JSON.stringify(r.problems)}`)
);

// A byte-order mark makes the compiler fail on line 1 with "Type required", which
// says nothing about the cause. Thrustmaster's own editor writes UTF-16, so this is
// easy to hit.
{
  const f = path.join(tmp, 'bom.tmc');
  fs.writeFileSync(f, '\ufeff' + 'include "target.tmh"\nint main() { return 0; }\n', 'utf8');
  const r = await R.compileCheck(f, install);
  if (r.problems.some((p) => /byte-order mark/i.test(p.message))) {
    pass++;
    console.log('  ok    a byte-order mark is reported as such, not as "Type required"');
  } else {
    failures.push(`bom: ${r.problems.map((p) => p.message).join(' | ') || 'no problems reported'}`);
  }
  fs.rmSync(f, { force: true });
}

// A file with no BOM must not be accused of having one.
{
  const f = path.join(tmp, 'nobom.tmc');
  fs.writeFileSync(f, 'include "target.tmh"\nint main() { MapKey(&Joystick, TG1 DX1); }\n');
  const r = await R.compileCheck(f, install);
  if (!r.problems.some((p) => /byte-order mark/i.test(p.message))) {
    pass++;
    console.log('  ok    a plain file is not accused of a byte-order mark');
  } else failures.push('bom false positive on a plain file');
  fs.rmSync(f, { force: true });
}

// LIST builds curve coordinates, not AXMAP2 zones, and must compile clean.
{
  const f = path.join(tmp, 'curve.tmc');
  fs.writeFileSync(f, 'include "target.tmh"\nint main() { SetCustomCurve(&Joystick, JOYX, LIST(10,0, 50,50, 100,100)); }\n');
  const r = await R.compileCheck(f, install);
  if (r.ok) { pass++; console.log('  ok    a non-origin LIST curve compiles (the real compiler accepts it)'); }
  else failures.push(`LIST curve: ${r.problems.map((p) => p.message).join(' | ')}`);
  fs.rmSync(f, { force: true });
}

// The real corpus, if it is on this machine, must still compile.
const realProject = 'C:\\Thrustmaster\\ED_TargetScript_T16000\\ScriptFiles\\ED_ENHANCED_T16000.tmc';
const realWsl = '/mnt/c/Thrustmaster/ED_TargetScript_T16000/ScriptFiles/ED_ENHANCED_T16000.tmc';
const real = [realProject, realWsl].find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
if (real) {
  const t0 = Date.now();
  const r = await R.compileCheck(real, install);
  if (r.ok && r.problems.length === 0) {
    pass++;
    console.log(`  ok    real ED script compiles clean (${Date.now() - t0}ms)`);
  } else {
    failures.push(`real ED script: ok=${r.ok} problems=${JSON.stringify(r.problems)} err=${r.error}`);
  }
}

fs.rmSync(tmp, { recursive: true, force: true });

for (const f of failures) console.log(`  FAIL  ${f}`);
console.log(`\n  ${pass}/${pass + failures.length} toolchain assertions passed`);
if (failures.length) process.exit(1);
console.log('\nAll toolchain assertions passed.');
