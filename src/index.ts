// Caches a parsed model per file and resolves `include` graphs, so that
// go-to-definition and completion can see symbols declared in other files.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { buildModel, DocModel, Decl } from './model';
import { readTextFile } from './encoding';

/** Default locations of the TARGET install, used when the setting is empty. */
const DEFAULT_INSTALL_DIRS = [
  'C:\\Program Files (x86)\\Thrustmaster\\TARGET\\scripts',
  'C:\\Program Files\\Thrustmaster\\TARGET\\scripts',
  '/mnt/c/Program Files (x86)/Thrustmaster/TARGET/scripts',
  '/mnt/c/Program Files/Thrustmaster/TARGET/scripts',
];

interface Entry {
  model: DocModel;
  version: number;
  mtimeMs: number;
}

export class TargetIndex {
  private cache = new Map<string, Entry>();

  /** The model for an open document, reparsed only when its version changes. */
  getModel(doc: vscode.TextDocument): DocModel {
    const key = doc.uri.toString();
    const hit = this.cache.get(key);
    if (hit && hit.version === doc.version) return hit.model;
    const model = buildModel(doc.getText());
    this.cache.set(key, { model, version: doc.version, mtimeMs: 0 });
    return model;
  }

  /** The model for a file on disk, reparsed when the file changes. */
  getModelForPath(p: string): DocModel | null {
    const key = vscode.Uri.file(p).toString();
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(p).mtimeMs;
    } catch {
      return null;
    }
    const hit = this.cache.get(key);
    if (hit && hit.mtimeMs === mtimeMs) return hit.model;

