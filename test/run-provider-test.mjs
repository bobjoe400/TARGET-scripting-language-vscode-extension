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
  const items = completion.provideCompletionItems(doc, pos) ?? [];
  // Documentation is built lazily, as VS Code does when an item is highlighted.
  for (const it of items) completion.resolveCompletionItem(it);
  return items;
}

/** Items exactly as the provider hands them over, before any resolve. */
function completeRaw(src, file = scratch()) {
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


// ---- documentation for the user's own functions -----------------------------
// Real scripts document every function in a comment block above it, separated from
// the declaration by a blank line. Surfacing that is what makes a large multi-file
// script navigable.
{
  const src = [
    '// FUNCTION:\tSets PIP profiles',
    "// Parameter:\t0 = Reset, 1 = Increment, 2 = Decrement",
    '',
    'int fnPIPMode(int x)',
    '{',
    '\treturn x;',
    '}',
    '',
    'int caller()',
    '{',
    '\tfnPIPMode(1);',
    '}',
    '',
  ].join('\n');

  // Hover over the definition shows the block.
  const h = hoverAt(src.replace('int fnPIPMode(int x)', 'int fnPIP|Mode(int x)'));
  if (h && /Sets PIP profiles/.test(h) && /int fnPIPMode\(int x\)/.test(h)) {
    ok('hover shows a user function doc comment');
    console.log('  ok    hover shows a user function doc comment');
  } else fail('hover user doc', `got ${JSON.stringify((h || '').slice(0, 120))}`);

  // Hover over a call site shows it too.
  const h2 = hoverAt(src.replace('\tfnPIPMode(1);', '\tfnPIP|Mode(1);'));
  if (h2 && /Sets PIP profiles/.test(h2)) {
    ok('hover at call site');
    console.log('  ok    hover at a call site shows the same doc');
  } else fail('hover call site doc', `got ${JSON.stringify((h2 || '').slice(0, 120))}`);

  // Completion carries it as the item's documentation.
  const items = complete(src + '\nint other() { fnPIP| }\n');
  const item = items.find((i) => i.label === 'fnPIPMode');
  if (item && /Sets PIP profiles/.test(item.documentation?.value ?? '')) {
    ok('completion doc');
    console.log('  ok    completion carries the doc comment');
  } else fail('completion doc', `documentation=${JSON.stringify(item?.documentation?.value ?? null)}`);

  // Signature help shows it while typing the arguments.
  {
    const { doc, pos } = FakeDocument.withCursor(scratch(), src.replace('\tfnPIPMode(1);', '\tfnPIPMode(|);'));
    stub.workspace.textDocuments = [doc];
    const sh = signature.provideSignatureHelp(doc, pos);
    const docText = sh?.signatures?.[0]?.documentation?.value ?? '';
    if (/Sets PIP profiles/.test(docText)) {
      ok('signature help doc');
      console.log('  ok    signature help carries the doc comment');
    } else fail('signature help doc', `documentation=${JSON.stringify(docText)}`);
  }

  // A banner above a function divides sections; it is not documentation.
  const bannered = '// ------------------------------------------\n\nint fnPlain(int x)\n{\n\treturn x;\n}\n';
  const h3 = hoverAt(bannered.replace('int fnPlain', 'int fnPl|ain'));
  if (h3 && !/-{5,}/.test(h3)) {
    ok('banner not treated as doc');
    console.log('  ok    a separator banner is not mistaken for documentation');
  } else fail('banner as doc', `got ${JSON.stringify((h3 || '').slice(0, 100))}`);
}

// ---- only device-taking builtins offer device names -------------------------
// `alias` is not the signal: target.tmh declares strings, code fragments and variable
// references that way too, so testing the type made Init(&, EXEC(" and strlen( all
// offer 38 joystick names and suppress everything else - including EventHandle, which
// is what Init(& actually wants.
{
  const deviceTaking = complete('int f() { MapKey(|); }').map((i) => i.label);
  const initArg = complete('int f() { if(Init(&|)) return 1; }').map((i) => i.label);
  const execArg = complete('int f() { MapKey(&Joystick, TG1, EXEC(|)); }').map((i) => i.label);
  void execArg;
  // Devices are valid identifiers generally, so their presence in the wider list is
  // fine; what matters is that the wider list is offered at all, and that EventHandle
  // - the thing Init actually wants - is reachable.
  const ok =
    deviceTaking.includes('Joystick') &&
    deviceTaking.length < 60 &&
    initArg.length > 200 &&
    execArg.length > 200;
  if (ok) {
    pass++;
    console.log(`  ok    MapKey(& offers ${deviceTaking.length} devices; Init(& offers ${initArg.length} general items`);
  } else {
    failures.push(`device gating: MapKey=${deviceTaking.length} Init=${initArg.length} EXEC=${execArg.length}`);
  }
}

// ---- completion stays out of ordinary strings -------------------------------
{
  const inAlias = complete('alias A = "VID_044F&|";');
  const inFormat = complete('int f() { printf("a,| b"); }');
  const inExec = complete('int f() { MapKey(&Joystick, TG1, EXEC("fn|")); }');
  if (inAlias.length === 0 && inFormat.length === 0 && inExec.length > 0) {
    pass++;
    console.log(`  ok    strings stay quiet, EXEC code still completes (${inExec.length} items)`);
  } else {
    failures.push(`string completion: alias=${inAlias.length} format=${inFormat.length} exec=${inExec.length}`);
  }
}

// ---- go-to-definition must respect scope ------------------------------------
// A local inside some other file's function is not a definition of this name. Any
// short name - i, x, temp, counter - used to open a peek list of unrelated locals.
{
  const nfs = require('node:fs');
  const dir = nfs.mkdtempSync(path.join(require('node:os').tmpdir(), 'scope-'));
  nfs.writeFileSync(path.join(dir, 'h.tmh'), 'int other()\n{\n\tint counter;\n\treturn counter;\n}\n');
  const main = 'include "h.tmh"\nint main()\n{\n\tint counter;\n\treturn counter;\n}\n';
  const file = path.join(dir, 'a.tmc');
  nfs.writeFileSync(file, main);
  const doc = new FakeDocument(file, main);
  stub.workspace.textDocuments = [doc];
  const at = main.lastIndexOf('counter');
  const locs = definition.provideDefinition(doc, doc.positionAt(at + 2)) ?? [];
  const foreign = locs.filter((l) => !l.uri.fsPath.endsWith('a.tmc'));
  if (locs.length >= 1 && foreign.length === 0) {
    pass++;
    console.log(`  ok    go-to-definition ignores locals in other files (${locs.length} result)`);
  } else {
    failures.push(`definition scope: ${locs.length} results, ${foreign.length} from other files`);
  }
  nfs.rmSync(dir, { recursive: true, force: true });
}

// ---- an unclosed call must not swallow the file ----------------------------
// One missing ')' made every later position report as inside that call: completion
// narrowed to its argument domain and a stale signature popup pinned itself.
{
  const healthy = complete('int f()\n{\n\tMapKey(&Joystick, TG1, DX1);\n}\n\nint g()\n{\n\t|\n}\n');
  const broken = complete('int f()\n{\n\tMapKey(&Joystick, TG1, DX1;\n}\n\nint g()\n{\n\t|\n}\n');
  if (healthy.length > 1000 && broken.length > 1000) {
    pass++;
    console.log(`  ok    an unclosed call does not narrow later completion (${broken.length} items)`);
  } else {
    failures.push(`unclosed call: healthy=${healthy.length} broken=${broken.length}`);
  }
}

// ---- completion payload ----------------------------------------------------
// The general list is thousands of items. Building every description up front sent
// hundreds of kilobytes of markdown across the extension host boundary per keystroke,
// nearly all of it never read; VS Code has resolveCompletionItem for exactly this.
{
  const raw = completeRaw('int f() { | }');
  const eager = raw.filter((i) => i.documentation).length;
  const chars = raw.reduce((a, i) => a + (i.documentation?.value?.length ?? 0), 0);
  if (raw.length > 1000 && eager === 0) {
    pass++;
    console.log(`  ok    ${raw.length} items carry no eager documentation (${chars} chars)`);
  } else {
    failures.push(`eager docs: ${eager}/${raw.length} items carried ${chars} chars up front`);
  }

  // ...and resolving one fills it in.
  const mapKey = raw.find((i) => i.label === 'MapKey');
  completion.resolveCompletionItem(mapKey);
  if (/int MapKey\(alias dev/.test(mapKey?.documentation?.value ?? '')) {
    pass++;
    console.log('  ok    resolveCompletionItem fills in the documentation on demand');
  } else failures.push(`resolve: ${JSON.stringify(mapKey?.documentation?.value ?? null)}`);
}

// ---- argument domains ------------------------------------------------------
// Every argument used to offer all 1049 symbols, so the event argument of MapKey
// suggested OSB01 and SOL_B5 - controls belonging to devices not even in the call.
{
  const cases = [
    ['Configure mode',   'int f() { Configure(&T16000, |); }',                 ['MODE_EXCLUDED'], ['DX1', 'TS1'], 5],
    ['MapAxis dx axis',  'int f() { MapAxis(&T16000, JOYX, |); }',             ['DX_X_AXIS'],     ['DX1', 'TS1'], 15],
    ['MapAxis direction','int f() { MapAxis(&T16000, JOYX, DX_X_AXIS, |); }',  ['AXIS_NORMAL'],   ['MAP_IPTR'],   4],
    ['SetKBLayout',      'int f() { SetKBLayout(|); }',                        ['KB_ENG'],        ['DX1'],        5],
    ['LED mode',         'int f() { LED(&Throttle, |); }',                     ['LED_INTENSITY'], ['LED1'],       4],
  ];
  let domainOk = true;
  for (const [label, src, want, avoid, maxItems] of cases) {
    const l = labels(complete(src));
    const missing = want.filter((w) => !l.includes(w));
    const leaked = avoid.filter((a) => l.includes(a));
    if (missing.length || leaked.length || l.length > maxItems) {
      failures.push(`domain ${label}: ${l.length} items, missing=${missing} leaked=${leaked}`);
      domainOk = false;
    }
  }
  if (domainOk) { pass++; console.log(`  ok    argument domains narrow ${cases.length} argument positions to their own constants`); }

  // The MapKey event argument: narrowed, but still rich.
  const ev = labels(complete('int f() { MapKeyUMD(&T16000, TS1, |); }'));
  if (ev.includes('DX1') && ev.includes('SEQ') && ev.includes('PULSE') && !ev.includes('OSB01') && !ev.includes('SOL_B5')) {
    pass++;
    console.log(`  ok    the MapKey event argument offers ${ev.length} events, not every symbol`);
  } else {
    failures.push(`event domain: ${ev.length} items, hasDX1=${ev.includes('DX1')} hasSEQ=${ev.includes('SEQ')} leakedOSB01=${ev.includes('OSB01')}`);
  }
}

// ---- layer parameters ------------------------------------------------------
// The headers call these keyIU, keyOM, keyID, which says nothing on its own. The
// manual's scheme - Up/Middle/Down main layers with an In/Out shift sub-layer - is
// what makes the MapKey family readable.
{
  const { doc, pos } = FakeDocument.withCursor(scratch(), 'int f() { MapKeyIOUMD(&Joystick, TG1, 0, 0, |); }');
  stub.workspace.textDocuments = [doc];
  const sh = signature.provideSignatureHelp(doc, pos);
  const active = sh?.signatures?.[0]?.parameters?.[sh.activeParameter];
  const docText = active?.documentation?.value ?? '';
  if (/Middle layer/.test(docText) && /In \(shift button held\)/.test(docText)) {
    ok('layer param');
    console.log(`  ok    signature help explains a layer parameter ("${docText}")`);
  } else failures.push(`layer param: active=${sh?.activeParameter} label=${active?.label} doc=${JSON.stringify(docText)}`);

  const h = hoverAt('int f() { MapKeyIO|UMD(&Joystick, TG1, 0,0,0,0,0,0); }');
  if (h && /Up layer/.test(h) && /Down layer/.test(h)) {
    ok('hover layers');
    console.log('  ok    hover lists every layer parameter');
  } else failures.push(`hover layers: ${JSON.stringify((h || '').slice(0, 160))}`);
}

// ---- USB scancodes ---------------------------------------------------------
// Neither target.tmh nor defines.tmh says what USB[0x2C] is; the corpus uses 123
// distinct codes across 318 references, so naming them is the difference between
// reading a script and decoding one.
{
  const h = hoverAt('int f() { MapKey(&Joystick, TG1, USB[0x2|C]); }');
  if (h && /Space/.test(h)) { ok('usb hover'); console.log('  ok    hover names a USB scancode (0x2C = Space)'); }
  else failures.push(`usb hover: ${JSON.stringify((h || '').slice(0, 100))}`);

  const h2 = hoverAt('int f() { MapKey(&Joystick, TG1, USB[0x3|D]); }');
  if (h2 && /F4/.test(h2)) { ok('usb hover F4'); console.log('  ok    hover names 0x3D = F4'); }
  else failures.push(`usb hover F4: ${JSON.stringify((h2 || '').slice(0, 100))}`);

  const items = complete('int f() { MapKey(&Joystick, TG1, USB[|]); }');
  const space = items.find((i) => i.label === '0x2C');
  if (space && /Space/.test(space.detail ?? '') && items.length > 50) {
    ok('usb completion');
    console.log(`  ok    completion offers ${items.length} named scancodes inside USB[`);
  } else failures.push(`usb completion: ${items.length} items, 0x2C detail=${JSON.stringify(space?.detail)}`);
}

// ---- physical control descriptions -----------------------------------------
// Taken from the per-device PDFs TARGET installs. EFLNORM means nothing on its own.
{
  const items = complete('int f() { MapKey(&Throttle, |); }');
  const efl = items.find((i) => i.label === 'EFLNORM');
  const chf = items.find((i) => i.label === 'CHF');
  if (/Engine Fuel Flow Left/.test(efl?.detail ?? '') && /China Hat/.test(chf?.detail ?? '')) {
    pass++;
    console.log(`  ok    completion describes physical controls ("${efl.detail}")`);
  } else {
    failures.push(`control labels: EFLNORM detail=${JSON.stringify(efl?.detail)} CHF=${JSON.stringify(chf?.detail)}`);
  }

  const h = hoverAt('int f() { MapKey(&Throttle, APA|LT, 0); }');
  if (h && /Autopilot Select Switch/.test(h)) {
    pass++;
    console.log('  ok    hover describes a physical control');
  } else failures.push(`hover control label: ${JSON.stringify((h || '').slice(0, 120))}`);

  // The out-of-the-box DirectX mapping, from the same diagrams.
  const t16Items = complete('int f() { MapKey(&T16000, |); }');
  const ts1 = t16Items.find((i) => i.label === 'TS1');
  if (/DX1`? by default/.test(ts1?.documentation?.value ?? '')) {
    pass++;
    console.log('  ok    completion shows the default DX button (TS1 sends DX1)');
  } else failures.push(`default dx: TS1 doc=${JSON.stringify(ts1?.documentation?.value ?? null)}`);

  const hdx = hoverAt('int f() { MapKey(&Throttle, MS|P, 0); }');
  if (hdx && /DX26/.test(hdx)) {
    pass++;
    console.log('  ok    hover shows the default DX button (MSP sends DX26)');
  } else failures.push(`hover default dx: ${JSON.stringify((hdx || '').slice(0, 160))}`);

  // A device whose PDF has no per-control prose must simply fall back, not invent.
  const t16 = complete('int f() { MapKey(&T16000, |); }').find((i) => i.label === 'TS1');
  if (t16 && /T\.16000M/.test(t16.detail ?? '')) {
    pass++;
    console.log('  ok    undescribed devices fall back to the device and index');
  } else failures.push(`T16000 fallback: ${JSON.stringify(t16?.detail)}`);
}

// TARGET defines no documentation format: the compiler ignores comments and ships no
// doc tooling. So whatever comment style a script uses must work, and no particular
// convention may be privileged - the block above a declaration is shown verbatim.
{
  const { buildModel } = require(path.join(repoRoot, 'out/model.js'));
  const styles = [
    ['plain one-liner', '// Toggles the landing gear\nint a(int x) { return x; }\n', 'Toggles the landing gear'],
    ['several plain lines', '// Toggles the gear.\n// Pass 1 to force it down.\nint b(int x) { return x; }\n', 'Pass 1 to force it down.'],
    ['block comment', '/*\n Toggles the gear.\n*/\nint c(int x) { return x; }\n', 'Toggles the gear.'],
    ['javadoc-style, not parsed', '/**\n * Toggles it.\n * @param x force down\n */\nint d(int x) { return x; }\n', '@param x force down'],
    ['blank line before the declaration', '// A note\n\nint e(int x) { return x; }\n', 'A note'],
  ];
  let styleOk = true;
  for (const [label, src, needle] of styles) {
    const decl = buildModel(src).decls.find((d) => d.kind === 'function');
    if (!decl || !decl.doc.includes(needle)) {
      failures.push(`doc style "${label}": expected ${JSON.stringify(needle)}, got ${JSON.stringify(decl?.doc ?? null)}`);
      styleOk = false;
    }
  }
  // A banner divides sections and documents nothing.
  const banner = buildModel('// ==============================\nint h(int x) { return x; }\n').decls.find((d) => d.kind === 'function');
  if (banner?.doc.trim()) {
    failures.push(`a banner was treated as documentation: ${JSON.stringify(banner.doc)}`);
    styleOk = false;
  }
  if (styleOk) {
    pass++;
    console.log(`  ok    doc extraction is style-agnostic (${styles.length} styles, banners excluded)`);
  }
}


// ---- Elite Dangerous bindings ----------------------------------------------
// A script sends keystrokes; the game decides what they mean, and that mapping lives
// only in the game's .binds file. Looking it up by key rather than by name, because
// script authors name their defines however they like - of 200 defines in the corpus
// only 15 match a game action name.
{
  const { usbCodeForEdKey, ED_MODIFIERS, buildBindsIndex, activePresetNames, fileMatchesPreset, bindingFormat, parseChord, chordMatches,
          readAssociations, gameForExecutable, comparablePath, targetSettingsPaths } =
    require(path.join(repoRoot, 'out/binds.js'));
  const { renderBindings, escapeMarkdown, shortKeyName, code } = require(path.join(repoRoot, 'out/providers.js'));
  const NOCHORD = { modifiers: [], unknown: [] };

  // Key resolution must be exact: Home and Keypad-7 are different keys.
  const resolutions = [
    ['Key_U', '18'], ['Key_Home', '4A'], ['Key_Numpad_7', '5F'], ['Key_F4', '3D'],
    ['Key_Space', '2C'], ['Key_Equals', '2E'], ['Key_Insert', '49'], ['Key_Numpad_Add', '57'],
  ];
  const wrong = resolutions.filter(([k, want]) => usbCodeForEdKey(k) !== want);
  if (wrong.length === 0) { pass++; console.log(`  ok    ${resolutions.length} Elite key names resolve to the right USB codes`); }
  else failures.push(`ed key resolution: ${wrong.map(([k, w]) => `${k} wanted ${w} got ${usbCodeForEdKey(k)}`).join(', ')}`);

  if (ED_MODIFIERS.LeftShift === 'L_SHIFT' && usbCodeForEdKey('Key_LeftShift') === null) {
    pass++; console.log('  ok    modifiers map to TARGET flags, not scancodes');
  } else failures.push('modifier handling');

  const bindsFile = path.join(FIX, 'BindFiles', 'Sample.4.1.binds');
  const idx = buildBindsIndex([bindsFile]);
  const u = idx.byUsbCode.get('18');
  if (u?.[0]?.action === 'DeployHardpointToggle' && idx.actions.includes('LandingGearToggle')) {
    pass++; console.log(`  ok    .binds parsed: ${idx.actions.length} actions, U -> ${u[0].action}`);
  } else failures.push(`binds parse: ${JSON.stringify([...idx.byUsbCode.keys()])}`);

  const home = idx.byUsbCode.get('4A');
  if (home?.[0]?.modifiers.includes('L_SHIFT')) { pass++; console.log('  ok    modifier keys are carried through (Shift+Home)'); }
  else failures.push(`binds modifiers: ${JSON.stringify(home)}`);

  // And it reaches the editor: hovering the scancode says what the game does.
  const h = hoverAt('int f() { MapKey(&Joystick, TG1, USB[0x1|8]); }', path.join(FIX, 'bindsdemo.tmc'));
  // The game's own spelling, linked to the line that decides it.
  if (h && /\[`DeployHardpointToggle`\]\(file:[^)]*#L\d+\)/.test(h)) { pass++; console.log('  ok    hover shows the game action a key is bound to'); }
  else failures.push(`binds hover: ${JSON.stringify((h || '').slice(0, 200))}`);

  // --- the hover has to be readable, not just correct -----------------------
  // A Bindings folder accumulates every preset the player has tried, and the community
  // layouts ship more beside the script. Merging them produced a hover that repeated one
  // action four times and hid the rest behind "and 6 more".
  // The game's own spelling is kept verbatim: it is the string you would search the
  // binding file for, and prettifying it made it un-findable.
  {
    const md = renderBindings(buildBindsIndex([bindsFile]).byUsbCode.get('18'), NOCHORD, 'u', null).join('\n');
    if (/`DeployHardpointToggle`/.test(md) && !/Deploy Hardpoint Toggle/.test(md)) {
      pass++; console.log('  ok    the game\'s own action name is shown verbatim');
    } else failures.push(`verbatim: ${JSON.stringify(md.slice(0, 160))}`);
    // ...and links to the line that decides it, needing no command and no trust grant.
    if (/\]\(file:\/\/[^)]*#L\d+\)/.test(md)) {
      pass++; console.log('  ok    each action links to its line in the binding file');
    } else failures.push(`link: ${JSON.stringify(md.slice(0, 160))}`);
  }

  // "Keypad *" used to render as literal asterisks around a broken bold span.
  if (escapeMarkdown('Keypad *') === 'Keypad \\*' && escapeMarkdown('Clicker-ENHANCED_W') === 'Clicker-ENHANCED\\_W') {
    pass++; console.log('  ok    punctuation key names survive markdown');
  } else failures.push(`escape: ${escapeMarkdown('Keypad *')} / ${escapeMarkdown('Clicker-ENHANCED_W')}`);

  // "u U" is the USB table's unshifted/shifted notation, not the key's name.
  if (shortKeyName('u U') === 'u' && shortKeyName('1 !') === '1' && shortKeyName('Keypad *') === 'Keypad *' && shortKeyName('Right Arrow') === 'Right Arrow') {
    pass++; console.log('  ok    a doubled key name collapses, a two-word name does not');
  } else failures.push(`shortKeyName: ${shortKeyName('u U')} / ${shortKeyName('Keypad *')}`);

  // The same preset installed in the game's folder AND shipped beside the script is one
  // fact, not two.
  const twice = buildBindsIndex([bindsFile, bindsFile]);
  const dedup = twice.byUsbCode.get('18');
  if (dedup?.length === 1) { pass++; console.log('  ok    the same binding from two copies is listed once'); }
  else failures.push(`dedupe: ${JSON.stringify(dedup)}`);

  {
    const mk = (action, modifiers, line) => ({
      action, slot: 'Secondary', key: 'Key_K', modifiers, file: 'A.binds',
      path: '/tmp/A.binds', line, game: 'Elite Dangerous', kind: 'key',
    });
    const refs = [mk('UI_Right', [], 5), mk('IncreaseWeaponsPower', ['L_SHIFT'], 9), mk('ItemWheelRight', ['L_ALT'], 14)];

    // The line `L_ALT+USB[0x4F]` sends a different key from `USB[0x4F]`, and a binding
    // needing L_SHIFT does not fire for either. Listing all three was the extension
    // describing two other lines of the user's script as if they were this one.
    const alt = renderBindings(refs, parseChord('L_ALT+'), 'Right Arrow', null).join('\n');
    if (/ItemWheelRight/.test(alt) && !/IncreaseWeaponsPower/.test(alt) && !/UI_Right/.test(alt)) {
      pass++; console.log('  ok    only bindings for the modifiers actually on the line');
    } else failures.push(`chord filter: ${JSON.stringify(alt.slice(0, 200))}`);

    const bare = renderBindings(refs, NOCHORD, 'Right Arrow', null).join('\n');
    if (/UI_Right/.test(bare) && !/ItemWheelRight/.test(bare)) {
      pass++; console.log('  ok    a bare key does not inherit modified bindings');
    } else failures.push(`bare chord: ${JSON.stringify(bare.slice(0, 200))}`);

    // Nothing bound to this chord is a real answer, and the old hover concealed it.
    // It is also the WHOLE answer: what the same key does under other modifiers belongs
    // to other lines of the script, which is why those rows are absent from the match
    // case. Repeating them here was the same noise under a new heading; the peek exists
    // for anyone who does want the whole picture.
    const none = renderBindings(refs, parseChord('R_ALT+'), 'Right Arrow', null, true, { kind: 'key', code: '4F' }).join('\n');
    if (/Nothing in \*\*Elite Dangerous\*\* is bound to/.test(none) && !/needs L_ALT/.test(none) && !/IncreaseWeaponsPower/.test(none) && /peekBindings/.test(none)) {
      pass++; console.log('  ok    an unbound chord says only that, and offers the peek');
    } else failures.push(`unbound: ${JSON.stringify(none.slice(0, 220))}`);

    // An unrecognised term must never fall back to the bare key - the user's own corpus
    // has nine lines reading `L+CTL+USB[0x1E]`, where L is defined nowhere.
    const typo = parseChord('L+CTL+');
    const typoMd = renderBindings(refs, typo, 'Right Arrow', null).join('\n');
    if (typo.unknown.includes('L') && typo.modifiers.join() === 'L_CTL' && /`L` is not a modifier/.test(typoMd)) {
      pass++; console.log('  ok    an unknown modifier is reported, not silently dropped');
    } else failures.push(`typo chord: ${JSON.stringify(typo)}`);

    // CTL and LCTL are both 1224 in defines.tmh: a bare CTL is the LEFT control key.
    if (parseChord('CTL+').modifiers.join() === 'L_CTL' && parseChord('USB[0xE1]+').modifiers.join() === 'L_SHIFT') {
      pass++; console.log('  ok    both spellings of a modifier resolve the same way');
    } else failures.push(`modifier spellings: ${JSON.stringify(parseChord('CTL+'))}`);

    // Set equality, not subset: a two-modifier binding is a different key.
    if (!chordMatches(mk('X', ['L_ALT', 'L_CTL'], 1), ['L_ALT']) && chordMatches(mk('X', ['L_ALT'], 1), ['L_ALT'])) {
      pass++; console.log('  ok    chords match on the whole set, not a subset');
    } else failures.push('chord subset');

    // The chord belongs to the LINE, not to the binding list. Rendered only when the
    // key happened to have bindings, the warning went missing in exactly the case that
    // needs it: a mistyped modifier on a key the game does not use. All nine
    // `L+CTL+USB[...]` lines in the real corpus were silent.
    const orphan = renderBindings([], parseChord('L+CTL+'), '1', null).join('\n');
    if (/is not a modifier/.test(orphan) && /Nothing in .* is bound to/.test(orphan)) {
      pass++; console.log('  ok    a bad chord is reported even when the key has no bindings');
    } else failures.push(`orphan chord: ${JSON.stringify(orphan)}`);

    // PULSE and friends share the + position but say HOW the key is sent, not which key.
    // PULSE alone appears 268 times in the corpus.
    const pulse = parseChord('PULSE+L_ALT+');
    if (pulse.unknown.length === 0 && pulse.modifiers.join() === 'L_ALT' && parseChord('SHF+').modifiers.join() === 'L_SHIFT') {
      pass++; console.log('  ok    key-state flags are not mistaken for modifiers, and SHF resolves');
    } else failures.push(`state flags: ${JSON.stringify(pulse)} / ${JSON.stringify(parseChord('SHF+'))}`);

    // One action in both slots of one file is one binding, not two identical rows.
    const dual = renderBindings(
      [mk('UIFocusMode', [], 3), { ...mk('UIFocusMode', [], 3), slot: 'Secondary' }],
      NOCHORD, 'k', null
    ).join('\n');
    if ((dual.match(/UIFocusMode/g) || []).length === 1) {
      pass++; console.log('  ok    one action in two slots is one row');
    } else failures.push(`slot fold: ${JSON.stringify(dual)}`);

    // Two DCS aircraft disagree; which one said what is the point.
    const twoFiles = renderBindings(
      [{ ...mk('Gear', [], 5), file: 'F18.diff.lua', path: '/tmp/F18.diff.lua' },
       { ...mk('Flaps', [], 9), file: 'A10.diff.lua', path: '/tmp/A10.diff.lua' }],
      NOCHORD, 'DX3', null
    ).join('\n');
    if (/Gear.*F18\.diff\.lua/s.test(twoFiles) && /Flaps.*A10\.diff\.lua/s.test(twoFiles)) {
      pass++; console.log('  ok    rows name their file when more than one is on screen');
    } else failures.push(`multi-file: ${JSON.stringify(twoFiles)}`);

    // The decoded chord, confirmed back to the reader. The line carries `USB[0x1E]` and a
  // hand-written `// LALT+1` comment, so "L_ALT + 1" is the one part nothing else
  // verifies - and seeing it is how you know the extension read the same line you did.
  {
    const withChord = renderBindings([mk('X', ['L_ALT'], 3)], parseChord('L_ALT+'), '1', null, true).join('\n');
    const without = renderBindings([mk('X', ['L_ALT'], 3)], parseChord('L_ALT+'), '1', null, false).join('\n');
    if (/`L_ALT` \+ `1`/.test(withChord) && !/`L_ALT` \+ `1`/.test(without)) {
      pass++; console.log('  ok    the decoded chord is echoed back on a match');
    } else failures.push(`chord echo: ${JSON.stringify(withChord)}`);
  }

  // USB 0x35 is the ` key, and DCS action names are freeform. A fixed fence breaks.
    if (code('`') === '`` ` ``' && code('a') === '`a`' && code('a`b') === '``a`b``') {
      pass++; console.log('  ok    a backtick in a key or action name still renders');
    } else failures.push(`code fence: ${code('`')} / ${code('a`b')}`);

    // The hover widget scrolls and remembers its size, so truncating hid answers it
    // would have shown.
    const many = Array.from({ length: 30 }, (_, i) => mk(`Action${i}`, [], i + 1));
    const all = renderBindings(many, NOCHORD, 'k', null).join('\n');
    if (/Action29/.test(all) && !/more/.test(all)) {
      pass++; console.log('  ok    a long list is never truncated');
    } else failures.push(`truncation: ${(all.match(/Action\d+/g) || []).length} of 30 shown`);
  }


  // --- the other games TARGET scripts are written for ----------------------
  // Elite Dangerous is not the only one, and .binds is not the only format. DCS writes
  // a .diff.lua per module, Star Citizen exports an ActionMaps .xml, and all three bind
  // the VIRTUAL BUTTONS the script produces - which is the half that matters most, a
  // script's whole job being to put a button under a control.
  {
    const dcs = path.join(FIX, 'BindFiles', 'Sample.diff.lua');
    const sc = path.join(FIX, 'BindFiles', 'Sample-actionmaps.xml');
    const notGame = path.join(FIX, 'BindFiles', 'NotAGame.xml');

    if (bindingFormat(dcs) === 'DCS World' && bindingFormat(sc) === 'Star Citizen' && bindingFormat(notGame) === null) {
      pass++; console.log('  ok    binding files are identified by content, not extension');
    } else failures.push(`format: ${bindingFormat(dcs)} / ${bindingFormat(sc)} / ${bindingFormat(notGame)}`);

    const d = buildBindsIndex([dcs]);
    const gun = d.byButton.get(6);
    // "removed" is a binding being taken away and must not be reported as one.
    if (gun?.[0]?.action === 'Gun Trigger - SECOND DETENT (Press to shoot)' && !d.byButton.has(99)) {
      pass++; console.log('  ok    DCS .diff.lua maps JOY_BTN to the DX button');
    } else failures.push(`dcs: ${JSON.stringify([...d.byButton.keys()])}`);

    const c = buildBindsIndex([sc]);
    // An input of a single space is Star Citizen's way of writing "unbound".
    if (c.byButton.get(30)?.[0]?.action === 'v_eject' && c.byButton.size === 1) {
      pass++; console.log('  ok    Star Citizen ActionMaps maps js_button to the DX button');
    } else failures.push(`sc: ${JSON.stringify([...c.byButton.keys()])}`);

    // Elite binds the virtual device too, not just the keyboard.
    const edButtons = buildBindsIndex([bindsFile]).byButton;
    const all = buildBindsIndex([dcs, sc, bindsFile]);
    if (all.games.length === 3) { pass++; console.log(`  ok    three games indexed side by side (${all.games.join(', ')})`); }
    else failures.push(`games: ${JSON.stringify(all.games)}`);

    // And the hover names each game rather than merging them into one list.
    const both = [...(all.byButton.get(30) ?? []), ...(all.byButton.get(6) ?? [])];
    const md = renderBindings(both, NOCHORD, 'DX30', null).join('\n');
    if (/Star Citizen/.test(md) && /DCS World/.test(md) && /v_eject/.test(md)) {
      pass++; console.log('  ok    a button bound in two games is reported per game');
    } else failures.push(`multi-game render: ${JSON.stringify(md.slice(0, 200))}`);

    // Every parser records the line, so the link lands on the action itself.
    const dcsRef = d.byButton.get(6)[0];
    const scRef = c.byButton.get(30)[0];
    if (dcsRef.line > 1 && scRef.line > 1 && dcsRef.path.endsWith('Sample.diff.lua')) {
      pass++; console.log(`  ok    every format records a line to link to (DCS L${dcsRef.line}, SC L${scRef.line})`);
    } else failures.push(`lines: dcs=${dcsRef.line} sc=${scRef.line}`);
    void edButtons;
  }

  // --- the association the TARGET GUI records --------------------------------
  // Its "associations" pane stores which game each .tmc runs with. That settles what
  // the extension otherwise guesses at - but it lives in the user's roaming profile,
  // NOT in the project, so anyone who clones a script repo has none and the behaviour
  // without it has to be exactly what it was before.
  {
    const nfs3 = require('node:fs');
    const d = nfs3.mkdtempSync(path.join(require('node:os').tmpdir(), 'assoc-'));
    const f = path.join(d, 'TargetSettings.xml');
    nfs3.writeFileSync(f, `<?xml version="1.0" encoding="utf-8"?>
<TargetSettings>
  <GameConfigAssociations>
    <Game1>
      <Name>Clicker ED</Name>
      <Game>D:\\SteamLibrary\\steamapps\\common\\Elite Dangerous\\Products\\elite-dangerous-odyssey-64\\EliteDangerous64.exe</Game>
      <Configuration>C:\\Scripts\\ED_ENHANCED.tmc</Configuration>
    </Game1>
    <Game2>
      <Name>Unknown thing</Name>
      <Game>C:\\Games\\SomethingElse.exe</Game>
      <Configuration>C:\\Scripts\\Other.tmc</Configuration>
    </Game2>
  </GameConfigAssociations>
</TargetSettings>`);
    const list = readAssociations(f);
    if (list.length === 2 && list[0].game === 'Elite Dangerous' && list[1].game === null) {
      pass++; console.log('  ok    associations are read, and an unknown game stays null');
    } else failures.push(`assoc: ${JSON.stringify(list)}`);

    // A Windows path in the settings and a WSL path in the editor are the same file.
    if (comparablePath('C:\\Scripts\\ED_ENHANCED.tmc') === comparablePath('/mnt/c/Scripts/ED_ENHANCED.tmc')) {
      pass++; console.log('  ok    a Windows and a WSL spelling of one script compare equal');
    } else failures.push('comparablePath');

    // path.basename does not split a Windows path on POSIX, which silently made every
    // association resolve to no game at all.
    if (gameForExecutable('D:\\x\\EliteDangerous64.exe') === 'Elite Dangerous' &&
        gameForExecutable('C:\\DCS World\\bin\\DCS.exe') === 'DCS World' &&
        gameForExecutable('C:\\Games\\Nothing.exe') === null) {
      pass++; console.log('  ok    the game is identified from a Windows executable path');
    } else failures.push(`gameForExecutable: ${gameForExecutable('D:\\x\\EliteDangerous64.exe')}`);

    // No settings file at all is the ordinary case for a cloned repo.
    if (readAssociations(path.join(d, 'nope.xml')).length === 0 && Array.isArray(targetSettingsPaths(null))) {
      pass++; console.log('  ok    a missing settings file yields no associations, not an error');
    } else failures.push('missing settings file');
    nfs3.rmSync(d, { recursive: true, force: true });
  }

  // The preset the game will actually load, taken from the highest-numbered marker.
  {
    const nfs2 = require('node:fs');
    const d = nfs2.mkdtempSync(path.join(require('node:os').tmpdir(), 'preset-'));
    nfs2.writeFileSync(path.join(d, 'StartPreset.start'), 'KeyboardMouseOnly\n');
    nfs2.writeFileSync(path.join(d, 'StartPreset.4.start'), 'MyPreset\nMyPreset\nCustom\n');
    nfs2.writeFileSync(path.join(d, 'z_StartPreset.4.start'), 'Ignored\n');
    const names = activePresetNames(d);
    const matches = fileMatchesPreset('/x/MyPreset.4.2.binds', 'MyPreset') && !fileMatchesPreset('/x/Other.4.2.binds', 'MyPreset');
    if (names[0] === 'MyPreset' && names.length === 2 && matches) {
      pass++; console.log('  ok    the active preset is read from StartPreset');
    } else failures.push(`preset: ${JSON.stringify(names)} matches=${matches}`);
    nfs2.rmSync(d, { recursive: true, force: true });
  }
}

for (const f of failures) console.log(`  FAIL  ${f}`);
console.log(`\n  ${pass}/${pass + failures.length} provider assertions passed`);
if (failures.length) process.exit(1);
console.log('\nAll provider assertions passed.');
