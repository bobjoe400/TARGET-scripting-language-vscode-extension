// Extension entry point: wires the providers up and keeps diagnostics current.

import * as path from 'path';
import * as vscode from 'vscode';
import { TargetIndex } from './index';
import { collectAliasBindings } from './model';
import { computeDiagnostics, DIAG_SOURCE, RawDiagnostic, Severity } from './diagnostics';
import {
  TARGET_SELECTOR,
  TargetCompletionProvider,
  TargetDefinitionProvider,
  TargetHoverProvider,
  TargetSignatureProvider,
  TargetSymbolProvider,
} from './providers';
import { generated } from './builtins';

const SEVERITY: Record<Severity, vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
};

export function activate(context: vscode.ExtensionContext): void {
  const index = new TargetIndex();
  const diagnostics = vscode.languages.createDiagnosticCollection('target');
  const output = vscode.window.createOutputChannel('TARGET Script');
  context.subscriptions.push(diagnostics, output);

  output.appendLine(
    `TARGET Script: builtin tables generated ${generated.at} from ${generated.from}`
  );

  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      TARGET_SELECTOR,
      new TargetCompletionProvider(index),
      '&',
      ','
    ),
    vscode.languages.registerHoverProvider(TARGET_SELECTOR, new TargetHoverProvider(index)),
    vscode.languages.registerSignatureHelpProvider(
      TARGET_SELECTOR,
      new TargetSignatureProvider(index),
      '(',
      ','
    ),
    vscode.languages.registerDocumentSymbolProvider(TARGET_SELECTOR, new TargetSymbolProvider(index)),
    vscode.languages.registerDefinitionProvider(TARGET_SELECTOR, new TargetDefinitionProvider(index))
  );

  // ---- diagnostics ----------------------------------------------------------
  const refresh = (doc: vscode.TextDocument) => {
    if (doc.languageId !== 'target') return;
    if (!vscode.workspace.getConfiguration('targetScript').get<boolean>('diagnostics.enable', true)) {
      diagnostics.delete(doc.uri);
      return;
    }
    const model = index.getModel(doc);

    // Device handles are usually bound in a different file from the one that uses
    // them, so the bindings are merged across the include graph.
    const bindings = new Map<string, Set<string>>();
    for (const { model: m } of index.includeClosure(doc.uri.fsPath, model)) {
      for (const [k, v] of collectAliasBindings(m)) {
        if (!bindings.has(k)) bindings.set(k, new Set());
        for (const d of v) bindings.get(k)!.add(d);
      }
    }

    const raw = computeDiagnostics(model, path.basename(doc.fileName), { aliasBindings: bindings });
    diagnostics.set(doc.uri, raw.map((d) => toVsDiagnostic(doc, d)));
  };

  let debounce: NodeJS.Timeout | undefined;
  const refreshSoon = (doc: vscode.TextDocument) => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => refresh(doc), 250);
  };

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(refresh),
    vscode.workspace.onDidChangeTextDocument((e) => refreshSoon(e.document)),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      index.invalidate(doc.uri);
      refresh(doc);
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      index.invalidate(doc.uri);
      diagnostics.delete(doc.uri);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('targetScript')) return;
      for (const doc of vscode.workspace.textDocuments) refresh(doc);
    })
  );

  for (const doc of vscode.workspace.textDocuments) refresh(doc);
}

function toVsDiagnostic(doc: vscode.TextDocument, d: RawDiagnostic): vscode.Diagnostic {
  const range = new vscode.Range(doc.positionAt(d.start), doc.positionAt(d.end));
  const out = new vscode.Diagnostic(range, d.message, SEVERITY[d.severity]);
  out.source = DIAG_SOURCE;
  out.code = d.code;
  return out;
}

export function deactivate(): void {
  /* nothing to tear down: all disposables are registered on the context */
}
