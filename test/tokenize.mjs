// Loads the real grammar through vscode-textmate, the same engine VS Code uses,
// so a passing test means the editor will behave the same way.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// Both ship as CommonJS; require() gives the real namespace under ESM.
const require = createRequire(import.meta.url);
const oniguruma = require('vscode-oniguruma');
const vsctm = require('vscode-textmate');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

let registry;
export async function getGrammar() {
  if (!registry) {
    const wasmBin = fs.readFileSync(
      path.join(repoRoot, 'node_modules/vscode-oniguruma/release/onig.wasm')
    ).buffer;
    await oniguruma.loadWASM(wasmBin);
    registry = new vsctm.Registry({
      onigLib: Promise.resolve({
        createOnigScanner: (s) => new oniguruma.OnigScanner(s),
        createOnigString: (s) => new oniguruma.OnigString(s),
      }),
      loadGrammar: async (scopeName) => {
        if (scopeName !== 'source.target') return null;
        const p = path.join(repoRoot, 'syntaxes/target.tmLanguage.json');
        return vsctm.parseRawGrammar(fs.readFileSync(p, 'utf8'), p);
      },
    });
  }
  return registry.loadGrammar('source.target');
}

/**
 * Tokenize text into [{line, text, scopes}] with the innermost scope last.
 * Also reports the rule stack left open at EOF: anything other than INITIAL means
 * the grammar fell into a string or comment it never climbed back out of.
 */
export async function tokenizeFull(text) {
  const grammar = await getGrammar();
  let ruleStack = vsctm.INITIAL;
  const out = [];
  text.split(/\r?\n/).forEach((line, lineNo) => {
    const r = grammar.tokenizeLine(line, ruleStack);
    for (const t of r.tokens) {
      const s = line.substring(t.startIndex, t.endIndex);
      if (s.trim()) out.push({ line: lineNo + 1, text: s, scopes: t.scopes });
    }
    ruleStack = r.ruleStack;
  });
  // A fresh stack object is returned per line, so compare depth rather than identity:
  // depth 1 is the top level, anything deeper is a rule left open at EOF.
  return { tokens: out, endedClean: ruleStack.depth === 1, endDepth: ruleStack.depth, ruleStack };
}

export async function tokenizeText(text) {
  return (await tokenizeFull(text)).tokens;
}

/** The most specific scope, which is what determines the colour shown. */
export const leaf = (tok) => tok.scopes[tok.scopes.length - 1];
