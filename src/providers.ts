// Editor features. Everything reads from the shared index so completion, hover,
// symbols and navigation all describe the same view of the code.

import * as path from 'path';
import * as vscode from 'vscode';
import { TargetIndex } from './index';
import { callContextAt, collectAliasBindings, Decl, DocModel } from './model';
import { TokKind } from './lexer';
import {
  BuiltinFunction,
  constants,
  constantsByName,
  describeConstant,
  describeDevice,
  describeFunction,
  Device,
  devices,
  devicesByAlias,
  functions,
  functionsByName,
  keywords,
  NOT_IN_TARGET,
} from './builtins';

export const TARGET_SELECTOR: vscode.DocumentSelector = { language: 'target' };

/** Device handles a script binds itself, merged across the include graph. */
function aliasBindingsFor(index: TargetIndex, doc: vscode.TextDocument): Map<string, Set<string>> {
  const merged = new Map<string, Set<string>>();
  for (const { model } of index.includeClosure(doc.uri.fsPath, index.getModel(doc))) {
    for (const [k, v] of collectAliasBindings(model)) {
      if (!merged.has(k)) merged.set(k, new Set());
      for (const d of v) merged.get(k)!.add(d);
    }
  }
  return merged;
}

/** Every device a `&handle` argument could refer to. */
function devicesForHandle(handle: string, bindings: Map<string, Set<string>>): Device[] {
  const direct = devicesByAlias.get(handle);
  if (direct) return [direct];
  const out: Device[] = [];
  for (const b of bindings.get(handle) ?? []) {
    const d = devicesByAlias.get(b);
    if (d) out.push(d);
  }
  return out;
}

// =============================================================== completion
export class TargetCompletionProvider implements vscode.CompletionItemProvider {
  constructor(private index: TargetIndex) {}

  provideCompletionItems(
    doc: vscode.TextDocument,
    pos: vscode.Position
  ): vscode.CompletionItem[] {
    const model = this.index.getModel(doc);
    const offset = doc.offsetAt(pos);

    // Stay quiet inside comments; a string is different, because EXEC's argument is code.
    const tok = tokenContaining(model, offset);
    if (tok?.kind === TokKind.Comment) return [];

    const ctx = callContextAt(model, offset);
    const items: vscode.CompletionItem[] = [];

    if (ctx) {
      const fn = functionsByName.get(ctx.call.name);
      const linePrefix = doc.lineAt(pos).text.slice(0, pos.character);

      // First argument of a device-taking builtin: offer the devices.
      if (fn && fn.params[0]?.type === 'alias' && ctx.argIndex === 0) {
        const wroteAmp = /&\s*\w*$/.test(linePrefix);
        for (const d of devices) {
          const it = new vscode.CompletionItem(d.alias, vscode.CompletionItemKind.Class);
          it.detail = d.label;
          it.documentation = new vscode.MarkdownString(describeDevice(d));
          it.insertText = wroteAmp ? d.alias : `&${d.alias}`;
          it.sortText = `0_${d.alias}`;
          items.push(it);
        }
        // Handles the script binds itself are just as valid here.
        for (const [handle, bound] of aliasBindingsFor(this.index, doc)) {
          if (devicesByAlias.has(handle)) continue;
          const it = new vscode.CompletionItem(handle, vscode.CompletionItemKind.Variable);
          it.detail = `device handle → ${[...bound].join(', ')}`;
          it.insertText = wroteAmp ? handle : `&${handle}`;
          it.sortText = `0a_${handle}`;
          items.push(it);
        }
        return items;
      }

      // Second argument: the control on whichever device the first argument names.
      // This is the completion nobody can do from memory.
      if (fn && fn.params[0]?.type === 'alias' && ctx.argIndex === 1 && ctx.call.args[0]) {
        const m = ctx.call.args[0].text.match(/^&\s*([A-Za-z_]\w*)$/);
        if (m) {
          const bindings = aliasBindingsFor(this.index, doc);
          const devs = devicesForHandle(m[1], bindings);
          // Axis functions want axes first; the MapKey family wants buttons.
          const axisFirst = /Axis|Curve/.test(fn.name);
          const seen = new Set<string>();
          for (const d of devs) {
            const groups = axisFirst
              ? [
                  { list: d.axes, rank: 0, kind: 'axis' },
                  { list: d.hats, rank: 1, kind: 'hat' },
                  { list: d.buttons, rank: 2, kind: 'button' },
                ]
              : [
                  { list: d.buttons, rank: 0, kind: 'button' },
                  { list: d.hats, rank: 1, kind: 'hat' },
                  { list: d.axes, rank: 2, kind: 'axis' },
                ];
            for (const g of groups) {
              for (const c of g.list) {
                if (seen.has(c.name)) continue;
                seen.add(c.name);
                const it = new vscode.CompletionItem(
                  c.name,
                  g.kind === 'button' ? vscode.CompletionItemKind.EnumMember : vscode.CompletionItemKind.Property
                );
                it.detail = `${d.label} ${g.kind} · ${c.value}`;
                if (c.doc) it.documentation = new vscode.MarkdownString(c.doc);
                // Pad the index so numeric order reads naturally in the list.
                const n = parseInt(c.value, 10);
                const key = Number.isFinite(n) ? String(n).padStart(4, '0') : c.value;
                it.sortText = `${g.rank}_${key}`;
                items.push(it);
              }
            }
          }
          if (items.length) return items;
        }
      }
    }

    // ---- general completions --------------------------------------------------
    for (const f of functions) {
      if (f.internal) continue;
      const it = new vscode.CompletionItem(f.name, vscode.CompletionItemKind.Function);
      it.detail = f.signature;
      it.documentation = new vscode.MarkdownString(describeFunction(f));
      it.sortText = `2_${f.name}`;
      items.push(it);
    }
    for (const c of constants) {
      const it = new vscode.CompletionItem(c.name, vscode.CompletionItemKind.Constant);
      it.detail = c.value;
      it.documentation = new vscode.MarkdownString(describeConstant(c));
      it.sortText = `3_${c.name}`;
      items.push(it);
    }
    for (const d of devices) {
      const it = new vscode.CompletionItem(d.alias, vscode.CompletionItemKind.Class);
      it.detail = d.label;
      it.documentation = new vscode.MarkdownString(describeDevice(d));
      it.sortText = `3a_${d.alias}`;
      items.push(it);
    }
    for (const k of keywords) {
      items.push(new vscode.CompletionItem(k, vscode.CompletionItemKind.Keyword));
    }
    // Symbols the user declared, across their includes.
    const seenSym = new Set<string>();
    for (const { decl, file } of this.index.visibleDecls(doc)) {
      if (seenSym.has(decl.name)) continue;
      seenSym.add(decl.name);
      const it = new vscode.CompletionItem(decl.name, declKindToCompletionKind(decl.kind));
      it.detail = decl.detail;
      it.documentation = new vscode.MarkdownString(`*declared in \`${path.basename(file)}\`*`);
      it.sortText = `1_${decl.name}`;
      items.push(it);
    }
    return items;
  }
}

