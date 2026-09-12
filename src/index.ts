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
