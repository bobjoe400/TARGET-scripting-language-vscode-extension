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

// --- the compile timeout must always settle -------------------------------
// Interpreter.exe is a Windows process; under WSL it reaches us through the interop
// layer, where a SIGTERM can simply be declined. When that happened the promise never
// resolved: the progress notification stayed up forever and every later compile queued
// behind it. These run without TARGET installed, so they are checked before the skip.
async function timeoutCase(label, argv, maxMs, why) {
  const t0 = Date.now();
  const res = await R.runToolForTests(process.execPath, argv, tmpdirForTimeouts, 300);
  const ms = Date.now() - t0;
  if (!res.timedOut) return failures.push(`${label}: expected timedOut`);
  if (ms > maxMs) return failures.push(`${label}: settled after ${ms}ms, over ${maxMs}ms`);
  pass++;
  console.log(`  ok    ${label} (${ms}ms, ${why})`);
}

const tmpdirForTimeouts = fs.mkdtempSync(path.join(os.tmpdir(), 'target-timeout-test-'));
// Ignores SIGTERM. Only the forced kill ends it.
await timeoutCase(
  'a child that ignores SIGTERM is still killed',
  ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'],
  4000,
  'forced kill'
);
// Ignores SIGTERM and leaves a grandchild holding the output pipe open, so "close"
// never fires even after the forced kill - the last-resort timer has to answer.
await timeoutCase(
  'a child whose output pipe outlives it still answers',
  [
    '-e',
    'const { spawn } = require("child_process");' +
      'spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: ["ignore", 1, 2], detached: true }).unref();' +
      'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);',
  ],
  8000,
  'last resort'
);
fs.rmSync(tmpdirForTimeouts, { recursive: true, force: true });

// --- the staging root must stay inside the project ------------------------
// Every script starts with `include "target.tmh"`, so the installed headers are in
// every closure. Letting them vote on the common ancestor pulled the staging root up
// to the drive root, where on Windows it rejoined as the drive-RELATIVE string "C:" -
// the project was then not staged at all and the compiler reported a phantom
// "File not found" on a script that builds.
function stageRootCase(label, projectDir, closure, expected) {
  const got = R.stageRootFor(projectDir, closure, R.findInstall());
  if (got !== expected) return failures.push(`${label}: stage root ${got}, expected ${expected}`);
  pass++;
  console.log(`  ok    ${label}`);
}

{
  const inst = R.findInstall();
  const header = inst ? path.join(inst.scripts, 'target.tmh') : null;
  const proj = path.join(path.sep === '\\' ? 'C:\\p' : '/p', 'proj');
  const sib = path.join(path.dirname(proj), 'common');
  if (header) {
    stageRootCase('an installed header does not widen the staging root', proj, [header, path.join(proj, 'x.tmc')], proj);
    stageRootCase(
      'a sibling folder in the closure still widens it',
      proj,
      [header, path.join(sib, 'lib.tmh')],
      path.dirname(proj)
    );
  }
  stageRootCase('a root is never the staging root', proj, [path.join(path.parse(proj).root, 'elsewhere', 'a.tmh')], proj);
  stageRootCase('the home directory is never the staging root', path.join(os.homedir(), 'proj'), [path.join(os.homedir(), 'other', 'a.tmh')], path.join(os.homedir(), 'proj'));
}

