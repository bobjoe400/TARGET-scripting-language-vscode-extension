// Drives the real providers against a stubbed editor API, so the behaviour users
// actually see - especially device-aware completion - is verified, not assumed.
import path from 'node:path';
import Module from 'node:module';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

// Route `require('vscode')` to the stub before loading any compiled provider code.
const stub = require('./vscode-stub.cjs');
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return stub;
  return origLoad.call(this, request, parent, isMain);
};

const { FakeDocument } = require('./fake-document.cjs');
const { TargetIndex } = require(path.join(repoRoot, 'out/index.js'));
const {
  TargetCompletionProvider,
  TargetHoverProvider,
  TargetSignatureProvider,
  TargetSymbolProvider,
  TargetDefinitionProvider,
} = require(path.join(repoRoot, 'out/providers.js'));

const index = new TargetIndex();
const completion = new TargetCompletionProvider(index);
const hover = new TargetHoverProvider(index);
const signature = new TargetSignatureProvider(index);
const symbols = new TargetSymbolProvider(index);
const definition = new TargetDefinitionProvider(index);

let pass = 0;
const failures = [];
const ok = (label) => { pass++; };
const fail = (label, msg) => failures.push(`${label}: ${msg}`);

const FIX = path.join(repoRoot, 'test/fixtures');
const labels = (items) => items.map((i) => i.label);

// The index caches a parsed model per URI+version, so each snippet needs its own URI
// or it would be served the previous snippet's model.
let scratchN = 0;
const scratch = () => path.join(FIX, `scratch${++scratchN}.tmh`);

function complete(src, file = scratch()) {
  const { doc, pos } = FakeDocument.withCursor(file, src);
  stub.workspace.textDocuments = [doc];
  return completion.provideCompletionItems(doc, pos) ?? [];
}

console.log('Provider behaviour');
console.log('------------------');

// ---- device-aware completion: the marquee feature ---------------------------
{
  const label = 'T16000 button completion';
  const items = complete('int f() { MapKey(&T16000, |); }');
  const l = labels(items);
  const top = items.slice().sort((a, b) => String(a.sortText).localeCompare(String(b.sortText))).slice(0, 4).map((i) => i.label);
  if (l.includes('TS1') && l.includes('B16') && !l.includes('TG1') && !l.includes('TBTN1')) {
    ok(label);
    console.log(`  ok    ${label}: ${l.length} items, first few = ${top.join(', ')}`);
  } else {
    fail(label, `expected T16000 controls only, got ${l.slice(0, 12).join(', ')} (${l.length} items)`);
  }
}
{
  const label = 'Warthog throttle completion';
  const l = labels(complete('int f() { MapKey(&Throttle, |); }'));
  if (l.includes('SC') && l.includes('APALT') && !l.includes('TS1')) {
    ok(label);
    console.log(`  ok    ${label}: ${l.length} items incl. SC, APALT`);
  } else fail(label, `got ${l.slice(0, 12).join(', ')}`);
}
{
  const label = 'axis completion prefers axes';
  const items = complete('int f() { MapAxis(&T16000, |); }');
  const sorted = items.slice().sort((a, b) => String(a.sortText).localeCompare(String(b.sortText)));
  const firstFour = sorted.slice(0, 4).map((i) => i.label);
  if (firstFour.some((x) => ['JOYX', 'JOYY', 'RUDDER', 'THR'].includes(x))) {
    ok(label);
    console.log(`  ok    ${label}: first = ${firstFour.join(', ')}`);
  } else fail(label, `axes not ranked first, got ${firstFour.join(', ')}`);
}
{
  const label = 'device completion in first argument';
  const items = complete('int f() { MapKey(|); }');
  const l = labels(items);
  const t = items.find((i) => i.label === 'T16000');
  if (l.includes('Joystick') && l.includes('T16000') && t?.insertText === '&T16000') {
    ok(label);
    console.log(`  ok    ${label}: ${l.length} devices, inserts "${t.insertText}"`);
  } else fail(label, `got ${l.slice(0, 8).join(', ')}, insertText=${t?.insertText}`);
}
{
  const label = 'ampersand already typed';
  const items = complete('int f() { MapKey(&|); }');
  const t = items.find((i) => i.label === 'T16000');
  if (t?.insertText === 'T16000') { ok(label); console.log(`  ok    ${label}: inserts "${t.insertText}" (no double &)`); }
  else fail(label, `insertText=${t?.insertText}`);
}
{
  // Completion through a handle the script binds itself.
  const label = 'completion through bound handle';
  const l = labels(complete('alias MyJoy;\nint f() { &MyJoy = &T16000; MapKey(&MyJoy, |); }'));
  if (l.includes('TS1') && !l.includes('TBTN1')) { ok(label); console.log(`  ok    ${label}: ${l.length} T16000 controls`); }
  else fail(label, `got ${l.slice(0, 10).join(', ')}`);
}
{
  const label = 'general completion outside a call';
  const l = labels(complete('int f() { |; }'));
  if (l.includes('MapKey') && l.includes('DX1') && l.includes('Joystick') && l.includes('while')) {
    ok(label);
    console.log(`  ok    ${label}: ${l.length} items`);
  } else fail(label, `got ${l.length} items`);
}
{
  const label = 'no completion inside a comment';
  const items = complete('int f() { // here |\n}');
  if (items.length === 0) { ok(label); console.log(`  ok    ${label}`); }
  else fail(label, `expected none, got ${items.length}`);
}

