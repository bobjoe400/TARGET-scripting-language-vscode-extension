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

for (const f of failures) console.log(`  FAIL  ${f}`);
console.log(`\n  ${pass}/${pass + failures.length} include assertions passed`);
if (failures.length) process.exit(1);
console.log('\nAll include assertions passed.');
