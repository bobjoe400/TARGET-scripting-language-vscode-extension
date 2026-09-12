// The include graph rules, exercised against real files.
//
// TARGET has no include guards: a file reached twice is compiled twice and the second
// copy fails with "Name already defined". Nesting deeper than eight fails outright.
// Both were established by compiling them, and neither is reported before build time.
import fs from 'node:fs';
import os from 'node:os';
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
const { TargetIndex, MAX_INCLUDE_DEPTH } = require(path.join(repoRoot, 'out/index.js'));
const { decode } = await import('./decode.mjs');
const vscode_uri = (p) => stub.Uri.file(p);

let pass = 0;
const failures = [];

console.log('Include graph');
console.log('-------------');
console.log(`  max nesting depth: ${MAX_INCLUDE_DEPTH}`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inc-test-'));
const W = (n, b) => { fs.writeFileSync(path.join(tmp, n), b); return path.join(tmp, n); };

function analyze(entryName) {
  const p = path.join(tmp, entryName);
  const doc = new FakeDocument(p, fs.readFileSync(p, 'utf8'));
  stub.workspace.textDocuments = [doc];
  return new TargetIndex().analyzeIncludes(doc);
}

// Same header listed twice in one file.
W('h1.tmh', 'int sharedFn(int a) { return a; }\n');
W('twice.tmc', 'include "h1.tmh"\ninclude "h1.tmh"\nint main() { return 0; }\n');
{
  const r = analyze('twice.tmc');
  const hit = r.problems.find((p) => p.code === 'duplicate-include');
  if (hit && /h1\.tmh is included 2 times/.test(hit.message)) {
    pass++; console.log('  ok    same header included twice is caught');
  } else failures.push(`twice: ${JSON.stringify(r.problems)}`);
}

// Diamond: entry includes A and B, and B also includes A.
W('h2.tmh', 'include "h1.tmh"\nint viaH2() { return 1; }\n');
W('diamond.tmc', 'include "h1.tmh"\ninclude "h2.tmh"\nint main() { return 0; }\n');
{
  const r = analyze('diamond.tmc');
  const hit = r.problems.find((p) => p.code === 'duplicate-include');
  if (hit) { pass++; console.log('  ok    diamond include is caught'); }
  else failures.push(`diamond: ${JSON.stringify(r.problems)}`);
}

// A chain one level deeper than the compiler accepts.
for (let i = 1; i <= 10; i++) {
  W(`d${i}.tmh`, `${i < 10 ? `include "d${i + 1}.tmh"\n` : ''}int fn${i}() { return ${i}; }\n`);
}
W('deep.tmc', 'include "d1.tmh"\nint main() { return 0; }\n');
{
  const r = analyze('deep.tmc');
  const hit = r.problems.find((p) => p.code === 'include-too-deep');
  if (hit) { pass++; console.log('  ok    nesting past the limit is caught'); }
  else failures.push(`deep: ${JSON.stringify(r.problems.map((p) => p.code))}`);
}

// A legal flat layout, which is how real scripts are written, must stay clean.
W('a.tmh', 'int aFn() { return 1; }\n');
W('b.tmh', 'int bFn() { return 2; }\n');
W('flat.tmc', 'include "a.tmh"\ninclude "b.tmh"\nint main() { return 0; }\n');
{
  const r = analyze('flat.tmc');
  if (r.problems.length === 0 && r.duplicateSymbols.size === 0) {
    pass++; console.log('  ok    a flat, single-inclusion layout is clean');
  } else failures.push(`flat: ${JSON.stringify(r.problems)} dup=${[...r.duplicateSymbols.keys()]}`);
}

// The same name declared in two different headers.
W('c1.tmh', 'int collide() { return 1; }\n');
W('c2.tmh', 'int collide() { return 2; }\n');
W('dupsym.tmc', 'include "c1.tmh"\ninclude "c2.tmh"\nint main() { return 0; }\n');
{
  const r = analyze('dupsym.tmc');
  if (r.duplicateSymbols.has('collide')) {
    pass++; console.log(`  ok    a name declared in two headers is caught (${r.duplicateSymbols.get('collide').join(', ')})`);
  } else failures.push(`dupsym: ${[...r.duplicateSymbols.keys()]}`);
}

fs.rmSync(tmp, { recursive: true, force: true });

// An include that does not resolve yet must not be remembered as unresolvable. Writing
// the include and then creating the file is the ordinary order of work.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'late-'));
  fs.writeFileSync(path.join(dir, 'a.tmc'), 'include "later.tmh"\nint main() { return 0; }\n');
  const doc = new FakeDocument(path.join(dir, 'a.tmc'), fs.readFileSync(path.join(dir, 'a.tmc'), 'utf8'));
  stub.workspace.textDocuments = [doc];
  const idx = new TargetIndex();

  const before = idx.resolveInclude(path.join(dir, 'a.tmc'), 'later.tmh');
  fs.writeFileSync(path.join(dir, 'later.tmh'), 'int lateFn() { return 1; }\n');
  const after = idx.resolveInclude(path.join(dir, 'a.tmc'), 'later.tmh');

  if (before === null && after !== null) {
    pass++;
    console.log('  ok    an include resolves once the file appears');
  } else {
    failures.push(`late include: before=${before} after=${after}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

// The real corpus must stay clean: its headers include nothing, by necessity.
const entry = path.join(repoRoot, 'test/fixtures/ED_ENHANCED_T16000.tmc');
{
  const doc = new FakeDocument(entry, decode(fs.readFileSync(entry)));
  stub.workspace.textDocuments = [doc];
  const r = new TargetIndex().analyzeIncludes(doc);
  const dupNames = [...r.duplicateSymbols.keys()];
  if (r.problems.length === 0 && dupNames.length === 0) {
    pass++;
    console.log('  ok    the real 11-file corpus graph is clean');
  } else {
    failures.push(`corpus: ${r.problems.map((p) => p.code + ': ' + p.message.slice(0, 90)).join(' | ')} dupSymbols=${dupNames.slice(0, 5)}`);
  }
}

// A cached resolution must not outlive the file. Deleting a header that is still
// included used to leave the stale success in place, so closureComplete stayed true
// while the file had dropped out of the closure - and the entry script filled with
// "not defined" for every symbol that lived in it.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gone-'));
  fs.writeFileSync(path.join(dir, 'h.tmh'), 'int helperFn() { return 1; }\n');
  fs.writeFileSync(path.join(dir, 'a.tmc'), 'include "h.tmh"\nint main() { return helperFn(); }\n');
  const doc = new FakeDocument(path.join(dir, 'a.tmc'), fs.readFileSync(path.join(dir, 'a.tmc'), 'utf8'));
  stub.workspace.textDocuments = [doc];
  const idx = new TargetIndex();

  const before = idx.symbolTable(doc);
  fs.rmSync(path.join(dir, 'h.tmh'), { force: true });
  idx.invalidate(vscode_uri(path.join(dir, 'h.tmh')));
  const after = idx.symbolTable(doc);

  if (before.complete && before.symbols.has('helperFn') && !after.complete) {
    pass++;
    console.log('  ok    deleting an included header is noticed, not papered over');
  } else {
    failures.push(`stale resolution: before(complete=${before.complete}) after(complete=${after.complete}, knows helperFn=${after.symbols.has('helperFn')})`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

// The corpus swept the way the extension actually refreshes: with the cross-file
// symbol table, one document at a time, headers included. The plain corpus sweep in
// run-diagnostics-test.mjs passes no symbol table, so it cannot see a rule that
// misfires only when one is present.
{
  const { computeDiagnostics } = require(path.join(repoRoot, 'out/diagnostics.js'));
  const { collectAliasBindings } = require(path.join(repoRoot, 'out/model.js'));
  const fixtures = path.join(repoRoot, 'test/fixtures');
  const files = fs
    .readdirSync(fixtures)
    .filter((f) => /\.(tmc|tmh|ttm)$/i.test(f) && f !== 'DEMO.tmc')
    .map((f) => path.join(fixtures, f));

  // The closure cache used to key entries on the generation the walk STARTED at, while
  // the walk itself bumps that generation for every file it parses off disk - so the
  // entry was unreachable the moment it was written and the walk after any reparse was
  // always repeated. A hit returns the very same array.
  {
    const entry = files.find((f) => f.toLowerCase().endsWith('.tmc'));
    if (entry) {
      const fresh = new TargetIndex();
      const doc = new FakeDocument(entry, decode(fs.readFileSync(entry)));
      stub.workspace.textDocuments = [doc];
      const model = fresh.getModel(doc);
      const first = fresh.includeClosure(entry, model);
      const second = fresh.includeClosure(entry, model);
      const label = 'the include closure is cached where it can be found again';
      if (first !== second) failures.push(label);
      else { pass++; console.log(`  ok    ${label}`); }
    }
  }

  let noisy = 0;
  const idx = new TargetIndex();
  for (const file of files) {
    const doc = new FakeDocument(file, decode(fs.readFileSync(file)));
    stub.workspace.textDocuments = [doc];
    const model = idx.getModel(doc);
    const { symbols, complete } = idx.symbolTable(doc);
    const isEntry = file.toLowerCase().endsWith('.tmc');
    const graph = isEntry ? idx.analyzeIncludes(doc) : null;
    const bindings = new Map();
    for (const { model: m } of idx.includeClosure(file, model)) {
      for (const [k, v] of collectAliasBindings(m)) {
        if (!bindings.has(k)) bindings.set(k, new Set());
        for (const d of v) bindings.get(k).add(d);
      }
    }
    const ds = computeDiagnostics(model, path.basename(file), {
      aliasBindings: bindings,
      knownSymbols: symbols,
      closureComplete: complete,
      isEntryScript: isEntry,
      includeProblems: graph?.problems,
      duplicateSymbols: graph?.duplicateSymbols,
    });
    const bad = ds.filter((d) => d.severity === 'error' || d.severity === 'warning');
    if (bad.length) {
      noisy += bad.length;
      console.log(`  NOISE ${path.basename(file).padEnd(26)} ${bad.slice(0, 3).map((d) => `${d.code}: ${d.message.split('.')[0]}`).join(' | ')}`);
    }
  }
  if (noisy === 0) {
    pass++;
    console.log(`  ok    all ${files.length} known-good files stay clean through a full refresh`);
  } else {
    failures.push(`${noisy} error/warning diagnostics on known-good code through a full refresh`);
  }
}

for (const f of failures) console.log(`  FAIL  ${f}`);
console.log(`\n  ${pass}/${pass + failures.length} include assertions passed`);
if (failures.length) process.exit(1);
console.log('\nAll include assertions passed.');
