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

for (const f of failures) console.log(`  FAIL  ${f}`);
console.log(`\n  ${pass}/${pass + failures.length} provider assertions passed`);
if (failures.length) process.exit(1);
console.log('\nAll provider assertions passed.');