function declKindToCompletionKind(kind: Decl['kind']): vscode.CompletionItemKind {
  switch (kind) {
    case 'function':
      return vscode.CompletionItemKind.Function;
    case 'define':
      return vscode.CompletionItemKind.Constant;
    case 'alias':
      return vscode.CompletionItemKind.Reference;
    case 'struct':
      return vscode.CompletionItemKind.Struct;
    default:
      return vscode.CompletionItemKind.Variable;
  }
}

function tokenContaining(model: DocModel, offset: number) {
  for (const t of model.tokens) {
    if (offset >= t.start && offset <= t.end) return t;
    if (t.start > offset) break;
  }
  return null;
}

// =============================================================== hover
export class TargetHoverProvider implements vscode.HoverProvider {
  constructor(private index: TargetIndex) {}

  provideHover(doc: vscode.TextDocument, pos: vscode.Position): vscode.Hover | null {
    const range = doc.getWordRangeAtPosition(pos, /[A-Za-z_]\w*/);
    if (!range) return null;
    const word = doc.getText(range);

    const md = (s: string) => new vscode.Hover(new vscode.MarkdownString(s), range);

    const fn = functionsByName.get(word);
    if (fn) return md(describeFunction(fn));

    const dev = devicesByAlias.get(word);
    if (dev) return md(describeDevice(dev));

    const konst = constantsByName.get(word);
    if (konst) return md(describeConstant(konst));

    if (NOT_IN_TARGET[word]) return md(`**Not part of TARGET.** ${NOT_IN_TARGET[word]}`);

    for (const { decl, file } of this.index.visibleDecls(doc)) {
      if (decl.name !== word) continue;
      const parts = ['```c', decl.detail, '```'];
      if (file !== doc.uri.fsPath) parts.push('', `*declared in \`${path.basename(file)}\`*`);
      return md(parts.join('\n'));
    }

    // A handle the script binds to hardware.
    const bound = aliasBindingsFor(this.index, doc).get(word);
    if (bound?.size) {
      return md(`Device handle, bound to ${[...bound].map((b) => `\`${b}\``).join(' or ')}.`);
    }
    return null;
  }
}

// =============================================================== signature help
export class TargetSignatureProvider implements vscode.SignatureHelpProvider {
  constructor(private index: TargetIndex) {}

  provideSignatureHelp(doc: vscode.TextDocument, pos: vscode.Position): vscode.SignatureHelp | null {
    const model = this.index.getModel(doc);
    const ctx = callContextAt(model, doc.offsetAt(pos));
    if (!ctx) return null;

    const help = new vscode.SignatureHelp();
    help.activeSignature = 0;

    const fn = functionsByName.get(ctx.call.name);
    if (fn) {
      const sig = new vscode.SignatureInformation(fn.signature, new vscode.MarkdownString(fn.doc || ''));
      sig.parameters = fn.params.map(
        (p) =>
          new vscode.ParameterInformation(
            `${p.type ? p.type + ' ' : ''}${p.name}${p.default ? ' = ' + p.default : ''}`
          )
      );
      help.signatures = [sig];
      help.activeParameter = Math.min(ctx.argIndex, Math.max(0, fn.params.length - 1));
      return help;
    }

    for (const { decl } of this.index.visibleDecls(doc)) {
      if (decl.kind !== 'function' || decl.name !== ctx.call.name) continue;
      const sig = new vscode.SignatureInformation(decl.detail);
      const inner = decl.detail.slice(decl.detail.indexOf('(') + 1, decl.detail.lastIndexOf(')'));
      sig.parameters = inner
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => new vscode.ParameterInformation(p));
      help.signatures = [sig];
      help.activeParameter = Math.min(ctx.argIndex, Math.max(0, sig.parameters.length - 1));
      return help;
    }
    return null;
  }
}

// =============================================================== symbols
const SYMBOL_KIND: Record<Decl['kind'], vscode.SymbolKind> = {
  function: vscode.SymbolKind.Function,
  variable: vscode.SymbolKind.Variable,
  define: vscode.SymbolKind.Constant,
  alias: vscode.SymbolKind.Interface,
  struct: vscode.SymbolKind.Struct,
};

export class TargetSymbolProvider implements vscode.DocumentSymbolProvider {
  constructor(private index: TargetIndex) {}

  provideDocumentSymbols(doc: vscode.TextDocument): vscode.DocumentSymbol[] {
    const model = this.index.getModel(doc);
    const out: vscode.DocumentSymbol[] = [];
    for (const d of model.decls) {
      if (!d.global) continue;
      const full = new vscode.Range(doc.positionAt(d.fullStart), doc.positionAt(d.fullEnd));
      const sel = new vscode.Range(doc.positionAt(d.start), doc.positionAt(d.end));
      out.push(
        new vscode.DocumentSymbol(d.name, d.detail, SYMBOL_KIND[d.kind], full, sel.start.isBefore(full.start) ? full : sel)
      );
    }
    return out;
  }
}

// =============================================================== definition
export class TargetDefinitionProvider implements vscode.DefinitionProvider {
  constructor(private index: TargetIndex) {}

  provideDefinition(doc: vscode.TextDocument, pos: vscode.Position): vscode.Location[] {
    const model = this.index.getModel(doc);
    const offset = doc.offsetAt(pos);

    // On an include path, go to the included file.
    for (const inc of model.includes) {
      if (offset < inc.start || offset > inc.end) continue;
      const resolved = this.index.resolveInclude(doc.uri.fsPath, inc.path);
      if (resolved) return [new vscode.Location(vscode.Uri.file(resolved), new vscode.Position(0, 0))];
      return [];
    }

    const range = doc.getWordRangeAtPosition(pos, /[A-Za-z_]\w*/);
    if (!range) return [];
    const word = doc.getText(range);

    const out: vscode.Location[] = [];
    for (const { file, model: m } of this.index.includeClosure(doc.uri.fsPath, model)) {
      for (const d of m.decls) {
        if (d.name !== word) continue;
        const uri = vscode.Uri.file(file);
        out.push(new vscode.Location(uri, locateRange(m, d)));
      }
    }
    return out;
  }
}

/** Offsets to a Range, computed against the file's own text rather than the open doc. */
function locateRange(model: DocModel, d: Decl): vscode.Range {
  const toPos = (offset: number) => {
    const before = model.text.slice(0, offset);
    const line = before.split('\n').length - 1;
    const col = offset - (before.lastIndexOf('\n') + 1);
    return new vscode.Position(line, col);
  };
  return new vscode.Range(toPos(d.start), toPos(d.end));
}
