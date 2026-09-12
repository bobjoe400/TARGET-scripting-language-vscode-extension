// Exercises the command layer through activate(), because the "which file does this
// act on" logic is where a real bug shipped: relying on activeTextEditor alone made
// the commands refuse to run whenever the active tab was not a text editor (the
// extension details page, a settings tab, a diff).
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const stub = require('./vscode-stub.cjs');
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return stub;
  return origLoad.call(this, request, parent, isMain);
};

const { FakeDocument } = require('./fake-document.cjs');
const { activate } = require(path.join(repoRoot, 'out/extension.js'));
const R = require(path.join(repoRoot, 'out/runner.js'));

let pass = 0;
const failures = [];

const context = { subscriptions: [] };
activate(context);
const commands = stub.__recorded.commands;

console.log('Command layer');
console.log('-------------');
for (const id of ['targetScript.compile', 'targetScript.run', 'targetScript.stop']) {
  if (commands.has(id)) { pass++; console.log(`  ok    ${id} registered`); }
  else failures.push(`${id} was not registered`);
}

const FIX = path.join(repoRoot, 'test/fixtures');
const entry = path.join(FIX, 'ED_ENHANCED_T16000.tmc');
const mkDoc = (p) => new FakeDocument(p, fs.readFileSync(p, 'utf8'));

const noScriptError = () =>
  stub.__recorded.errors.find((e) => typeof e === 'string' && /No TARGET script is open/i.test(e));

// The regression: no active text editor, but the script is open in the background.
{
  stub.__reset();
  stub.workspace.textDocuments = [mkDoc(entry)];
  stub.window.activeTextEditor = undefined;   // e.g. the extension details tab is active
  await commands.get('targetScript.compile')();
  if (noScriptError()) failures.push('compile refused to run with no active text editor, though a script was open');
  else { pass++; console.log('  ok    compile resolves the script with no active text editor'); }
}

// Invoked from the editor title bar, which passes the resource URI.
{
  stub.__reset();
  stub.workspace.textDocuments = [mkDoc(entry)];
  stub.window.activeTextEditor = undefined;
  await commands.get('targetScript.compile')(stub.Uri.file(entry));
  if (noScriptError()) failures.push('compile ignored the resource URI passed by the title-bar button');
  else { pass++; console.log('  ok    compile honours the title-bar resource URI'); }
}

// A visible editor is enough even when none is focused.
{
  stub.__reset();
  const doc = mkDoc(entry);
  stub.workspace.textDocuments = [doc];
  stub.window.visibleTextEditors = [{ document: doc }];
  stub.window.activeTextEditor = undefined;
  await commands.get('targetScript.compile')();
  if (noScriptError()) failures.push('compile ignored a visible (unfocused) editor');
  else { pass++; console.log('  ok    compile falls back to a visible editor'); }
}

// With genuinely nothing open, the error is still correct.
{
  stub.__reset();
  await commands.get('targetScript.compile')();
  if (noScriptError()) { pass++; console.log('  ok    compile reports clearly when nothing is open'); }
  else failures.push(`expected a "no script open" error, got ${JSON.stringify(stub.__recorded.errors)}`);
}

// A header resolves to the .tmc beside it rather than being compiled alone.
{
  const header = path.join(FIX, 'ED_Functions.tmh');
  const { entry: resolved, candidates } = R.resolveEntryScript(header);
  // The fixtures folder holds two .tmc files, so this must ask rather than guess.
  if (candidates.length > 1 && resolved === null) {
    pass++;
    console.log(`  ok    header with ${candidates.length} sibling .tmc files asks which to use`);
  } else if (candidates.length === 1 && resolved === candidates[0]) {
    pass++;
    console.log('  ok    header resolves to its single sibling .tmc');
  } else {
    failures.push(`resolveEntryScript on a header: entry=${resolved} candidates=${candidates.length}`);
  }
}

// ---- TARGET's host applications are mutually exclusive ----------------------
// TARGETGUI refuses to start while TARGET Script Editor is open and says so in its
// own modal. Because the GUI is launched detached, that refusal is invisible here, so
// the conflict must be caught before launching rather than reported as success.
{
  const runner = require(path.join(repoRoot, 'out/runner.js'));
  const realList = runner.listTargetProcesses;
  const realKill = runner.killImage;

  const withFakeProcs = async (procs, answer) => {
    stub.__reset();
    stub.workspace.textDocuments = [mkDoc(entry)];
    stub.__setWarningAnswer(answer);
    runner.listTargetProcesses = async () => procs;
    let killed = null;
    runner.killImage = async (img) => { killed = img; return { ok: true }; };
    await commands.get('targetScript.run')();
    return { killed, warnings: stub.__recorded.warnings, infos: stub.__recorded.infos };
  };

  let r = await withFakeProcs({ gui: false, editor: true }, 'Cancel');
  if (r.warnings.some((w) => /Script Editor is open/i.test(w)) && r.killed === null && r.infos.length === 0) {
    pass++;
    console.log('  ok    run warns about the Script Editor and cancels cleanly');
  } else {
    failures.push(`editor-conflict cancel: warnings=${JSON.stringify(r.warnings)} killed=${r.killed}`);
  }

  r = await withFakeProcs({ gui: false, editor: true }, 'Close Editor and Run');
  if (r.killed === runner.TARGET_IMAGES.editor) {
    pass++;
    console.log('  ok    run closes the Script Editor when told to');
  } else {
    failures.push(`editor-conflict accept: expected to close ${runner.TARGET_IMAGES.editor}, killed=${r.killed}`);
  }

  r = await withFakeProcs({ gui: true, editor: false }, 'Cancel');
  if (r.warnings.some((w) => /already running/i.test(w)) && r.infos.length === 0) {
    pass++;
    console.log('  ok    run offers to restart when TARGET is already running');
  } else {
    failures.push(`gui-already-running: warnings=${JSON.stringify(r.warnings)}`);
  }

  runner.listTargetProcesses = realList;
  runner.killImage = realKill;
}

for (const f of failures) console.log(`  FAIL  ${f}`);
console.log(`\n  ${pass}/${pass + failures.length} command assertions passed`);
if (failures.length) process.exit(1);
console.log('\nAll command assertions passed.');
