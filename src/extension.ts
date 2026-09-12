// Extension entry point: wires the providers up and keeps diagnostics current.

import * as fs from 'fs';
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
  clearInstallCache,
  isGuiRunning,
  isInstalledHeader,
  isWindowsLocalPath,
  killImage,
  listTargetProcesses,
  resolveEntryScript,
  stageRootFor,
  runScript,
  stageProjectForRun,
  stopScript,
  TARGET_IMAGES,
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

  // Compile results live in their own collection so the live linter's updates do not
  // wipe them, and vice versa. Declared here because refreshSoon clears it, and a
  // const declared later would be a temporal-dead-zone error if that ever ran during
  // the synchronous body of activate().
  const compileDiags = vscode.languages.createDiagnosticCollection('target-compile');
  context.subscriptions.push(compileDiags);
  /** Files the last compile put diagnostics on, so the next one can clear them. */
  const lastCompileFiles = new Set<string>();

  // ---- diagnostics ----------------------------------------------------------
  /**
   * installPath is machine-overridable, so a multi-root workspace can set a different
   * one per folder. Read without a resource, the window-level value was applied to every
   * document regardless of which folder it lived in.
   */
  const installPathSetting = (resource?: string): string | undefined =>
    vscode.workspace
      .getConfiguration('targetScript', resource ? vscode.Uri.file(resource) : undefined)
      .get<string>('installPath');

  const refresh = (doc: vscode.TextDocument) => {
    if (doc.languageId !== 'target') return;
    // Git diffs, timeline entries and other virtual documents have no path on disk;
    // resolving includes and writing diagnostics against them produces a second set of
    // Problems entries for what looks like the same file.
    if (doc.uri.scheme !== 'file') return;
    // Never diagnose the headers TARGET ships. The builtin tables were generated from
    // them, so every declaration in them looks like a redeclaration of a builtin -
    // over 200 fabricated errors against vendor files that compile perfectly. Go-to
    // definition on any builtin opens one of these, so this is easy to hit.
    if (isInstalledHeader(doc.uri.fsPath, findInstall(installPathSetting(doc.uri.fsPath)))) {
      diagnostics.delete(doc.uri);
      return;
    }
    if (!vscode.workspace.getConfiguration('targetScript').get<boolean>('diagnostics.enable', true)) {
      diagnostics.delete(doc.uri);
      // "Turn diagnostics off entirely" has to include the compile results.
      compileDiags.delete(doc.uri);
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

    const { symbols, complete } = index.symbolTable(doc);
    // The include graph is only meaningful from an entry script: a header analysed on
    // its own is not what the compiler ever sees.
    const isEntry = doc.fileName.toLowerCase().endsWith('.tmc');
    const graph = isEntry ? index.analyzeIncludes(doc) : null;
    const raw = computeDiagnostics(model, path.basename(doc.fileName), {
      aliasBindings: bindings,
      knownSymbols: symbols,
      closureComplete: complete,
      isEntryScript: isEntry,
      includeProblems: graph?.problems,
      duplicateSymbols: graph?.duplicateSymbols,
    });
    diagnostics.set(doc.uri, raw.map((d) => toVsDiagnostic(doc, d)));
  };

  // One timer per document. A single shared timer meant editing one file then another
  // within the debounce window dropped the first file's refresh entirely, leaving its
  // problems stale until it was touched again.
  const debounces = new Map<string, NodeJS.Timeout>();
  const cancelRefresh = (uri: vscode.Uri) => {
    // Both keys: a dependent refresh is armed under a 'dep:' prefix, and cancelling
    // only the plain key let it fire after the close handler had already deleted the
    // diagnostics - resurrecting problems for a closed file that nothing would clear.
    for (const key of [uri.toString(), `dep:${uri.toString()}`]) {
      const t = debounces.get(key);
      if (t) {
        clearTimeout(t);
        debounces.delete(key);
      }
    }
  };
  /** Re-runs the live rules for a dependent file, leaving its compile results alone. */
  const refreshDependent = (doc: vscode.TextDocument) => {
    const key = `dep:${doc.uri.toString()}`;
    const prev = debounces.get(key);
    if (prev) clearTimeout(prev);
    debounces.set(
      key,
      setTimeout(() => {
        debounces.delete(key);
        refresh(doc);
      }, 250)
    );
  };

  const refreshSoon = (doc: vscode.TextDocument) => {
    // Typing in any document in the window fires this; only real TARGET files need it.
    if (doc.languageId !== 'target' || doc.uri.scheme !== 'file') return;
    const key = doc.uri.toString();
    cancelRefresh(doc.uri);
    // A compile result describes the file as it was when it was compiled. Once it is
    // edited the result is stale, and nothing else ever cleared it - a fixed error
    // stayed red in Problems until the command was run again.
    compileDiags.delete(doc.uri);
    debounces.set(
      key,
      setTimeout(() => {
        debounces.delete(key);
        refresh(doc);
      }, 250)
    );
  };
  context.subscriptions.push({
    dispose: () => {
      for (const t of debounces.values()) clearTimeout(t);
      debounces.clear();
    },
  });

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(refresh),
    vscode.workspace.onDidChangeTextDocument((e) => refreshSoon(e.document)),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      // Only a TARGET file can change a TARGET symbol table. Without this, saving a
      // README invalidated the index and rescheduled a full include-graph walk for
      // every open script - synchronous reads across the install directory, on the
      // extension host's only thread, for a save that could not have affected anything.
      if (doc.languageId !== 'target' || doc.uri.scheme !== 'file') {
        // A .binds file is not a script, but it does feed the USB-code hovers, so its
        // save still has to drop the cached index.
        if (/\.binds$/i.test(doc.uri.fsPath)) index.invalidate(doc.uri);
        return;
      }
      index.invalidate(doc.uri);
      refresh(doc);
      // A header's contents feed the symbol table of every script that includes it,
      // so those keep stale unknown-function and duplicate-symbol problems otherwise.
      // Debounced rather than immediate: each refresh walks the include graph with
      // synchronous reads against the TARGET headers, so refreshing every open script
      // inline blocked the extension host for as long as that took.
      for (const other of vscode.workspace.textDocuments) {
        if (other.uri.toString() === doc.uri.toString()) continue;
        if (other.languageId !== 'target' || other.uri.scheme !== 'file') continue;
        // Not refreshSoon: that clears compileDiags, so saving one file wiped the
        // compile results of every other open script.
        refreshDependent(other);
      }
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      // Cancel first: a timer armed moments ago would otherwise fire after the delete
      // and put diagnostics back for a document that is no longer open.
      cancelRefresh(doc.uri);
      index.invalidate(doc.uri);
      diagnostics.delete(doc.uri);
      compileDiags.delete(doc.uri);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('targetScript')) return;
      // Only the settings that feed include resolution justify dropping those caches.
      // Toggling diagnostics.enable was throwing away every resolution too.
      const pathsChanged =
        e.affectsConfiguration('targetScript.installPath') ||
        e.affectsConfiguration('targetScript.bindsFolder');
      if (!pathsChanged) {
        for (const doc of vscode.workspace.textDocuments) refreshSoon(doc);
        return;
      }
      // installPath and bindsFolder both feed include resolution.
      index.clearResolutionCache();
      clearInstallCache();
      for (const doc of vscode.workspace.textDocuments) refreshSoon(doc);
    })
  );

  // Debounced, like every other refresh path here. Run inline this blocked the
  // extension host for ~150ms on a restored session with the project's files open,
  // walking every include graph with synchronous reads - and on a project living on
  // the Windows drive each of those stats costs hundreds of times what a native one
  // does.
  for (const doc of vscode.workspace.textDocuments) refreshSoon(doc);

  // ---- compile / run --------------------------------------------------------
  // Remembered so a command still works when the active tab is the extension page,
  // a settings tab, or anything else that is not a text editor.
  let lastTargetDoc: vscode.TextDocument | undefined;
  const rememberTarget = (ed?: vscode.TextEditor) => {
    if (ed && ed.document.languageId === 'target') lastTargetDoc = ed.document;
  };
  // The context key survives an extension host restart otherwise, leaving the stop
  // command offered when nothing is running.
  vscode.commands.executeCommand('setContext', 'targetScript.running', false);
  rememberTarget(vscode.window.activeTextEditor);
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(rememberTarget));

  // Running state belongs in the status bar, not a notification: a notification
  // carrying a button stays until the user dismisses it and cannot be closed
  // programmatically, so it goes on claiming a script is running long after it
  // stopped. A status bar item can be updated and hidden to match reality.
  const runStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  runStatus.command = 'targetScript.stop';
  context.subscriptions.push(runStatus);

  let runPoll: NodeJS.Timeout | undefined;
  const clearRunStatus = () => {
    if (runPoll) {
      clearInterval(runPoll);
      runPoll = undefined;
    }
    runStatus.hide();
    vscode.commands.executeCommand('setContext', 'targetScript.running', false);
  };
  context.subscriptions.push({ dispose: clearRunStatus });

  /** Shows the indicator and watches until TARGET is gone. */
  const beginRunStatus = (scriptName: string) => {
    clearRunStatus();
    runStatus.text = `$(debug-stop) TARGET: ${scriptName}`;
    runStatus.tooltip = `${scriptName} was launched in TARGET. Click to stop TARGET.`;
    runStatus.show();
    // Keeps "Stop Running Script" findable in the palette while a script is running,
    // whatever file happens to be focused.
    vscode.commands.executeCommand('setContext', 'targetScript.running', true);
    runPoll = setInterval(async () => {
      // Only the GUI matters here; asking for both images spawned a second
      // tasklist.exe every three seconds for the whole session, for a value
      // nothing read.
      const guiRunning = await isGuiRunning();
      if (!guiRunning) {
        // TARGET was closed, from its own window or anywhere else.
        clearRunStatus();
        output.appendLine('TARGET is no longer running; cleared the status indicator.');
      }
      // Five seconds rather than three: each tick is a Windows process launched
      // through WSL interop, and this runs for as long as a script is loaded - a whole
      // flight session - for a boolean that changes once.
    }, 5000);
  };

  /**
   * Files the entry script reaches through its includes, so staging can carry the ones
   * that live outside its own folder - `include "../common/x.tmh"` is ordinary.
   */
  const closureFilesFor = (entry: string): string[] => {
    const open = vscode.workspace.textDocuments.find(
      (d) => d.uri.scheme === 'file' && d.uri.fsPath === entry
    );
    try {
      const model = open ? index.getModel(open) : index.getModelForPath(entry);
      if (!model) return [];
      return index.includeClosure(entry, model).map((c) => c.file);
    } catch {
      return [];
    }
  };

  const requireInstall = (resource?: string): TargetInstall | null => {
    const configured = installPathSetting(resource);
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
    const isTarget = (d: vscode.TextDocument) => d.languageId === 'target' && d.uri.scheme === 'file';

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
    // A virtual workspace - github.dev, a remote repository - has no file on disk for
    // the TARGET tools to read. The declarative half of the extension works fine there,
    // so the extension stays enabled; only this refuses.
    if (doc.uri.scheme !== 'file') {
      vscode.window.showErrorMessage(
        `Compiling and running need the script on a local disk. ${path.basename(doc.fileName)} is opened from ${doc.uri.scheme}:, which the TARGET tools cannot read.`
      );
      return null;
    }
    // Staging copies from disk, so an unsaved header would be compiled in its previous
    // state. Save this project's files - the ones that will actually be staged - and
    // nothing else: writing a half-finished experiment in an unrelated folder because
    // the user compiled something else is not ours to do.
    // Resolve the entry script FIRST: it can live a level or more above the document
    // the command was invoked from, and the save sweep has to be rooted there. Rooting
    // it at the picked document's folder skipped the .tmc itself and every sibling of
    // it, which staging then copied in their previous state.
    const { entry, candidates } = resolveEntryScript(doc.uri.fsPath);
    // Rooted where staging actually copies from, not at the entry's own folder. Staging
    // deliberately widens to the common ancestor of the include closure and relocates
    // even out-of-tree files, so a dirty `../common/lib.tmh` was skipped here and then
    // copied from disk in its last-saved state - compiling code the user had already
    // changed, and running the hardware on it.
    const entryFile = entry ?? doc.uri.fsPath;
    const closure = closureFilesFor(entryFile);
    const saveRoot = stageRootFor(path.dirname(entryFile), closure, findInstall(installPathSetting(entryFile)));
    const staged = new Set(closure.map((f) => f.toLowerCase()));
    for (const open of vscode.workspace.textDocuments) {
      if (open.languageId !== 'target' || !open.isDirty || open.uri.scheme !== 'file') continue;
      const rel = path.relative(saveRoot, open.uri.fsPath);
      const inTree = !rel.startsWith('..') && !path.isAbsolute(rel);
      if (!inTree && !staged.has(open.uri.fsPath.toLowerCase())) continue;
      await open.save();
    }
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

  /**
   * Refuses to execute anything in an untrusted workspace.
   *
   * VS Code does not enforce `untrustedWorkspaces: "limited"` - it loads the extension
   * normally and expects it to gate itself. The manifest claims these commands are
   * unavailable, so they have to actually be. It matters here because TARGET scripts
   * are not inert: the builtin table includes system, LoadLibrary, GetProcAddress and
   * WriteFile, so running a stranger's .tmc is running their code.
   */
  const requireTrust = (what: string): boolean => {
    if (vscode.workspace.isTrusted) return true;
    vscode.window
      .showWarningMessage(
        `${what} runs the TARGET tools against files in this folder, which is not trusted. Highlighting, completion and diagnostics still work.`,
        'Manage Workspace Trust'
      )
      .then((pick) => {
        if (pick) vscode.commands.executeCommand('workbench.trust.manage');
      });
    return false;
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
      if (!requireTrust('Checking a script for compile errors')) return;
      if (unsupportedHost()) return;
      const install = requireInstall();
      if (!install) return;
      const entry = await activeEntryScript(resource);
      if (!entry) return;

      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: `Compiling ${path.basename(entry)}…` },
        () => compileCheck(entry, install, { closureFiles: closureFilesFor(entry) })
      );

      output.appendLine(`\n$ Interpreter.exe ${path.basename(entry)}  (compile check)`);
      if (result.output.trim()) output.appendLine(result.output.trim());
      if (result.error) output.appendLine(`error: ${result.error}`);

      // Only this entry script's own results; clear() wiped every file in the window,
      // so compiling one project erased another project's errors.
      // Everything the previous compile wrote, not just what this one reports: a file
      // whose error is fixed drops out of the list and would otherwise stay red.
      for (const f of lastCompileFiles) compileDiags.delete(vscode.Uri.file(f));
      lastCompileFiles.clear();
      compileDiags.delete(vscode.Uri.file(entry));
      if (result.error) {
        vscode.window.showErrorMessage(`Compile check failed: ${result.error}`);
        return;
      }

      if (result.problems.length === 0) {
        if (result.ok) {
          vscode.window.showInformationMessage(`${path.basename(entry)} compiles cleanly.`);
          return;
        }
        // The compiler said something the parser did not recognise - an unexpected
        // format, a localised message, or nothing at all. Show what it said rather
        // than indexing into an empty list, which used to throw and leave the user
        // with "command failed" and no diagnosis at all.
        const detail = result.output.trim() || 'the compiler produced no output.';
        output.appendLine(detail);
        vscode.window
          .showErrorMessage(`Could not interpret the compiler's response for ${path.basename(entry)}.`, 'Show Output')
          .then((pick) => {
            if (pick) output.show(true);
          });
        return;
      }

      const byFile = new Map<string, vscode.Diagnostic[]>();
      for (const p of result.problems) {
        // The compiler can name a file that is not in the project; attaching a
        // Problems entry to a path that does not exist just creates a phantom row.
        if (!fs.existsSync(p.file)) {
          output.appendLine(`${p.file}:${p.line}  ${p.message}`);
          continue;
        }
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
      for (const [file, diags] of byFile) {
        compileDiags.set(vscode.Uri.file(file), diags);
        lastCompileFiles.add(file);
      }

      const first = result.problems[0];
      vscode.window
        .showErrorMessage(
          `${result.problems.length} compile error${result.problems.length === 1 ? '' : 's'}: ${first.message}`,
          'Go to Error'
        )
        .then(async (pick) => {
          if (!pick) return;
          try {
            const errDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(first.file));
            const editor = await vscode.window.showTextDocument(errDoc);
            const pos = new vscode.Position(Math.max(0, first.line - 1), 0);
            editor.selection = new vscode.Selection(pos, pos);
            editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
          } catch (e) {
            // The compiler can name something that is not an openable document.
            vscode.window.showErrorMessage(`Could not open ${first.file}: ${e instanceof Error ? e.message : String(e)}`);
          }
        });
    }),

    vscode.commands.registerCommand('targetScript.run', async (resource?: vscode.Uri) => {
      if (!requireTrust('Running a script')) return;
      if (unsupportedHost()) return;
      const install = requireInstall();
      if (!install) return;
      const entry = await activeEntryScript(resource);
      if (!entry) return;

      // Running creates the virtual devices and takes over the hardware, so a failing
      // compile is worth catching before TARGET is launched.
      const check = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: `Compiling ${path.basename(entry)}…` },
        () => compileCheck(entry, install, { closureFiles: closureFilesFor(entry) })
      );
      if (check.error) {
        // The check could not be performed at all - no interpreter, or it timed out.
        // Running regardless takes over the hardware with no pre-flight, so say so.
        const pick = await vscode.window.showWarningMessage(
          `Could not check ${path.basename(entry)} before running: ${check.error}`,
          'Run Anyway',
          'Cancel'
        );
        if (pick !== 'Run Anyway') return;
      } else if (check.problems.length) {
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

      // TARGET refuses to start its GUI while the Script Editor is open, and says so
      // in a modal of its own. The GUI is launched detached, so that refusal cannot be
      // seen from here - hence checking first rather than reporting a false success.
      const procs = await listTargetProcesses();
      if (procs.editor) {
        const pick = await vscode.window.showWarningMessage(
          'TARGET Script Editor is open, and TARGET will not run a script while it is. Ask it to close and then run? It will prompt you if it has unsaved changes.',
          { modal: false },
          'Close Editor and Run',
          'Cancel'
        );
        if (pick !== 'Close Editor and Run') return;
        const killed = await killImage(TARGET_IMAGES.editor);
        if (!killed.ok) {
          vscode.window.showErrorMessage(`Could not close TARGET Script Editor: ${killed.error}`);
          return;
        }
        // A polite close can be refused - by an unsaved-changes prompt, or by the user
        // declining it - so confirm rather than assuming it worked.
        await new Promise((r) => setTimeout(r, 600));
        if ((await listTargetProcesses()).editor) {
          vscode.window.showWarningMessage(
            'TARGET Script Editor is still open, so the script was not run. Close it yourself and try again.'
          );
          return;
        }
      } else if (procs.gui) {
        const pick = await vscode.window.showWarningMessage(
          'TARGET is already running a script. Restart it with this one?',
          'Restart',
          'Cancel'
        );
        if (pick !== 'Restart') return;
        await stopScript();
        // taskkill returning is not the process having exited and released the HID
        // devices. The Script Editor branch above already waits; this one did not.
        for (let i = 0; i < 10 && (await listTargetProcesses()).gui; i++) {
          await new Promise((r) => setTimeout(r, 300));
        }
      }

      // TARGET cannot load a script from the WSL filesystem: it reaches it only
      // through a \\wsl.localhost\ UNC path and reports "File not found". Running a
      // copy on a Windows drive is the way round it, but it is a copy, so say so.
      let toRun = entry;
      if (!isWindowsLocalPath(entry)) {
        const pick = await vscode.window.showWarningMessage(
          `${path.basename(entry)} is not on a local Windows drive, which TARGET cannot load from. A copy can be run from one instead - edits will need another Run to take effect.`,
          'Copy to Windows and Run',
          'Cancel'
        );
        if (pick !== 'Copy to Windows and Run') return;
        const staged = await stageProjectForRun(entry, install, { closureFiles: closureFilesFor(entry) });
        if (!staged.ok) {
          vscode.window.showErrorMessage(`Could not copy the project to a Windows drive: ${staged.error}`);
          return;
        }
        toRun = staged.staging.entry;
        output.appendLine(`\nStaged for running: ${staged.staging.dir}`);
      }

      const res = await runScript(toRun, install);
      output.appendLine(`\n$ ${res.command ?? ''}`);
      if (!res.ok) {
        vscode.window.showErrorMessage(`Could not start TARGET: ${res.error}`);
        return;
      }
      // TARGET is launched detached, so this reports the launch, not a confirmed run:
      // anything TARGET itself objects to appears in its own window.
      const copied = toRun !== entry;
      beginRunStatus(path.basename(entry));
      // No button on this one: a notification with buttons never goes away on its
      // own, and the status bar already carries the running state and the stop action.
      vscode.window.showInformationMessage(
        `Launched ${path.basename(entry)} in TARGET${copied ? ' (from a copy on the Windows drive)' : ''}.`
      );
    }),

    vscode.commands.registerCommand('targetScript.stop', async () => {
      if (!requireTrust('Stopping TARGET')) return;
      if (unsupportedHost()) return;
      const res = await stopScript();
      clearRunStatus();
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
