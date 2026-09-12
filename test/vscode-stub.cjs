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
  constructor(label, documentation) { this.label = label; this.documentation = documentation; }
}
class DocumentSymbol {
  constructor(name, detail, kind, range, selectionRange) {
    this.name = name; this.detail = detail; this.kind = kind;
    this.range = range; this.selectionRange = selectionRange; this.children = [];
  }
}
const enumOf = (names) => Object.fromEntries(names.map((n, i) => [n, i]));

const config = new Map();

// Recorded interactions, so a test can assert what the extension told the user.
const recorded = { errors: [], infos: [], warnings: [], commands: new Map(), quickPicks: [], statusBarItems: [] };
let quickPickAnswer = undefined;
let warningAnswer = undefined;
const noop = () => ({ dispose() {} });

module.exports = {
  Position, Range, Location, MarkdownString, CompletionItem, Hover,
  SignatureHelp, SignatureInformation, ParameterInformation, DocumentSymbol,
  CompletionItemKind: enumOf(['Text','Method','Function','Constructor','Field','Variable','Class','Interface','Module','Property','Unit','Value','Enum','Keyword','Snippet','Color','File','Reference','Folder','EnumMember','Constant','Struct','Event','Operator','TypeParameter']),
  SymbolKind: enumOf(['File','Module','Namespace','Package','Class','Method','Property','Field','Constructor','Enum','Interface','Function','Variable','Constant','String','Number','Boolean','Array','Object','Key','Null','EnumMember','Struct','Event','Operator','TypeParameter']),
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  Uri: { file: (p) => ({ fsPath: p, toString: () => `file://${p}`, scheme: 'file' }) },
  ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
  EventEmitter: class { constructor() { this.event = noop; } fire() {} dispose() {} },
  Selection: class { constructor(a, b) { this.anchor = a; this.active = b; this.start = a; this.end = b; } },
  TextEditorRevealType: { Default: 0, InCenter: 1 },
  Diagnostic: class { constructor(range, message, severity) { this.range = range; this.message = message; this.severity = severity; } },
  languages: {
    createDiagnosticCollection: () => ({ set() {}, delete() {}, clear() {}, dispose() {} }),
    registerCompletionItemProvider: noop,
    registerHoverProvider: noop,
    registerSignatureHelpProvider: noop,
    registerDocumentSymbolProvider: noop,
    registerDefinitionProvider: noop,
  },
  commands: {
    registerCommand: (id, fn) => { recorded.commands.set(id, fn); return { dispose() {} }; },
    executeCommand: async () => undefined,
  },
  workspace: {
    textDocuments: [],
    getConfiguration: () => ({ get: (key, dflt) => (config.has(key) ? config.get(key) : dflt) }),
    getWorkspaceFolder: () => undefined,
    onDidOpenTextDocument: noop,
    onDidChangeTextDocument: noop,
    onDidSaveTextDocument: noop,
    onDidCloseTextDocument: noop,
    onDidChangeConfiguration: noop,
    openTextDocument: async (uri) => {
      const hit = module.exports.workspace.textDocuments.find(
        (d) => d.uri.toString() === (uri.toString ? uri.toString() : String(uri))
      );
      if (hit) return hit;
      throw new Error('not open');
    },
  },
  StatusBarAlignment: { Left: 1, Right: 2 },
  window: {
    activeTextEditor: undefined,
    visibleTextEditors: [],
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
    createStatusBarItem: () => {
      const item = {
        text: '', tooltip: '', command: undefined, visible: false,
        show() { this.visible = true; }, hide() { this.visible = false; }, dispose() {},
      };
      recorded.statusBarItems.push(item);
      return item;
    },
    onDidChangeActiveTextEditor: noop,
    showErrorMessage: (msg) => { recorded.errors.push(msg); return Promise.resolve(undefined); },
    showWarningMessage: (msg, ...rest) => {
      recorded.warnings.push(msg);
      // Options object, when present, comes before the button labels.
      const buttons = rest.filter((r) => typeof r === 'string');
      const answer = warningAnswer === undefined ? undefined : warningAnswer;
      return Promise.resolve(buttons.includes(answer) ? answer : undefined);
    },
    showInformationMessage: (msg) => { recorded.infos.push(msg); return Promise.resolve(undefined); },
    showQuickPick: (items) => { recorded.quickPicks.push(items); return Promise.resolve(quickPickAnswer); },
    showTextDocument: async () => ({ selection: null, revealRange() {} }),
    withProgress: (_opts, task) => task({ report() {} }, { isCancellationRequested: false }),
  },
  __setConfig: (k, v) => config.set(k, v),
  __recorded: recorded,
  __reset: () => {
    recorded.errors.length = 0;
    recorded.infos.length = 0;
    recorded.warnings.length = 0;
    recorded.quickPicks.length = 0;
    quickPickAnswer = undefined;
    warningAnswer = undefined;
    module.exports.window.activeTextEditor = undefined;
    module.exports.window.visibleTextEditors = [];
    module.exports.workspace.textDocuments = [];
  },
  __setQuickPickAnswer: (a) => { quickPickAnswer = a; },
  __setWarningAnswer: (a) => { warningAnswer = a; },
};
