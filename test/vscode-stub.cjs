// Minimal stand-in for the `vscode` module, enough to drive the providers in a plain
// node process. Lets the device-aware completion path be tested for real instead of
// only by inspection.
class Position {
  constructor(line, character) { this.line = line; this.character = character; }
  isBefore(o) { return this.line < o.line || (this.line === o.line && this.character < o.character); }
  isBeforeOrEqual(o) { return this.isBefore(o) || (this.line === o.line && this.character === o.character); }
}
class Range {
  constructor(start, end) { this.start = start; this.end = end; }
}
class Location {
  constructor(uri, range) { this.uri = uri; this.range = range; }
}
class MarkdownString {
  constructor(value = '') { this.value = value; }
}
class CompletionItem {
  constructor(label, kind) { this.label = label; this.kind = kind; }
}
class Hover {
  constructor(contents, range) { this.contents = contents; this.range = range; }
}
class SignatureHelp {
  constructor() { this.signatures = []; this.activeSignature = 0; this.activeParameter = 0; }
}
class SignatureInformation {
  constructor(label, documentation) { this.label = label; this.documentation = documentation; this.parameters = []; }
}
class ParameterInformation {
  constructor(label) { this.label = label; }
}
class DocumentSymbol {
  constructor(name, detail, kind, range, selectionRange) {
    this.name = name; this.detail = detail; this.kind = kind;
    this.range = range; this.selectionRange = selectionRange; this.children = [];
  }
}
const enumOf = (names) => Object.fromEntries(names.map((n, i) => [n, i]));

const config = new Map();

module.exports = {
  Position, Range, Location, MarkdownString, CompletionItem, Hover,
  SignatureHelp, SignatureInformation, ParameterInformation, DocumentSymbol,
  CompletionItemKind: enumOf(['Text','Method','Function','Constructor','Field','Variable','Class','Interface','Module','Property','Unit','Value','Enum','Keyword','Snippet','Color','File','Reference','Folder','EnumMember','Constant','Struct','Event','Operator','TypeParameter']),
  SymbolKind: enumOf(['File','Module','Namespace','Package','Class','Method','Property','Field','Constructor','Enum','Interface','Function','Variable','Constant','String','Number','Boolean','Array','Object','Key','Null','EnumMember','Struct','Event','Operator','TypeParameter']),
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  Uri: { file: (p) => ({ fsPath: p, toString: () => `file://${p}` }) },
  workspace: {
    textDocuments: [],
    getConfiguration: () => ({ get: (key, dflt) => (config.has(key) ? config.get(key) : dflt) }),
    getWorkspaceFolder: () => undefined,
  },
  __setConfig: (k, v) => config.set(k, v),
};
