// Editor features. Everything reads from the shared index so completion, hover,
// symbols and navigation all describe the same view of the code.

import * as path from 'path';
import * as vscode from 'vscode';
import { TargetIndex } from './index';
import { callContextAt, Decl, DocModel } from './model';
import { TokKind, tokenAt } from './lexer';
import { BindingRef, Chord, chordMatches, parseChord, GAME_ELITE } from './binds';
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
  devices,
  devicesByAlias,
  functions,
  functionsByName,
  keywords,
  normalizeUsbCode,
  NOT_IN_TARGET,
  own,
  shortKeyName,
  takesDeviceFirst,
  usbKeyName,
  VARIADIC,
  devicesForHandle,
} from './builtins';

export const TARGET_SELECTOR: vscode.DocumentSelector = { language: 'target' };

// Lives with the USB table in builtins, because diagnostics needs the same rule and
// cannot import this module - it pulls in vscode. Re-exported here, where it reads as
// part of the hover's vocabulary.
export { shortKeyName };

/**
 * Markdown for a symbol the user declared: its signature, the comment block above it,
 * and where it came from. Scripts are split across a dozen headers, so saying which
 * file a name lives in is half the value.
 */
function describeDecl(
  decl: { detail: string; doc: string },
  file: string,
  /** Omitted where there is no document to compare against, as in a completion item. */
  currentFile?: string
): string {
  const parts = ['```c', decl.detail, '```'];
  if (decl.doc.trim()) {
    // Single newlines do not break lines in markdown; these blocks are written as
    // lines and are meant to stay that way.
    parts.push('', decl.doc.split('\n').join('  \n'));
  }
  if (file !== currentFile) parts.push('', `*declared in \`${path.basename(file)}\`*`);
  return parts.join('\n');
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
      // No current file to compare against here, so the note always shows - which is
      // what a completion list wants: the name is being offered out of context.
      md = describeDecl(src, src.file);
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
        // What is shown collapses the table's "u U" pair; what is MATCHED keeps it, so
        // typing an upper-case U still finds 0x18. The documentation no longer restates
        // the code, which is the item's own label.
        it.detail = shortKeyName(name);
        it.filterText = `0x${hex} ${name}`;
        it.documentation = new vscode.MarkdownString(`**${escapeMarkdown(shortKeyName(name))}**`);
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
        for (const [handle, bound] of this.index.aliasBindings(doc)) {
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
          const bindings = this.index.aliasBindings(doc);
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

/**
 * A `USB[0x..]` scancode reference as written in a script. Used as a word pattern by
 * both the hover and the peek command, which must agree on what they are pointing at.
 */
export const USB_REF_RE = /USB\s*\[\s*0[xX][0-9A-Fa-f]+\s*\]/;

/** The scancode inside such a reference, keyed the way the binds index is. */
export function usbCodeInRef(text: string): string | null {
  const m = /0[xX]([0-9A-Fa-f]+)/.exec(text);
  return m ? normalizeUsbCode(m[1]) : null;
}

// =============================================================== hover
export class TargetHoverProvider implements vscode.HoverProvider {
  constructor(private index: TargetIndex) {}

  provideHover(doc: vscode.TextDocument, pos: vscode.Position): vscode.Hover | null {
    // USB[0x2C] first: the hex is the interesting part and is not a word.
    const usbRange = doc.getWordRangeAtPosition(pos, USB_REF_RE);
    if (usbRange) {
      const normalised = usbCodeInRef(doc.getText(usbRange));
      const name = normalised ? usbKeyName(normalised) : null;
      if (normalised && name) {
        // The modifiers written before the key are part of what this line sends, so they
        // are part of the question. Read backwards rather than widened into the trigger
        // regex, which still matches USB[0x4F] alone.
        const lineText = doc.lineAt(usbRange.start).text;
        // Not inside a comment: the corpus has ASCII reference tables where the words
        // before a USB[..] are prose, and "NUMPAD +" would be read as a modifier.
        const model = this.index.getModel(doc);
        const tok = tokenAt(model.tokens, doc.offsetAt(usbRange.start));
        const inComment = tok?.kind === TokKind.Comment;
        const chord = inComment
          ? { modifiers: [], unknown: [], length: 0 }
          : parseChord(lineText.slice(0, usbRange.start.character));
        const label = shortKeyName(name);
        const binds = this.index.getBindsIndex(doc);
        const bound = binds.byUsbCode.get(normalised) ?? [];
        // The chord is a property of the LINE, not of the binding list. Rendering it
        // only when the key happened to have bindings lost the warning in exactly the
        // case that needs it - a mistyped modifier on a key the game does not use.
        const describesChord = !inComment && (chord.modifiers.length > 0 || chord.unknown.length > 0);
        const parts =
          bound.length || describesChord
            ? renderBindings(
              bound,
              chord,
              label,
              binds.activePreset,
              true,
              { kind: 'key', code: normalised, line: usbRange.start.line, character: usbRange.start.character },
              vscode.workspace
                .getConfiguration('targetScript', doc.uri)
                .get<boolean>('diagnostics.unboundKeys') === true
            )
            : [`**${escapeMarkdown(label)}**`];
        // The hover covers the whole chord, so the underline matches what it describes.
        const chordStart = describesChord
          ? new vscode.Position(usbRange.start.line, usbRange.start.character - chord.length)
          : usbRange.start;
        const body = new vscode.MarkdownString(parts.join('\n\n'), true);
        // A narrow grant: only this command, never blanket trust.
        body.isTrusted = { enabledCommands: ['targetScript.peekBindings'] };
        return new vscode.Hover(body, new vscode.Range(chordStart, usbRange.end));
      }
    }

    const range = doc.getWordRangeAtPosition(pos, /[A-Za-z_]\w*/);
    if (!range) return null;
    const word = doc.getText(range);

    // supportThemeIcons: the $(warning) codicon in the chord warning renders only with
    // it, and the sanitizer has a bespoke allowance for exactly that span.
    const md = (s: string) => {
      const body = new vscode.MarkdownString(s, true);
      // A narrow grant: only this command, never blanket trust. Without it the peek
      // link on a DX hover renders and then does nothing when clicked.
      body.isTrusted = { enabledCommands: ['targetScript.peekBindings'] };
      return new vscode.Hover(body, range);
    };

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
      // A virtual button carries no modifier, so every binding on it is an exact match.
      // Inserted before the trailing declaration note rather than after it: the game
      // action is the answer, and it was sandwiched between two dim provenance lines.
      if (forButton?.length) {
        const bindings = renderBindings(
          forButton,
          { modifiers: [], unknown: [], length: 0 },
          word,
          this.index.getBindsIndex(doc).activePreset,
          false,
          dxNumber ? { kind: 'button', code: dxNumber[1], line: range.start.line, character: range.start.character } : undefined
        );
        const note = parts.findIndex((p) => p.startsWith('*'));
        if (note === -1) parts.push(...bindings);
        else parts.splice(note, 0, ...bindings);
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
    const bound = this.index.aliasBindings(doc).get(word);
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
 * An inline code span around content that may itself contain backticks - USB 0x35 is
 * the ` key, and DCS action names are freeform Lua strings. The fence has to be longer
 * than the longest run inside, and the content padded so a leading or trailing backtick
 * is not read as part of the fence. escapeMarkdown must NOT be used here: inside a code
 * span the backslash would render literally.
 */
export function code(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
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
export function renderBindings(
  all: BindingRef[],
  chord: Chord,
  keyLabel: string | null,
  activePreset: string | null,
  showChord = false,
  peek?: { kind: 'key' | 'button'; code: string; line?: number; character?: number },
  /** True when the unbound-key diagnostic is on and has already said this. */
  diagnosticSaysUnbound = false
): string[] {
  const out: string[] = [];

  // An unrecognised term is never dropped. Answering for the bare key would describe a
  // line the author did not write - the same failure as ignoring the modifier entirely.
  if (chord.unknown.length) {
    const names = chord.unknown.map((u) => code(u)).join(', ');
    out.push(
      `$(warning) ${names} ${chord.unknown.length > 1 ? 'are not modifiers' : 'is not a modifier'} this extension knows, ` +
        `so this line may not send what it looks like it sends.`
    );
  }

  const exact = all.filter((r) => chordMatches(r, chord.modifiers));
  const chordLabel = [...chord.modifiers, keyLabel ?? 'this key'].map((p) => code(p)).join(' + ');

  /** One row per action per place it is declared, slots folded together. */
  const rows = (refs: BindingRef[]): string => {
    const folded = new Map<string, { ref: BindingRef; slots: Set<string> }>();
    for (const r of refs) {
      const key = `${r.action}\u0000${r.path}\u0000${r.line}`;
      const hit = folded.get(key);
      if (hit) hit.slots.add(r.slot.toLowerCase());
      else folded.set(key, { ref: r, slots: new Set([r.slot.toLowerCase()]) });
    }
    // Which file a binding came from only matters when more than one is on screen -
    // two DCS aircraft, or presets that disagree.
    const manyFiles = new Set(refs.map((r) => r.path)).size > 1;
    return [...folded.values()]
      .map(({ ref, slots }) => {
        const target = `${vscode.Uri.file(ref.path).toString()}#L${ref.line}`;
        const bits: string[] = [];
        // Which aircraft, for DCS. Not a filter - every module's bindings are live at
        // once and which applies depends on what you are flying - so it is the context
        // that makes the row mean anything.
        if (ref.context) bits.push(code(ref.context));
        else if (manyFiles) bits.push(code(ref.file));
        if (slots.size && ![...slots].some((sl) => sl === 'primary' || sl === '')) {
          bits.push([...slots].join(' & '));
        }
        return `- [${code(ref.action)}](${target})${bits.length ? ` \u2014 ${bits.join(', ')}` : ''}`;
      })
      .join('\n');
  };

  // Never truncated. The hover widget scrolls, resizes, and remembers the size the user
  // dragged it to, so cutting the list short only hid answers it would have shown.
  const source = (refs: BindingRef[]): string => {
    const games = [...new Set(refs.map((r) => r.game))];
    const files = [...new Set(refs.map((r) => r.file))];
    const preset = activePreset && games.length === 1 && games[0] === GAME_ELITE ? activePreset : null;
    return `*${games.join(', ')} \u00b7 ${preset ? `preset ${code(preset)}` : files.map((f) => code(f)).join(', ')}*`;
  };

  // A control rather than another row of information, which is why it belongs on every
  // binding hover and the near-miss list did not: it answers a question the reader may
  // have instead of pre-empting one they did not ask.
  const peekLink = peek
    ? `[$(search) Show everywhere this is bound](command:targetScript.peekBindings?${encodeURIComponent(JSON.stringify([peek]))})`
    : null;

  if (exact.length) {
    // The decoded chord, confirmed back to the reader. Dropping this went too far: the
    // line carries `USB[0x1E]` and a hand-written `// LALT+1` comment, so "L_ALT + 1" is
    // the one part of it nothing else verifies - and seeing it is how you know the
    // extension read the same line you did.
    if (showChord) out.push(chordLabel);
    out.push(rows(exact), source(exact));
    if (peekLink) out.push(peekLink);
    return out;
  }

  // The chord does nothing. That IS the answer, and it is the whole answer: what the
  // same key does under OTHER modifiers belongs to other lines of the script, which is
  // the reason those rows were dropped from the match case. Bringing them back here
  // under a different heading was the same noise relabelled. Anyone who does want the
  // whole picture has the peek, which is built for exactly that.
  // VS Code renders a diagnostic above the hover, so when the unbound-key check is on
  // this sentence is the second copy of one the reader has already had.
  if (!diagnosticSaysUnbound) {
    const games = [...new Set(all.map((r) => r.game))];
    const where = games.length ? games.map((g) => `**${g}**`).join(' or ') : 'any binding file found';
    out.push(`Nothing in ${where} is bound to ${chordLabel}.`);
  }
  if (peekLink) out.push(peekLink);
  return out;
}
