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
import {
  compileCheck,
  detectHost,
  findInstall,
  resolveEntryScript,
  runScript,
  stopScript,
  TargetInstall,
} from './runner';

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

  // ---- compile / run --------------------------------------------------------
  // Remembered so a command still works when the active tab is the extension page,
  // a settings tab, or anything else that is not a text editor.
  let lastTargetDoc: vscode.TextDocument | undefined;
  const rememberTarget = (ed?: vscode.TextEditor) => {
    if (ed && ed.document.languageId === 'target') lastTargetDoc = ed.document;
  };
  rememberTarget(vscode.window.activeTextEditor);
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(rememberTarget));

  // Compile results live in their own collection so the live linter's updates do
  // not wipe them, and vice versa.
  const compileDiags = vscode.languages.createDiagnosticCollection('target-compile');
  context.subscriptions.push(compileDiags);

  const requireInstall = (): TargetInstall | null => {
    const configured = vscode.workspace.getConfiguration('targetScript').get<string>('installPath');
    const install = findInstall(configured);
    if (!install) {
      vscode.window
        .showErrorMessage(
          'Could not find the TARGET installation. Set `targetScript.installPath` to the folder containing target.tmh.',
          'Open Settings'
        )
        .then((pick) => {
          if (pick) vscode.commands.executeCommand('workbench.action.openSettings', 'targetScript.installPath');
        });
      return null;
    }
    return install;
  };

  /**
   * The TARGET document a command should act on.
   *
   * `activeTextEditor` is undefined whenever the active tab is not a text editor -
   * the extension details page, a settings tab, a diff, an image - so relying on it
   * alone refuses to run while a perfectly good script sits in the next tab. The
   * resource passed by an editor title-bar button is preferred, then the active
   * editor, then the last TARGET file that was focused, then anything still open.
   */
  const pickTargetDocument = async (resource?: vscode.Uri): Promise<vscode.TextDocument | null> => {
    const isTarget = (d: vscode.TextDocument) => d.languageId === 'target';

    if (resource) {
      const known = vscode.workspace.textDocuments.find((d) => d.uri.toString() === resource.toString());
      if (known && isTarget(known)) return known;
      try {
        const opened = await vscode.workspace.openTextDocument(resource);
        if (isTarget(opened)) return opened;
      } catch {
        /* fall through to the other candidates */
      }
    }

    const active = vscode.window.activeTextEditor?.document;
    if (active && isTarget(active)) return active;

    const visible = vscode.window.visibleTextEditors.map((e) => e.document).filter(isTarget);
    if (visible.length === 1) return visible[0];

    if (lastTargetDoc && !lastTargetDoc.isClosed && isTarget(lastTargetDoc)) return lastTargetDoc;

    const open = vscode.workspace.textDocuments.filter(isTarget);
    if (open.length === 1) return open[0];
    if (open.length > 1) {
      const pick = await vscode.window.showQuickPick(
        open.map((d) => ({ label: path.basename(d.fileName), description: d.uri.fsPath, doc: d })),
        { title: 'Which TARGET script?' }
      );
      return pick?.doc ?? null;
    }

    vscode.window.showErrorMessage(
      'No TARGET script is open. Open a .tmc, .tmh or .ttm file, then run this command.'
    );
    return null;
  };

  /** The .tmc to act on: the chosen file, or the single .tmc beside an open header. */
  const activeEntryScript = async (resource?: vscode.Uri): Promise<string | null> => {
    const doc = await pickTargetDocument(resource);
    if (!doc) return null;
    if (doc.isDirty) await doc.save();

    const { entry, candidates } = resolveEntryScript(doc.uri.fsPath);
    if (entry) return entry;
    if (candidates.length === 0) {
      vscode.window.showErrorMessage(
        `No .tmc file found next to ${path.basename(doc.fileName)}. A header is compiled as part of the .tmc that includes it.`
      );
      return null;
    }
    const pick = await vscode.window.showQuickPick(
      candidates.map((c) => ({ label: path.basename(c), description: c })),
      { title: 'Which script is the entry point?' }
    );
    return pick?.description ?? null;
  };

  const unsupportedHost = (): boolean => {
    if (detectHost() !== 'unsupported') return false;
    vscode.window.showErrorMessage(
      'Compiling and running require the Windows TARGET tools. This works on Windows, or from WSL where Windows executables can be launched.'
    );
    return true;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('targetScript.compile', async (resource?: vscode.Uri) => {
      if (unsupportedHost()) return;
      const install = requireInstall();
      if (!install) return;
      const entry = await activeEntryScript(resource);
      if (!entry) return;

      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: `Compiling ${path.basename(entry)}…` },
        () => compileCheck(entry, install)
      );

      output.appendLine(`\n$ Interpreter.exe ${path.basename(entry)}  (compile check)`);
      if (result.output.trim()) output.appendLine(result.output.trim());
      if (result.error) output.appendLine(`error: ${result.error}`);

      compileDiags.clear();
      if (result.error) {
        vscode.window.showErrorMessage(`Compile check failed: ${result.error}`);
        return;
      }

      if (result.problems.length === 0 && result.ok) {
        vscode.window.showInformationMessage(`${path.basename(entry)} compiles cleanly.`);
        return;
      }

      const byFile = new Map<string, vscode.Diagnostic[]>();
      for (const p of result.problems) {
        const line = Math.max(0, p.line - 1);
        const d = new vscode.Diagnostic(
          new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER),
          p.message,
          vscode.DiagnosticSeverity.Error
        );
        d.source = 'target-compiler';
        const key = p.file;
        if (!byFile.has(key)) byFile.set(key, []);
        byFile.get(key)!.push(d);
      }
      for (const [file, diags] of byFile) compileDiags.set(vscode.Uri.file(file), diags);

      const first = result.problems[0];
      vscode.window
        .showErrorMessage(
          `${result.problems.length} compile error${result.problems.length === 1 ? '' : 's'}: ${first.message}`,
          'Go to Error'
        )
        .then(async (pick) => {
          if (!pick) return;
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(first.file));
          const editor = await vscode.window.showTextDocument(doc);
          const pos = new vscode.Position(Math.max(0, first.line - 1), 0);
          editor.selection = new vscode.Selection(pos, pos);
          editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
        });
    }),

    vscode.commands.registerCommand('targetScript.run', async (resource?: vscode.Uri) => {
      if (unsupportedHost()) return;
      const install = requireInstall();
      if (!install) return;
      const entry = await activeEntryScript(resource);
      if (!entry) return;

      // Running creates the virtual devices and takes over the hardware, so a failing
      // compile is worth catching before TARGET is launched.
      const check = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: `Compiling ${path.basename(entry)}…` },
        () => compileCheck(entry, install)
      );
      if (check.problems.length) {
        const pick = await vscode.window.showErrorMessage(
          `${path.basename(entry)} has ${check.problems.length} compile error(s). Run anyway?`,
          'Run Anyway',
          'Show Errors'
        );
        if (pick === 'Show Errors') {
          await vscode.commands.executeCommand('targetScript.compile');
          return;
        }
        if (pick !== 'Run Anyway') return;
      }

      const res = await runScript(entry, install);
      output.appendLine(`\n$ ${res.command ?? ''}`);
      if (!res.ok) {
        vscode.window.showErrorMessage(`Could not start TARGET: ${res.error}`);
        return;
      }
      vscode.window.showInformationMessage(`Running ${path.basename(entry)} in TARGET.`, 'Stop').then((pick) => {
        if (pick === 'Stop') vscode.commands.executeCommand('targetScript.stop');
      });
    }),

    vscode.commands.registerCommand('targetScript.stop', async () => {
      if (unsupportedHost()) return;
      const res = await stopScript();
      if (res.ok) vscode.window.showInformationMessage('Stopped TARGET.');
      else vscode.window.showErrorMessage(`Could not stop TARGET: ${res.error}`);
    })
  );
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
