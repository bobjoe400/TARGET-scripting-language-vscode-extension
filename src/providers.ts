// Editor features. Everything reads from the shared index so completion, hover,
// symbols and navigation all describe the same view of the code.

import * as path from 'path';
import * as vscode from 'vscode';
import { TargetIndex } from './index';
import { callContextAt, collectAliasBindings, Decl, DocModel } from './model';
import { TokKind, tokenAt } from './lexer';
import { BindingRef, humanizeAction, GAME_ELITE } from './binds';
import {
  allUsbCodes,
  anyControlLabel,
  anyDefaultDxButton,
  argumentDomain,
  eventDomainNames,
  constants,
  constantsByName,
  controlLabel,
  defaultDxButton,
  describeConstant,
  describeParam,
  describeDevice,
  describeFunction,
  Device,
  devices,
  devicesByAlias,
  functions,
  functionsByName,
  keywords,
  NOT_IN_TARGET,
  own,
  takesDeviceFirst,
  usbKeyName,
  VARIADIC,
} from './builtins';

export const TARGET_SELECTOR: vscode.DocumentSelector = { language: 'target' };

/**
 * Markdown for a symbol the user declared: its signature, the comment block above it,
 * and where it came from. Scripts are split across a dozen headers, so saying which
 * file a name lives in is half the value.
 */
function describeDecl(decl: Decl, file: string, currentFile: string): string {
  const parts = ['```c', decl.detail, '```'];
  if (decl.doc.trim()) {
    // Single newlines do not break lines in markdown; these blocks are written as
    // lines and are meant to stay that way.
    parts.push('', decl.doc.split('\n').join('  \n'));
  }
  if (file !== currentFile) parts.push('', `*declared in \`${path.basename(file)}\`*`);
  return parts.join('\n');
}

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
/**
 * What an item's documentation should be built from, recorded on the item so the
 * markdown can be produced only when the user highlights it. Building it up front for
 * the general list meant ~3,000 items and ~200 KB of markdown crossing the extension
 * host boundary on every keystroke, nearly all of it never read.
 */
type DocSource =
  | { kind: 'function'; name: string }
  | { kind: 'constant'; name: string }
  | { kind: 'device'; alias: string }
  | { kind: 'decl'; name: string; file: string; detail: string; doc: string };

interface LazyItem extends vscode.CompletionItem {
  __doc?: DocSource;
}

export class TargetCompletionProvider implements vscode.CompletionItemProvider {
  constructor(private index: TargetIndex) {}

  /** Adds the script's own `define`s, which belong wherever a constant does. */
  private addUserDefines(
    doc: vscode.TextDocument,
    items: vscode.CompletionItem[],
    sortPrefix: string
  ): void {
    const seen = new Set(items.map((i) => String(i.label)));
    for (const { decl, file } of this.index.visibleDecls(doc)) {
      if (decl.kind !== 'define' || seen.has(decl.name)) continue;
      seen.add(decl.name);
      const it: LazyItem = new vscode.CompletionItem(decl.name, vscode.CompletionItemKind.Constant);
      it.detail = decl.detail;
      it.__doc = { kind: 'decl', name: decl.name, file, detail: decl.detail, doc: decl.doc };
      it.sortText = `${sortPrefix}${decl.name}`;
      items.push(it);
    }
  }

  /** Builds an item's documentation on demand, as VS Code highlights it. */
  resolveCompletionItem(item: vscode.CompletionItem): vscode.CompletionItem {
    const lazy = item as LazyItem;
    if (item.documentation || !lazy.__doc) return item;
    const src = lazy.__doc;
    let md: string | null = null;
    if (src.kind === 'function') {
      const f = functionsByName.get(src.name);
      if (f) md = describeFunction(f);
    } else if (src.kind === 'constant') {
      const c = constantsByName.get(src.name);
      if (c) md = describeConstant(c);
    } else if (src.kind === 'device') {
      const d = devicesByAlias.get(src.alias);
      if (d) md = describeDevice(d);
    } else {
      md = [
        '```c',
        src.detail,
        '```',
        src.doc.trim() ? '\n' + src.doc.split('\n').join('  \n') : '',
        `\n*declared in \`${path.basename(src.file)}\`*`,
      ]
        .filter(Boolean)
        .join('\n');
    }
    if (md) item.documentation = new vscode.MarkdownString(md);
    return item;
  }

