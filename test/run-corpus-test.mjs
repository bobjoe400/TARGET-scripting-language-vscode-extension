// The extension against real scripts other people wrote.
//
// This looks for diagnostics on scripts the compiler accepts - the shape a false
// positive takes. It does NOT assume every one is wrong. The compiler enforces almost
// nothing: verified here, it accepts MapKeyUMD with one argument and with nine, REXEC
// handles past 65536, and a script with no main() at all. Reporting what it will not is
// the whole point of the extension, so "the compiler was happy" is a prompt to look,
// never a verdict.
//
// Each finding is therefore judged once and recorded in corpus-expected.json with the
// reason. The test fails on findings that are NOT in that file - new disagreements,
// which is the thing worth being told about.
//
// Run `node tools/fetch-corpus.mjs` first. The scripts are fetched, never vendored:
// most of those repositories carry no licence, which means all rights reserved.
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stub = require('./vscode-stub.cjs');
const origLoad = Module._load;
Module._load = (r, p, m) => (r === 'vscode' ? stub : origLoad.call(Module, r, p, m));

const { FakeDocument } = require('./fake-document.cjs');
const { TargetIndex } = require(path.join(repoRoot, 'out/index.js'));
const { computeDiagnostics } = require(path.join(repoRoot, 'out/diagnostics.js'));
const { collectAliasBindings } = require(path.join(repoRoot, 'out/model.js'));
const R = require(path.join(repoRoot, 'out/runner.js'));
const { decode } = await import('./decode.mjs');

const corpus = path.resolve(process.env.TARGET_CORPUS ?? path.join(repoRoot, 'corpus'));
if (!fs.existsSync(corpus)) {
  console.log(`No corpus at ${corpus}. Run: node tools/fetch-corpus.mjs`);
  process.exit(0);
}
const install = R.findInstall();
if (!install?.interpreter) {
  console.log('TARGET is not installed here - the compiler cannot be the ground truth. Skipping.');
  process.exit(0);
}

const walk = (d, out = []) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(tmc|tmh|ttm)$/i.test(e.name)) out.push(p);
  }
  return out;
};
const all = walk(corpus);
const entries = all.filter((f) => /\.tmc$/i.test(f));
console.log('Corpus');
console.log('------');
console.log(`  ${all.length} files, ${entries.length} entry scripts, from ${new Set(all.map((f) => f.slice(corpus.length + 1).split(path.sep)[0])).size} repositories\n`);

const idx = new TargetIndex();
let compiled = 0, rejected = 0, clean = 0;
const falsePositives = new Map();
const seen = new Set();   // each file judged once, not once per entry that reaches it

for (const file of entries) {
  let res;
  try {
    res = await R.compileCheck(file, install);
  } catch (e) {
    continue;
  }
  if (!res.ok) { rejected++; continue; }     // the compiler rejects it: not ground truth
  compiled++;

  // Everything reachable from the script the compiler accepted - and ONLY that.
  // Diagnosing every file in the folder swept in siblings the compiler never saw, so a
  // genuine error in one of them counted against us: DCS_A-10C_Warthog.tmc really does
  // fail with "Name already defined: brightness_up", which this reported correctly and
  // the harness then scored as a false positive.
  const entryDoc = new FakeDocument(file, decode(fs.readFileSync(file)));
  stub.workspace.textDocuments = [entryDoc];
  const reach = idx.includeClosure(file, idx.getModel(entryDoc)).map((c) => c.file);

  for (const f of reach) {
    if (seen.has(f)) continue;
    seen.add(f);
    // refresh() never diagnoses the vendor headers, wherever a project keeps its copy.
    if (R.isInstalledHeader(f, install)) continue;
    let text;
    try { text = decode(fs.readFileSync(f)); } catch { continue; }
    const doc = new FakeDocument(f, text);
    stub.workspace.textDocuments = [doc];
    const model = idx.getModel(doc);
    const { symbols, complete } = idx.symbolTable(doc);
    const project = idx.projectSymbols(doc);
    const isEntry = /\.tmc$/i.test(f) && !idx.isIncludedElsewhere(doc);
    const graph = isEntry ? idx.analyzeIncludes(doc) : null;
    const bindings = new Map();
    for (const { model: m } of idx.includeClosure(f, model)) {
      for (const [k, v] of collectAliasBindings(m)) {
        if (!bindings.has(k)) bindings.set(k, new Set());
        for (const d of v) bindings.get(k).add(d);
      }
    }
    const ds = computeDiagnostics(model, path.basename(f), {
      aliasBindings: bindings, knownSymbols: symbols, closureComplete: complete,
      projectSymbols: project.symbols, projectComplete: project.complete,
      isEntryScript: isEntry, includeProblems: graph?.problems,
      duplicateSymbols: graph?.duplicateSymbols,
    });
    const errs = ds.filter((d) => d.severity === 'error');
    if (!errs.length) { clean++; continue; }
    for (const e of errs) {
      if (!falsePositives.has(e.code)) falsePositives.set(e.code, []);
      falsePositives.get(e.code).push(`${f.slice(corpus.length + 1)}: ${e.message.split('.')[0]}`);
    }
  }
}

console.log(`  compiler accepted : ${compiled}`);
console.log(`  compiler rejected : ${rejected}  (not ground truth - skipped)`);
console.log(`  files checked clean: ${clean}\n`);

const expectedPath = path.join(repoRoot, 'test/corpus-expected.json');
const expected = fs.existsSync(expectedPath) ? JSON.parse(fs.readFileSync(expectedPath, 'utf8')) : {};

const seenCodes = new Map();
for (const [code, hits] of falsePositives) seenCodes.set(code, hits.length);

let unexpected = 0;
for (const [code, hits] of [...falsePositives].sort((a, b) => b[1].length - a[1].length)) {
  const note = expected[code];
  if (note) {
    console.log(`  known  ${code}  (${hits.length})  ${note}`);
    continue;
  }
  unexpected += hits.length;
  console.log(`  NEW    ${code}  (${hits.length})`);
  for (const h of hits.slice(0, 5)) console.log(`           ${h}`);
  if (hits.length > 5) console.log(`           ...and ${hits.length - 5} more`);
}

// A rule that stops firing is as interesting as one that starts.
for (const code of Object.keys(expected)) {
  if (!seenCodes.has(code)) console.log(`  GONE   ${code}  no longer fires - was: ${expected[code]}`);
}

console.log();
if (unexpected === 0) {
  console.log('No new disagreements with the corpus.');
  process.exit(0);
}
console.log(`${unexpected} diagnostics on compiling code that have not been judged.`);
console.log('Investigate each, then record the verdict in test/corpus-expected.json.');
process.exit(1);
