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
for (const id of ['targetScript.compile', 'targetScript.run', 'targetScript.stop', 'targetScript.peekBindings']) {
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


// ---- scripts on the WSL filesystem -----------------------------------------
// TARGET cannot load a script through a \\wsl.localhost\ UNC path, so a project that
// is not on a Windows drive must be offered as a staged copy rather than handed over
// and left to fail in TARGET's own window.
{
  const runner = require(path.join(repoRoot, 'out/runner.js'));
  const realProcs = runner.listTargetProcesses;
  const realRun = runner.runScript;
  const realStage = runner.stageProjectForRun;

  const attemptRun = async (scriptPath, answer) => {
    stub.__reset();
    stub.workspace.textDocuments = [mkDoc(scriptPath)];
    stub.__setWarningAnswer(answer);
    runner.listTargetProcesses = async () => ({ gui: false, editor: false });
    let ranWith = null;
    let staged = false;
    runner.runScript = async (p) => { ranWith = p; return { ok: true, command: 'fake' }; };
    runner.stageProjectForRun = async () => {
      staged = true;
      return { ok: true, staging: { entry: 'C:\\staged\\copy.tmc', dir: 'C:\\staged' } };
    };
    await commands.get('targetScript.run')();
    return { ranWith, staged, warnings: stub.__recorded.warnings, infos: stub.__recorded.infos };
  };

  // The repo fixtures live in the Linux filesystem, which is the failing case.
  let r = await attemptRun(entry, 'Cancel');
  if (r.warnings.some((w) => /not on a local Windows drive/i.test(w)) && r.ranWith === null) {
    pass++;
    console.log('  ok    run warns before handing TARGET a WSL path, and cancels');
  } else {
    failures.push(`wsl-path cancel: warnings=${JSON.stringify(r.warnings)} ranWith=${r.ranWith}`);
  }

  r = await attemptRun(entry, 'Copy to Windows and Run');
  if (r.staged && r.ranWith === 'C:\\staged\\copy.tmc' && r.infos.some((i) => /from a copy/i.test(i))) {
    pass++;
    console.log('  ok    run stages to a Windows drive and says it ran a copy');
  } else {
    failures.push(`wsl-path stage: staged=${r.staged} ranWith=${r.ranWith} infos=${JSON.stringify(r.infos)}`);
  }

  // A script already on a Windows drive must be run directly, with no warning.
  const winScript = '/mnt/c/Thrustmaster/ED_TargetScript_T16000/ScriptFiles/ED_ENHANCED_T16000.tmc';
  if (fs.existsSync(winScript)) {
    r = await attemptRun(winScript, 'Cancel');
    if (!r.staged && r.ranWith === winScript && !r.warnings.some((w) => /not on a local Windows drive/i.test(w))) {
      pass++;
      console.log('  ok    a script on a Windows drive runs directly, unstaged');
    } else {
      failures.push(`windows-path: staged=${r.staged} ranWith=${r.ranWith} warnings=${JSON.stringify(r.warnings)}`);
    }
  }

  runner.listTargetProcesses = realProcs;
  runner.runScript = realRun;
  runner.stageProjectForRun = realStage;
}


// ---- the running indicator must track reality ------------------------------
// A notification carrying a button cannot be dismissed programmatically, so it went
// on claiming a script was running after it had stopped. The state lives in a status
// bar item instead, which can be hidden.
{
  const runner = require(path.join(repoRoot, 'out/runner.js'));
  const realProcs = runner.listTargetProcesses;
  const realRun = runner.runScript;
  const realStop = runner.stopScript;
  const realStage = runner.stageProjectForRun;

  runner.listTargetProcesses = async () => ({ gui: false, editor: false });
  runner.runScript = async () => ({ ok: true, command: 'fake' });
  runner.stopScript = async () => ({ ok: true });
  runner.stageProjectForRun = async () => ({ ok: true, staging: { entry: 'C:\\s\\c.tmc', dir: 'C:\\s' } });

  const bar = () => stub.__recorded.statusBarItems.find((i) => String(i.command) === 'targetScript.stop');

  stub.__reset();
  stub.workspace.textDocuments = [mkDoc(entry)];
  stub.__setWarningAnswer('Copy to Windows and Run');
  await commands.get('targetScript.run')();

  const item = bar();
  if (item && item.visible && /TARGET/.test(item.text)) {
    pass++;
    console.log(`  ok    run shows a status bar indicator ("${item.text}")`);
  } else {
    failures.push(`status bar not shown after run: ${JSON.stringify(item)}`);
  }

  // The launch notification must carry no button, or it would never disappear.
  if (stub.__recorded.infos.length === 1) {
    pass++;
    console.log('  ok    launch notification auto-dismisses (no buttons)');
  } else {
    failures.push(`expected exactly one launch notification, got ${stub.__recorded.infos.length}`);
  }

  await commands.get('targetScript.stop')();
  if (item && !item.visible) {
    pass++;
    console.log('  ok    stop hides the indicator');
  } else {
    failures.push('status bar still visible after stop');
  }

  // Stopping the profile from TARGET's own window closes TARGETGUI, so the poll is
  // what clears the indicator in normal use. That path is load-bearing, so it is
  // exercised for real rather than assumed.
  stub.__reset();
  stub.workspace.textDocuments = [mkDoc(entry)];
  stub.__setWarningAnswer('Copy to Windows and Run');
  // TARGETGUI is reported absent throughout: the pre-flight check reads the same
  // function, so "already running" must stay false or the run is refused as a
  // conflict. After launching, an absent TARGETGUI is exactly the Stop Profile case.
  runner.listTargetProcesses = async () => ({ gui: false, editor: false });
  await commands.get('targetScript.run')();
  const polled = bar();
  if (!polled?.visible) {
    failures.push(`indicator was not shown before the poll test (errors=${JSON.stringify(stub.__recorded.errors)} warnings=${JSON.stringify(stub.__recorded.warnings)} infos=${JSON.stringify(stub.__recorded.infos)})`);
  } else {
    // Wait on the condition rather than a fixed sleep, so the test does not need to
    // know the poll interval.
    const deadline = Date.now() + 12000;
    while (polled.visible && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!polled.visible) {
      pass++;
      console.log('  ok    indicator clears itself once TARGET exits (Stop Profile)');
    } else {
      failures.push('indicator still visible 12s after TARGET exited');
    }
  }

  runner.listTargetProcesses = realProcs;
  runner.runScript = realRun;
  runner.stopScript = realStop;
  runner.stageProjectForRun = realStage;
}

// The manifest declares untrustedWorkspaces: "limited", which VS Code does not
// enforce - the extension is loaded normally and has to gate itself. TARGET scripts
// are not inert: the builtin table includes system, LoadLibrary and WriteFile, so
// running a stranger's .tmc runs their code.
{
  const runner = require(path.join(repoRoot, 'out/runner.js'));
  const realRun = runner.runScript;
  let ranWith = null;
  runner.runScript = async (p) => { ranWith = p; return { ok: true, command: 'fake' }; };

  stub.__reset();
  stub.workspace.isTrusted = false;
  stub.workspace.textDocuments = [mkDoc(entry)];
  await commands.get('targetScript.run')();
  const refusedRun = ranWith === null && stub.__recorded.warnings.some((w) => /not trusted/i.test(w));

  stub.__reset();
  stub.workspace.isTrusted = false;
  stub.workspace.textDocuments = [mkDoc(entry)];
  await commands.get('targetScript.compile')();
  const refusedCompile = stub.__recorded.warnings.some((w) => /not trusted/i.test(w));

  stub.workspace.isTrusted = true;
  runner.runScript = realRun;

  if (refusedRun && refusedCompile) {
    pass++;
    console.log('  ok    run and compile refuse to execute in an untrusted workspace');
  } else {
    failures.push(`trust gate: run refused=${refusedRun} compile refused=${refusedCompile}`);
  }
}

// --- peek: every place a key is bound, across games and presets ------------
// The hover answers what this chord does in the active preset; this answers where
// else it is spoken for, so it reads the binding files UNNARROWED. Driven through
// editor.action.peekLocations with real Location objects - a markdown command link
// cannot call that directly, since its arguments arrive as plain JSON.
{
  const bindsDoc = mkDoc(entry);
  stub.__reset();
  stub.workspace.textDocuments = [bindsDoc];
  stub.window.activeTextEditor = { document: bindsDoc, selection: { active: new stub.Position(0, 0) } };

  // 0x18 is bound in the sample .binds; asked for explicitly, as a hover link does.
  await commands.get('targetScript.peekBindings')({ kind: 'key', code: '18' });
  const peek = stub.__recorded.executed.find((e) => e.id === 'editor.action.peekLocations');
  if (peek && Array.isArray(peek.args[2]) && peek.args[2].length >= 1 && peek.args[2][0].uri) {
    pass++;
    console.log(`  ok    peek opens ${peek.args[2].length} location(s) for a bound key`);
  } else {
    failures.push(`peekBindings: ${JSON.stringify(stub.__recorded.executed.map((e) => e.id))}`);
  }

  // An unbound code says so rather than opening an empty peek.
  stub.__reset();
  stub.workspace.textDocuments = [bindsDoc];
  stub.window.activeTextEditor = { document: bindsDoc, selection: { active: new stub.Position(0, 0) } };
  await commands.get('targetScript.peekBindings')({ kind: 'key', code: 'FF' });
  const opened = stub.__recorded.executed.some((e) => e.id === 'editor.action.peekLocations');
  const told = stub.__recorded.infos.some((m) => /not bound|No game binding files/i.test(String(m)));
  if (!opened && told) {
    pass++;
    console.log('  ok    an unbound key is reported, not shown as an empty peek');
  } else {
    failures.push(`unbound peek: opened=${opened} told=${told}`);
  }
}

for (const f of failures) console.log(`  FAIL  ${f}`);
console.log(`\n  ${pass}/${pass + failures.length} command assertions passed`);
if (failures.length) process.exit(1);
console.log('\nAll command assertions passed.');