    // An already-open document is the source of truth over what is on disk.
    const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === p);
    const text = open ? open.getText() : readTextFile(p);
    if (text === null) return null;
    const model = buildModel(text);
    this.cache.set(key, { model, version: -1, mtimeMs });
    return model;
  }

  invalidate(uri: vscode.Uri): void {
    this.cache.delete(uri.toString());
  }

  /** Directories searched for `include "..."`, nearest first. */
  private searchDirs(fromFile: string): string[] {
    const dirs = [path.dirname(fromFile)];
    const configured = vscode.workspace.getConfiguration('targetScript').get<string>('installPath')?.trim();
    if (configured) dirs.push(configured);
    for (const d of DEFAULT_INSTALL_DIRS) if (!dirs.includes(d)) dirs.push(d);
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(fromFile));
    if (folder) dirs.push(folder.uri.fsPath);
    return dirs;
  }

  /**
   * Resolves an include to an absolute path.
   * Per the manual, macro and header files live alongside the main script; only
   * the TARGET-supplied headers come from the install directory.
   */
  resolveInclude(fromFile: string, includePath: string): string | null {
    const normalized = includePath.replace(/\\/g, path.sep).replace(/\//g, path.sep);
    if (path.isAbsolute(normalized) && fs.existsSync(normalized)) return normalized;
    for (const dir of this.searchDirs(fromFile)) {
      const candidate = path.join(dir, normalized);
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
      } catch {
        /* unreadable directory, try the next */
      }
    }
    return null;
  }

  /**
   * Every file reachable from `startFile` through includes, including itself.
   * Cycles are common (headers including headers) and are handled by the seen set.
   */
  includeClosure(startFile: string, startModel: DocModel, limit = 64): { file: string; model: DocModel }[] {
    const out: { file: string; model: DocModel }[] = [{ file: startFile, model: startModel }];
    const seen = new Set([startFile]);
    const queue: { file: string; model: DocModel }[] = [{ file: startFile, model: startModel }];

    while (queue.length && out.length < limit) {
      const cur = queue.shift()!;
      for (const inc of cur.model.includes) {
        const resolved = this.resolveInclude(cur.file, inc.path);
        if (!resolved || seen.has(resolved)) continue;
        seen.add(resolved);
        const m = this.getModelForPath(resolved);
        if (!m) continue;
        const entry = { file: resolved, model: m };
        out.push(entry);
        queue.push(entry);
      }
    }
    return out;
  }

  /**
   * Names declared anywhere in a document's include graph, plus whether the graph
   * was fully resolved. An unresolved include means the table is incomplete, and
   * callers must not treat a missing name as proof it does not exist.
   */
  symbolTable(doc: vscode.TextDocument): { symbols: Set<string>; complete: boolean } {
    const model = this.getModel(doc);
    const symbols = new Set<string>();
    let complete = true;
    for (const { file, model: m } of this.includeClosure(doc.uri.fsPath, model)) {
      for (const d of m.decls) symbols.add(d.name);
      for (const inc of m.includes) {
        if (!this.resolveInclude(file, inc.path)) complete = false;
      }
    }
    return { symbols, complete };
  }

  /**
   * Problems with a document's include graph.
   *
   * TARGET has no include guards. A file reached twice - directly, or through two
   * different headers - is compiled twice, and the second copy fails with
   * "Name already defined". Nesting deeper than eight fails outright with
   * "Too many include files (max = 8)". Neither is reported until build time, and
   * both are easy to create in a multi-file script.
   */
  analyzeIncludes(doc: vscode.TextDocument): IncludeAnalysis {
    const rootFile = doc.uri.fsPath;
    const rootModel = this.getModel(doc);
    const problems: IncludeProblem[] = [];

    /** resolved file -> the include chains that reach it, each named by basename. */
    const reachedBy = new Map<string, string[][]>();
    /** resolved file -> the include path written in the ROOT document that leads there. */
    const rootHop = new Map<string, string>();

    const walk = (
      file: string,
      model: DocModel,
      chain: string[],
      depth: number,
      firstHop: string | null
    ): void => {
      if (depth > MAX_INCLUDE_DEPTH + 2) return; // stop runaway recursion
      for (const inc of model.includes) {
        const resolved = this.resolveInclude(file, inc.path);
        if (!resolved) continue;
        const hop = firstHop ?? inc.path;
        const nextChain = [...chain, path.basename(resolved)];

        if (!reachedBy.has(resolved)) reachedBy.set(resolved, []);
        reachedBy.get(resolved)!.push(nextChain);
        if (!rootHop.has(resolved)) rootHop.set(resolved, hop);

        if (depth + 1 > MAX_INCLUDE_DEPTH) {
          problems.push({
            includePath: hop,
            code: 'include-too-deep',
            severity: 'error',
            message: `Include nesting is ${depth + 1} deep (${[path.basename(file), ...nextChain].join(' \u2192 ')}). TARGET allows ${MAX_INCLUDE_DEPTH} and fails with "Too many include files (max = ${MAX_INCLUDE_DEPTH})".`,
          });
          continue;
        }

        // Only descend the first time a file is seen, or a cycle would never end.
        if (reachedBy.get(resolved)!.length > 1) continue;
        const m = this.getModelForPath(resolved);
        if (m) walk(resolved, m, nextChain, depth + 1, hop);
      }
    };

    walk(rootFile, rootModel, [], 0, null);

    for (const [file, chains] of reachedBy) {
      if (chains.length < 2) continue;
      const base = path.basename(file);
      const how = chains.map((c) => [path.basename(rootFile), ...c].join(' \u2192 ')).slice(0, 3);
      problems.push({
        includePath: rootHop.get(file) ?? null,
        code: 'duplicate-include',
        severity: 'error',
        message: `${base} is included ${chains.length} times: ${how.join('  and  ')}. TARGET has no include guards, so the second copy fails to compile with "Name already defined". Include it once, from the .tmc only.`,
      });
    }

    // Names declared in more than one file in the graph.
    //
    // Two subtleties, both learned from real code that compiles:
    //
    //  - A `define` is a text substitution in its own namespace, so it may shadow a
    //    declaration without conflict. The corpus carries `define SET 1` while
    //    target.tmh declares `int SET(int i)`, and `define KBLayout ...` against
    //    `int KBLayout[]`. Only define-against-define, or declaration-against-
    //    declaration, actually collides.
    //  - The TARGET-supplied headers are excluded: a user declaration clashing with
    //    one of those is reported against the builtin tables instead, with a better
    //    message, and reporting both would say the same thing twice.
    const TARGET_HEADERS = new Set(['target.tmh', 'defines.tmh', 'hid.tmh', 'sys.tmh']);
    const owners = new Map<string, { file: string; isDefine: boolean }[]>();
    for (const { file, model } of this.includeClosure(rootFile, rootModel)) {
      if (TARGET_HEADERS.has(path.basename(file).toLowerCase())) continue;
      for (const d of model.decls) {
        if (!d.global) continue;
        if (!owners.has(d.name)) owners.set(d.name, []);
        owners.get(d.name)!.push({ file, isDefine: d.kind === 'define' });
      }
    }
    const duplicateSymbols = new Map<string, string[]>();
    for (const [name, list] of owners) {
      const defines = list.filter((e) => e.isDefine);
      const decls = list.filter((e) => !e.isDefine);
      const clashing = defines.length > 1 ? defines : decls.length > 1 ? decls : [];
      const files = new Set(clashing.map((e) => e.file));
      if (files.size < 2) continue;
      duplicateSymbols.set(name, [...files].map((f) => path.basename(f)));
    }

    return { problems, duplicateSymbols };
  }

  /** Global declarations visible from a document, across its include graph. */
  visibleDecls(doc: vscode.TextDocument): { decl: Decl; file: string }[] {
    const model = this.getModel(doc);
    const out: { decl: Decl; file: string }[] = [];
    for (const { file, model: m } of this.includeClosure(doc.uri.fsPath, model)) {
      for (const d of m.decls) if (d.global || file === doc.uri.fsPath) out.push({ decl: d, file });
    }
    return out;
  }
}

/** Maximum `include` nesting TARGET allows; a 9-deep chain fails to compile. */
export const MAX_INCLUDE_DEPTH = 8;

export interface IncludeProblem {
  /** The include path in the analysed document to anchor on, when one applies. */
  includePath: string | null;
  message: string;
  code: string;
  severity: 'error' | 'warning' | 'info';
}

export interface IncludeAnalysis {
  problems: IncludeProblem[];
  /** Declared name -> other files in the graph that also declare it. */
  duplicateSymbols: Map<string, string[]>;
}