// ---- hover -------------------------------------------------------------------
function hoverAt(src, file = scratch()) {
  const { doc, pos } = FakeDocument.withCursor(file, src);
  stub.workspace.textDocuments = [doc];
  const h = hover.provideHover(doc, pos);
  return h ? h.contents.value : null;
}
for (const [label, src, needle] of [
  ['hover builtin',  'int f() { MapK|ey(&Joystick, TG1, 0); }', 'int MapKey(alias dev, int btnidx'],
  ['hover constant', 'int f() { MapKey(&Joystick, T|G1, 0); }', 'define TG1'],
  ['hover device',   'int f() { MapKey(&Joy|stick, TG1, 0); }', 'Warthog Joystick'],
  ['hover non-keyword', 'int f() { fo|r(;;) {} }', 'Not part of TARGET'],
  ['hover user symbol', 'int myThing;\nint f() { myT|hing = 1; }', 'int myThing'],
]) {
  const got = hoverAt(src);
  if (got && got.includes(needle)) { ok(label); console.log(`  ok    ${label}`); }
  else fail(label, `expected "${needle}", got ${JSON.stringify((got || '').slice(0, 90))}`);
}

// ---- signature help ----------------------------------------------------------
{
  const { doc, pos } = FakeDocument.withCursor(scratch(), 'int f() { MapKeyUMD(&Joystick, TG1, |); }');
  stub.workspace.textDocuments = [doc];
  const h = signature.provideSignatureHelp(doc, pos);
  if (h && h.signatures[0].label.startsWith('int MapKeyUMD') && h.activeParameter === 2) {
    ok('signature help');
    console.log(`  ok    signature help: active param ${h.activeParameter} of ${h.signatures[0].parameters.length}`);
  } else fail('signature help', `got ${h ? `${h.signatures[0].label} active=${h.activeParameter}` : 'null'}`);
}

// ---- document symbols --------------------------------------------------------
{
  const src = 'define MY_CONST 5\nalias myAlias = "x";\nint myVar;\nint myFn(int a)\n{\n\tint local;\n}\n';
  const doc = new FakeDocument(scratch(), src);
  stub.workspace.textDocuments = [doc];
  const syms = symbols.provideDocumentSymbols(doc);
  const names = syms.map((s) => s.name);
  if (['MY_CONST', 'myAlias', 'myVar', 'myFn'].every((n) => names.includes(n)) && !names.includes('local')) {
    ok('document symbols');
    console.log(`  ok    document symbols: ${names.join(', ')}`);
  } else fail('document symbols', `got ${names.join(', ')}`);
}

// ---- go to definition across includes ----------------------------------------
{
  const tmc = path.join(FIX, 'ED_ENHANCED_T16000.tmc');
  const fs = require('node:fs');
  const { decode } = await import('./decode.mjs');
  const text = decode(fs.readFileSync(tmc));
  const doc = new FakeDocument(tmc, text);
  stub.workspace.textDocuments = [doc];

  // Jump from an include statement to the included file.
  const incIdx = text.indexOf('ED_Functions.tmh');
  const locs = definition.provideDefinition(doc, doc.positionAt(incIdx + 3));
  if (locs.length && locs[0].uri.fsPath.endsWith('ED_Functions.tmh')) {
    ok('go to included file');
    console.log(`  ok    go to included file: ${path.basename(locs[0].uri.fsPath)}`);
  } else fail('go to included file', `got ${locs.map((l) => l.uri.fsPath).join(', ') || 'nothing'}`);

  // Jump from a call to a function defined in one of the included files.
  const target = 'initCurves(';
  const callIdx = text.indexOf(target);
  if (callIdx === -1) {
    fail('cross-file definition', `fixture no longer calls ${target}`);
  } else {
    const l2 = definition.provideDefinition(doc, doc.positionAt(callIdx + 2));
    const external = l2.filter((l) => !l.uri.fsPath.endsWith('.tmc'));
    if (external.length) {
      ok('cross-file definition');
      console.log(`  ok    cross-file definition: initCurves -> ${path.basename(external[0].uri.fsPath)}:${external[0].range.start.line + 1}`);
    } else fail('cross-file definition', `no definition found for initCurves (got ${l2.length} local)`);
  }
}

for (const f of failures) console.log(`  FAIL  ${f}`);
console.log(`\n  ${pass}/${pass + failures.length} provider assertions passed`);
if (failures.length) process.exit(1);
console.log('\nAll provider assertions passed.');