  provideCompletionItems(
    doc: vscode.TextDocument,
    pos: vscode.Position
  ): vscode.CompletionItem[] {
    const model = this.index.getModel(doc);
    const offset = doc.offsetAt(pos);

    const tok = tokenContaining(model, offset);
    if (tok?.kind === TokKind.Comment) return [];

    // A string is only code when it is EXEC's or REXEC's argument. Everywhere else -
    // a file path, a printf format, a VID/PID alias - it is text, and offering the
    // whole symbol table inside it is noise. '&' and ',' are trigger characters, so
    // this fired on `alias A = "VID_044F&"` and on any comma in a format string.
    if (tok?.kind === TokKind.String) {
      const enclosing = callContextAt(model, offset);
      const isExecCode = enclosing?.call.name === 'EXEC' || enclosing?.call.name === 'REXEC';
      if (!isExecCode) return [];
    }

    // Inside USB[...] the only sensible content is a scancode, and the hex is
    // meaningless on its own, so offer the key names instead.
    const beforeCursor = doc.lineAt(pos).text.slice(0, pos.character);
    if (/\bUSB\s*\[\s*(0[xX][0-9A-Fa-f]*)?$/.test(beforeCursor)) {
      return allUsbCodes().map(({ hex, name }) => {
        const it = new vscode.CompletionItem(`0x${hex}`, vscode.CompletionItemKind.Value);
        it.detail = name;
        it.filterText = `0x${hex} ${name}`;
        it.documentation = new vscode.MarkdownString(`**${name}**\n\nUSB HID keyboard code \`0x${hex}\`.`);
        it.sortText = hex;
        return it;
      });
    }

    const ctx = callContextAt(model, offset);
    const items: vscode.CompletionItem[] = [];

    if (ctx) {
      const fn = functionsByName.get(ctx.call.name);
      const linePrefix = doc.lineAt(pos).text.slice(0, pos.character);

      // First argument of a device-taking builtin: offer the devices.
      if (fn && takesDeviceFirst(fn.name) && ctx.argIndex === 0) {
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

      // An argument with a known domain offers only that domain. Without this every
      // position offers all 1049 symbols, so the event argument of MapKey suggests
      // OSB01 and SOL_B5 - controls of devices that are not even in the call.
      if (fn) {
        const domain = argumentDomain(fn.name, ctx.argIndex);
        if (domain?.kind === 'constants') {
          for (const name of domain.names) {
            const c = constantsByName.get(name);
            const it = new vscode.CompletionItem(name, vscode.CompletionItemKind.EnumMember);
            it.detail = c ? `${domain.title} \u00b7 ${c.value}` : domain.title;
            if (c) it.documentation = new vscode.MarkdownString(describeConstant(c));
            it.sortText = `0_${name}`;
            items.push(it);
          }
          // The script's own defines belong in any constant position: real scripts
          // write `define HUDMode ...` and then use it as a MapKey argument, and a
          // narrowed domain that omits them hides the dominant idiom in the language.
          this.addUserDefines(doc, items, '1_');
          if (items.length) return items;
        }
        if (domain?.kind === 'event') {
          const { functions: evFns, constants: evConsts } = eventDomainNames();
          for (const n of evFns) {
            const f = functionsByName.get(n);
            if (!f) continue;
            const it: LazyItem = new vscode.CompletionItem(n, vscode.CompletionItemKind.Function);
            it.detail = f.signature;
            it.__doc = { kind: 'function', name: n };
            it.sortText = `0_${n}`;
            items.push(it);
          }
          for (const n of evConsts) {
            const c = constantsByName.get(n);
            const it: LazyItem = new vscode.CompletionItem(n, vscode.CompletionItemKind.Constant);
            if (c) {
              it.detail = c.value;
              it.__doc = { kind: 'constant', name: n };
            }
            it.sortText = `1_${n}`;
            items.push(it);
          }
          // Events the script declares itself belong here too.
          const seenEv = new Set<string>();
          for (const { decl, file } of this.index.visibleDecls(doc)) {
            if (decl.kind !== 'variable' && decl.kind !== 'function' && decl.kind !== 'define') continue;
            if (seenEv.has(decl.name)) continue;
            seenEv.add(decl.name);
            const it: LazyItem = new vscode.CompletionItem(decl.name, declKindToCompletionKind(decl.kind));
            it.detail = decl.detail;
            it.__doc = { kind: 'decl', name: decl.name, file, detail: decl.detail, doc: decl.doc };
            it.sortText = `2_${decl.name}`;
            items.push(it);
          }
          if (items.length) return items;
        }
      }

      // Second argument: the control on whichever device the first argument names.
      // This is the completion nobody can do from memory.
      if (fn && takesDeviceFirst(fn.name) && ctx.argIndex === 1 && ctx.call.args[0]) {
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
                // The physical control's name reads far better than its index:
                // EFLNORM means nothing, "Engine Fuel Flow Left" means everything.
                const described = controlLabel(d.alias, c.name);
                it.detail = described
                  ? `${described} · ${d.label} ${g.kind}`
                  : `${d.label} ${g.kind} · ${c.value}`;
                const dxDefault = defaultDxButton(d.alias, c.name);
                const docText = [
                  described ? `**${described}**` : '',
                  c.doc,
                  dxDefault ? `Sends \`DX${dxDefault}\` by default, with no script running.` : '',
                  `*${d.label} ${g.kind} · index ${c.value}*`,
                ]
                  .filter(Boolean)
                  .join('\n\n');
                it.documentation = new vscode.MarkdownString(docText);
                // Pad the index so numeric order reads naturally in the list.
                const n = parseInt(c.value, 10);
                const key = Number.isFinite(n) ? String(n).padStart(4, '0') : c.value;
                it.sortText = `${g.rank}_${key}`;
                items.push(it);
              }
            }
          }
          // A define standing in for a button index is ordinary in real scripts.
          this.addUserDefines(doc, items, '3_');
          if (items.length) return items;
        }
      }
    }

    // ---- general completions --------------------------------------------------
    for (const f of functions) {
      if (f.internal) continue;
      const it: LazyItem = new vscode.CompletionItem(f.name, vscode.CompletionItemKind.Function);
      it.detail = f.signature;
      it.__doc = { kind: 'function', name: f.name };
      it.sortText = `2_${f.name}`;
      items.push(it);
    }
    for (const c of constants) {
      const it: LazyItem = new vscode.CompletionItem(c.name, vscode.CompletionItemKind.Constant);
      it.detail = c.value;
      it.__doc = { kind: 'constant', name: c.name };
      it.sortText = `3_${c.name}`;
      items.push(it);
    }
    for (const d of devices) {
      const it: LazyItem = new vscode.CompletionItem(d.alias, vscode.CompletionItemKind.Class);
      it.detail = d.label;
      it.__doc = { kind: 'device', alias: d.alias };
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
      const it: LazyItem = new vscode.CompletionItem(decl.name, declKindToCompletionKind(decl.kind));
      it.detail = decl.detail;
      it.__doc = { kind: 'decl', name: decl.name, file, detail: decl.detail, doc: decl.doc };
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

/** The lexer already provides this as a binary search; a linear scan was wasteful. */
function tokenContaining(model: DocModel, offset: number) {
  return tokenAt(model.tokens, offset);
}

// =============================================================== hover
export class TargetHoverProvider implements vscode.HoverProvider {
  constructor(private index: TargetIndex) {}

  provideHover(doc: vscode.TextDocument, pos: vscode.Position): vscode.Hover | null {
    // USB[0x2C] first: the hex is the interesting part and is not a word.
    const usbRange = doc.getWordRangeAtPosition(pos, /USB\s*\[\s*0[xX][0-9A-Fa-f]+\s*\]/);
    if (usbRange) {
      const m = /0[xX]([0-9A-Fa-f]+)/.exec(doc.getText(usbRange));
      const name = m ? usbKeyName(m[1]) : null;
      if (name) {
        const normalised = m![1].toUpperCase().replace(/^0+(?=.)/, '').padStart(2, '0');
        const parts = [
          // Escaped: several key names are punctuation, and "Keypad *" rendered as
          // literal asterisks around a broken bold span.
          `**${escapeMarkdown(name)}**`,
          `USB HID keyboard code \`0x${normalised}\`, sent through the virtual keyboard.`,
        ];
        // What the game does with that key, if a .binds file is to hand. The script
        // itself cannot say: it sends keystrokes and the game decides. Looked up by the
        // same normalised code, or USB[0x018] found its key name and missed its binding.
        const binds = this.index.getBindsIndex(doc);
        const bound = binds.byUsbCode.get(normalised);
        if (bound?.length) parts.push(...renderBindings(bound, binds.activePreset));
        return new vscode.Hover(new vscode.MarkdownString(parts.join('\n\n')), usbRange);
      }
    }

    const range = doc.getWordRangeAtPosition(pos, /[A-Za-z_]\w*/);
    if (!range) return null;
    const word = doc.getText(range);

    const md = (s: string) => new vscode.Hover(new vscode.MarkdownString(s), range);

    const fn = functionsByName.get(word);
    if (fn) return md(describeFunction(fn));

    const dev = devicesByAlias.get(word);
    if (dev) return md(describeDevice(dev));

    const konst = constantsByName.get(word);
    if (konst) {
      // A control constant is far more useful described than numbered.
      const described = anyControlLabel(word);
      const dxDefault = anyDefaultDxButton(word);
      const parts = [
        described ? `**${described.label}**` : '',
        describeConstant(konst),
        dxDefault ? `Sends \`DX${dxDefault.dx}\` by default on the ${dxDefault.device}, with no script running.` : '',
      ].filter(Boolean);
      // What the games do with this virtual button. A script's whole purpose is to put
      // a button under a control, and until now the editor could say which button but
      // never what it does - even though every game's mapping file is sitting right
      // there beside the script.
      const dxNumber = /^DX(\d+)$/.exec(word);
      const forButton = dxNumber
        ? this.index.getBindsIndex(doc).byButton.get(Number(dxNumber[1]))
        : dxDefault
          ? this.index.getBindsIndex(doc).byButton.get(dxDefault.dx)
          : undefined;
      if (forButton?.length) {
        parts.push(...renderBindings(forButton, this.index.getBindsIndex(doc).activePreset));
      }
      return md(parts.join('\n\n'));
    }

    const notInTarget = own(NOT_IN_TARGET, word);
    if (notInTarget) return md(`**Not part of TARGET.** ${notInTarget}`);

    for (const { decl, file } of this.index.visibleDecls(doc)) {
      if (decl.name !== word) continue;
      return md(describeDecl(decl, file, doc.uri.fsPath));
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
      const variadicNote = VARIADIC.has(fn.name) ? 'Takes any number of arguments.' : '';
      const sig = new vscode.SignatureInformation(
        VARIADIC.has(fn.name) ? `${fn.returnType} ${fn.name}(...)` : fn.signature,
        new vscode.MarkdownString([variadicNote, fn.doc].filter(Boolean).join('\n\n'))
      );
      sig.parameters = fn.params.map((p) => {
        const label = `${p.type ? p.type + ' ' : ''}${p.name}${p.default ? ' = ' + p.default : ''}`;
        // `keyIU` and friends mean nothing without the layer scheme spelled out.
        const explained = describeParam(fn.name, p.name);
        return new vscode.ParameterInformation(
          label,
          explained ? new vscode.MarkdownString(explained) : undefined
        );
      });
      help.signatures = [sig];
      help.activeParameter = Math.min(ctx.argIndex, Math.max(0, fn.params.length - 1));
      return help;
    }

    for (const { decl } of this.index.visibleDecls(doc)) {
      if (decl.kind !== 'function' || decl.name !== ctx.call.name) continue;
      const sig = new vscode.SignatureInformation(
        decl.detail,
        decl.doc.trim() ? new vscode.MarkdownString(decl.doc.split('\n').join('  \n')) : undefined
      );
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
      // `int a, b, c;` gives every name the same fullStart, so sibling ranges nested
      // inside one another. DocumentSymbol expects nesting through children, not
      // overlapping ranges, so a name's range is its own span when it shares a
      // statement with others.
      const sharesStatement = model.decls.some(
        (o) => o !== d && o.fullStart === d.fullStart && o.start !== d.start
      );
      const full = sharesStatement
        ? new vscode.Range(doc.positionAt(d.start), doc.positionAt(d.fullEnd))
        : new vscode.Range(doc.positionAt(d.fullStart), doc.positionAt(d.fullEnd));
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
        // A local in some other file's function is not a definition of this name.
        // Without this, any short name - i, x, temp, counter - opened a peek list of
        // unrelated locals instead of jumping.
        if (!d.global && file !== doc.uri.fsPath) continue;
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

/**
 * Markdown-safe text: key names are often punctuation, and "Keypad *" rendered as
 * literal asterisks around a broken bold span.
 *
 * Only the characters that actually mean something inline are escaped. Escaping the
 * whole punctuation set put backslashes through names like Clicker-ENHANCED_Warthog in
 * any renderer that does not honour the escape.
 */
export function escapeMarkdown(text: string): string {
  return text.replace(/([\\`*_[\]<>&~])/g, '\\$1');
}

/**
 * What the game does with a key, said once.
 *
 * Bindings arrive as one flat row per slot per file, which made a hover that repeated
 * the same action several times and then hid the rest behind "and 6 more". They are
 * folded to one line per action, the slot carried as a suffix, and the game's
 * CamelCase names written out.
 */
export function renderBindings(bound: BindingRef[], activePreset: string | null): string[] {
  const LIMIT = 8;
  const byGame = new Map<string, BindingRef[]>();
  for (const b of bound) {
    if (!byGame.has(b.game)) byGame.set(b.game, []);
    byGame.get(b.game)!.push(b);
  }

  const line = (action: string, info: { slots: Set<string>; modifiers: string[] }): string => {
    const bits: string[] = [];
    // The modifier is the part that changes what the key does on its own, so it leads.
    if (info.modifiers.length) bits.push(`with ${escapeMarkdown(info.modifiers.join(' + '))}`);
    // "primary" is the default slot, and repeating it down every line was noise. A
    // binding that exists only in the secondary slot is worth saying.
    if (info.slots.size === 1 && !info.slots.has('primary') && !info.slots.has('')) {
      bits.push([...info.slots][0]);
    }
    const suffix = bits.length ? ` \u2014 ${bits.join(', ')}` : '';
    return `- ${escapeMarkdown(humanizeAction(action))}${suffix}`;
  };

  const out: string[] = [];
  for (const [game, refs] of byGame) {
    const byFile = new Map<string, Map<string, { slots: Set<string>; modifiers: string[] }>>();
    for (const b of refs) {
      if (!byFile.has(b.file)) byFile.set(b.file, new Map());
      const actions = byFile.get(b.file)!;
      const existing = actions.get(b.action);
      if (existing) {
        existing.slots.add(b.slot.toLowerCase());
        if (!existing.modifiers.length) existing.modifiers = b.modifiers;
      } else {
        actions.set(b.action, { slots: new Set([b.slot.toLowerCase()]), modifiers: b.modifiers });
      }
    }

    if (byFile.size === 1) {
      const [file, actions] = [...byFile][0];
      // A preset is an Elite Dangerous idea; for the others the file itself is the name
      // worth showing, since it is per-aircraft or per-export.
      const heading =
        activePreset !== null && game === GAME_ELITE
          ? `In your active ${game} preset, **${escapeMarkdown(activePreset)}**:`
          : `In **${escapeMarkdown(file)}** (${game}):`;
      const rows = [...actions].slice(0, LIMIT).map(([a, i]) => line(a, i));
      if (actions.size > LIMIT) rows.push(`- \u2026and ${actions.size - LIMIT} more`);
      out.push(heading, rows.join('\n'));
      continue;
    }

    // Several files of one game disagree - different aircraft in DCS, or no active
    // preset identified - so which said what is the point. Named, not merged.
    out.push(`${game} \u2014 bound in ${byFile.size} files:`);
    const perFile = Math.max(2, Math.floor(LIMIT / byFile.size));
    for (const [file, actions] of byFile) {
      const rows = [...actions].slice(0, perFile).map(([a, i]) => line(a, i));
      if (actions.size > perFile) rows.push(`- \u2026and ${actions.size - perFile} more`);
      out.push(`**${escapeMarkdown(file)}**\n${rows.join('\n')}`);
    }
  }
  return out;
}