// --- a launch that fails must be reported as one ---------------------------
// spawn signals a launch failure by emitting 'error' on a later tick, so the try/catch
// around it never saw one: runScript returned ok for a process that never started, and
// the unhandled event crashed the extension host. An uncaught exception here fails the
// test process outright, which is the assertion.
{
  const bad = { root: '/nope', scripts: '/nope/scripts', targetGui: '/nonexistent/TARGETGUI.exe', interpreter: null };
  const r = await R.runScript('/tmp/x.tmc', bad);
  if (r.ok) failures.push('a missing TARGETGUI.exe: expected ok=false');
  else if (!/could not be started/i.test(r.error ?? '')) failures.push(`a missing TARGETGUI.exe: unhelpful error ${r.error}`);
  else {
    pass++;
    console.log('  ok    a launch that cannot start is reported, not announced');
  }
  // And a launch that does start still returns promptly rather than waiting on a timer.
  const inst = R.findInstall();
  if (inst) {
    const t0 = Date.now();
    const good = await R.runScript('/tmp/x.tmc', { ...inst, targetGui: process.execPath });
    const ms = Date.now() - t0;
    if (!good.ok) failures.push(`a launchable exe: expected ok, got ${good.error}`);
    else if (ms > 1000) failures.push(`a launchable exe: took ${ms}ms`);
    else {
      pass++;
      console.log(`  ok    a launch that starts returns at once (${ms}ms)`);
    }
  }
}

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

// TARGET resolves includes from the working directory, subfolders included, so a flat
// staging copy turned a working project into "File not found".
{
  const sub = path.join(tmp, 'sub');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, 'helper.tmh'), 'int subHelper(int a) { return a; }\n');
  const f = path.join(tmp, 'withsub.tmc');
  fs.writeFileSync(f, 'include "target.tmh"\ninclude "sub/helper.tmh"\nint main() { return subHelper(1); }\n');
  const r = await R.compileCheck(f, install);
  if (r.ok) { pass++; console.log('  ok    a project with headers in a subfolder compiles'); }
  else failures.push(`subfolder include: ${r.problems.map((p) => p.message).join(' | ')}`);
  fs.rmSync(sub, { recursive: true, force: true });
  fs.rmSync(f, { force: true });
}

// The shipped snippets must emit code the compiler accepts. A bare assignment at file
// scope does not: TARGET wants a declaration there and says only "Type required".
{
  const snippets = JSON.parse(fs.readFileSync(path.join(repoRoot, 'snippets/target.json'), 'utf8'));
  const expand = (body) =>
    body
      .join('\n')
      .replace(/\$\{\d+\|([^,}]+)[^}]*\}/g, '$1')
      .replace(/\$\{\d+:([^}]*)\}/g, '$1')
      .replace(/\$\{\d+\}|\$\d+/g, '');
  for (const name of ['Script scaffold', 'Reusable event']) {
    const snip = snippets[name];
    if (!snip) { failures.push(`snippet "${name}" is missing`); continue; }
    let body = expand(snip.body);
    if (!/include\s+"target\.tmh"/.test(body)) body = 'include "target.tmh"\n' + body;
    const f = path.join(tmp, 'snip.tmc');
    fs.writeFileSync(f, body + '\n');
    const r = await R.compileCheck(f, install);
    if (r.ok) { pass++; console.log(`  ok    the "${name}" snippet compiles`); }
    else failures.push(`snippet "${name}": ${r.problems.map((p) => p.message).join(' | ')}`);
    fs.rmSync(f, { force: true });
  }
}

// Includes reaching outside the script's own folder - a shared library a level up -
// were dropped by staging, so the checker reported "File not found" on a project the
// real compiler builds.
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parent-inc-'));
  fs.mkdirSync(path.join(root, 'proj'));
  fs.mkdirSync(path.join(root, 'common'));
  fs.writeFileSync(path.join(root, 'common', 'helper.tmh'), 'int helperFn(int a) { return a; }\n');
  const entry = path.join(root, 'proj', 'x.tmc');
  fs.writeFileSync(entry, 'include "target.tmh"\ninclude "../common/helper.tmh"\nint main() { return helperFn(1); }\n');
  const r = await R.compileCheck(entry, install, {
    closureFiles: [entry, path.join(root, 'common', 'helper.tmh')],
  });
  if (r.ok) { pass++; console.log('  ok    an include from a parent folder compiles'); }
  else failures.push(`parent include: ${r.problems.map((p) => p.message).join(' | ')}`);
  fs.rmSync(root, { recursive: true, force: true });
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
