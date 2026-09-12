// Caches a parsed model per file and resolves `include` graphs, so that
// go-to-definition and completion can see symbols declared in other files.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { buildModel, DocModel, Decl } from './model';
import { readTextFile } from './encoding';
import {
  buildBindsIndex,
  BindsIndex,
  activePresetNames,
  fileMatchesPreset,
  bindingFormat,
  comparablePath,
  readAssociations,
  targetSettingsPaths,
} from './binds';
import { windowsSystemRoot, resolveEntryScript } from './runner';

/** Default locations of the TARGET install, used when the setting is empty. */
/**
 * Where TARGET usually lives. The WSL entries are derived from the real mount rather
 * than assuming /mnt/c: automount.root is configurable, and hardcoding it made
 * auto-detection fail completely under `root = /` - no install found, and
 * `include "target.tmh"` never resolving, which quietly disables the checks gated on
 * a complete symbol table.
 */
function defaultInstallDirs(): string[] {
  const windows = [
    'C:\\Program Files (x86)\\Thrustmaster\\TARGET\\scripts',
    'C:\\Program Files\\Thrustmaster\\TARGET\\scripts',
  ];
  const root = windowsSystemRoot();
  const mounted = root
    ? [
        path.join(root, 'Program Files (x86)', 'Thrustmaster', 'TARGET', 'scripts'),
        path.join(root, 'Program Files', 'Thrustmaster', 'TARGET', 'scripts'),
      ]
    : [];
  return [...windows, ...mounted, '/mnt/c/Program Files (x86)/Thrustmaster/TARGET/scripts'];
}

interface Entry {
  model: DocModel;
  /** Document version for an open file, or null when parsed from disk. */
  version: number | null;
  /** File timestamp for a file read from disk, or null when parsed from a document. */
  mtimeMs: number | null;
}

export class TargetIndex {
  private cache = new Map<string, Entry>();
  /** Bumped whenever anything cached changes, so derived caches expire together. */
  private generation = 0;
  private resolveCache = new Map<string, string | null>();
  /**
   * Existence checks, briefly cached. The revalidation above is what keeps a deleted
   * header from lingering, but every keystroke bumps the generation and re-walks the
   * graph, so without this it re-stats the TARGET headers across the WSL mount on
   * each one - tens of milliseconds of the extension host's single thread, for files
   * whose state changes on the scale of minutes.
   */
  private existsCache = new Map<string, { at: number; ok: boolean }>();

  private stillExists(p: string): boolean {
    const now = Date.now();
    const hit = this.existsCache.get(p);
    if (hit && now - hit.at < 2000) return hit.ok;
    const ok = fs.existsSync(p);
    if (this.existsCache.size > 256) this.existsCache.clear();
    this.existsCache.set(p, { at: now, ok });
    return ok;
  }
  private closureCache = new Map<string, { file: string; model: DocModel }[]>();

  /** The model for an open document, reparsed only when its version changes. */
  getModel(doc: vscode.TextDocument): DocModel {
    const key = doc.uri.toString();
    const hit = this.cache.get(key);
    if (hit && hit.version === doc.version) return hit.model;
    const model = buildModel(doc.getText());
    this.cache.set(key, { model, version: doc.version, mtimeMs: null });
    this.generation++;
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
    // An already-open document is the source of truth over what is on disk, and it
    // owns the cache entry. Writing a disk-shaped entry here would make the two
    // readers evict each other on every call, reparsing a header on every keystroke.
    // Case-insensitively: Windows and macOS paths are, so an include written
    // `ed_macros.tmh` resolving to ED_Macros.tmh would otherwise miss the open dirty
    // buffer and parse the saved file instead.
    const open = vscode.workspace.textDocuments.find(
      (d) =>
        // Uri.fsPath ignores the scheme, so a git: diff of a header has the same
        // fsPath as the file itself. Reading the committed content in place of the
        // working copy would silently change what every dependent file sees.
        d.uri.scheme === 'file' &&
        (d.uri.fsPath === p || d.uri.fsPath.toLowerCase() === p.toLowerCase())
    );
    if (open) return this.getModel(open);

    const hit = this.cache.get(key);
    if (hit && hit.mtimeMs === mtimeMs) return hit.model;
    const text = readTextFile(p);
    if (text === null) return null;
    const model = buildModel(text);
    // Bounded, like every other cache here. Files reached through the include graph -
    // the vendor headers, every header of every project visited - stayed resident with
    // their full text and token arrays for the session otherwise.
    if (this.cache.size > 128) this.pruneDiskEntries();
    this.cache.set(key, { model, version: null, mtimeMs });
    this.generation++;
    return model;
  }

  /** Drops models parsed from disk, keeping the ones backed by open documents. */
  private pruneDiskEntries(): void {
    for (const [key, entry] of this.cache) {
      if (entry.version === null) this.cache.delete(key);
    }
    this.closureCache.clear();
  }

  invalidate(uri: vscode.Uri): void {
    this.cache.delete(uri.toString());
    this.generation++;
    this.closureCache.clear();
    // Creating or deleting a .tmc changes which folder includes anchor to.
    if (/\.tmc$/i.test(uri.fsPath)) this.entryDirCache.clear();
    // Binding files are keyed on their own timestamps, so a script save does not
    // invalidate them; dropping the whole cache on every save made each hover
    // re-read every .binds file synchronously on the extension host thread.
    if (/\.binds$/i.test(uri.fsPath)) {
      this.bindsCache.clear();
      this.bindsScanCache.clear();
    }
  }

  /** Called when settings change: include resolution depends on them. */
  clearResolutionCache(): void {
    this.resolveCache.clear();
    // The entry anchor IS a resolution input now. Left behind, a header opened before
    // its .tmc existed kept the fallback anchor - its own folder, the old wrong rule -
    // for the rest of the session, and closureComplete could silently go false.
    this.entryDirCache.clear();
    this.existsCache.clear();
    this.closureCache.clear();
    this.bindsCache.clear();
    this.bindsScanCache.clear();
    this.generation++;
  }

  private bindsCache = new Map<string, { index: BindsIndex; stamp: string }>();
  /** Short-lived, so a hover does not re-scan the workspace for .binds files. */
  private bindsScanCache = new Map<string, { at: number; index: BindsIndex }>();
  private entryDirCache = new Map<string, string>();
  private associationsCache: { at: number; list: ReturnType<typeof readAssociations> } | null = null;

  /**
   * Elite Dangerous binding files near the script, so the editor can say what the
   * game does with a key. Searched beside the script, one level up, and in the
   * workspace root - which is where the community layouts keep them (a BindFiles
   * folder next to ScriptFiles).
   */
  /**
   * @param narrow when false, every binding file found is read - all games, all presets.
   *   The hover wants the narrowed answer for the active preset; "show me everywhere
   *   this is bound" is a different question and wants the whole picture.
   */
  getBindsIndex(doc: vscode.TextDocument, narrow = true): BindsIndex {
    // The directory scan below is synchronous and runs on the extension host thread,
    // and a hover should not pay for a readdir of the workspace root. Its result is
    // held briefly, keyed on where we looked rather than on what we found.
    const settings = vscode.workspace.getConfiguration('targetScript', doc.uri);
    const scanKey = `${narrow}\u0000${doc.uri.fsPath}\u0000${settings.get<string>('bindsFolder') ?? ''}`;
    const scanned = this.bindsScanCache.get(scanKey);
    if (scanned && Date.now() - scanned.at < 5000) return scanned.index;

    // Read against this document: bindsFolder is machine-overridable, so a multi-root
    // workspace can set a different one per folder, and the window-level value was
    // being applied to every script regardless of which folder it lived in.
    const configured = settings.get<string>('bindsFolder')?.trim();

    const dirs: string[] = [];
    const scriptDir = path.dirname(doc.uri.fsPath);
    if (configured) dirs.push(configured);
    dirs.push(scriptDir, path.dirname(scriptDir));
    const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
    if (folder) dirs.push(folder.uri.fsPath);

    const files: string[] = [];
    const presetDirs: string[] = [];
    for (const dir of [...new Set(dirs)]) {
      for (const candidate of [dir, path.join(dir, 'BindFiles'), path.join(dir, 'Bindings')]) {
        try {
          if (!fs.statSync(candidate).isDirectory()) continue;
          presetDirs.push(candidate);
          for (const name of fs.readdirSync(candidate)) {
            // Elite Dangerous writes .binds, DCS a .diff.lua per module and device, and
            // Star Citizen a plain .xml - which is why the .xml is confirmed by its root
            // element rather than taken on the extension, TrackIR profiles being the
            // usual neighbour.
            if (/\.(binds|xml)$/i.test(name) || /\.diff\.lua$/i.test(name)) {
              files.push(path.join(candidate, name));
            }
          }
        } catch {
          /* not a readable directory */
        }
      }
    }
    let unique = [...new Set(files)].sort();

    // The TARGET GUI records which game each script is associated with. Where that
    // exists it settles what the extension otherwise guesses at, so the other games'
    // files can be dropped rather than merged into one contradictory answer.
    //
    // Strictly a hint. It lives in the user's own roaming profile, not in the project,
    // so anyone who clones a script repo has none - and the behaviour without it must be
    // exactly what it was before. It only ever narrows, and never to nothing.
    const associated = narrow ? this.associatedGame(doc) : null;
    if (associated) {
      const forGame = unique.filter((f) => bindingFormat(f) === associated);
      if (forGame.length) unique = forGame;
    }

    // Which preset the game will actually load. A Bindings folder collects every preset
    // the player has ever tried, and the community layouts ship more beside the script;
    // they bind the same keys to different actions, so merging them answers the question
    // with a pile of contradictions. When the active one is known, only it is read.
    let activePreset: string | null = null;
    for (const dir of narrow ? presetDirs : []) {
      const names = activePresetNames(dir);
      const matched = names.find((n) => unique.some((f) => fileMatchesPreset(f, n)));
      if (matched) {
        activePreset = matched;
        break;
      }
    }
    if (activePreset) {
      // Presets are an Elite Dangerous idea. DCS and Star Citizen have one file per
      // module or one exported mapping, so they are never filtered by it.
      const others = unique.filter((f) => !/\.binds$/i.test(f));
      const inPreset = unique.filter((f) => fileMatchesPreset(f, activePreset!));
      if (inPreset.length) unique = [...inPreset, ...others].sort();
    }

    // Rebuild only when the set of files or their timestamps change.
    const stamp = unique
      .map((f) => {
        try {
          return `${f}:${fs.statSync(f).mtimeMs}`;
        } catch {
          return f;
        }
      })
      .join('|');
    // Keyed on the file set: two documents in different folders would otherwise
    // evict each other on every hover.
    const cacheKey = `${narrow}\u0000${activePreset ?? ''}\u0000${unique.join('|')}`;
    const hit = this.bindsCache.get(cacheKey);
    if (hit && hit.stamp === stamp) {
      if (this.bindsScanCache.size > 16) this.bindsScanCache.clear();
      this.bindsScanCache.set(scanKey, { at: Date.now(), index: hit.index });
      return hit.index;
    }
    const index = buildBindsIndex(unique, activePreset);
    if (this.bindsCache.size > 8) this.bindsCache.clear();
    this.bindsCache.set(cacheKey, { index, stamp });
    if (this.bindsScanCache.size > 16) this.bindsScanCache.clear();
    this.bindsScanCache.set(scanKey, { at: Date.now(), index });
    return index;
  }

  /**
   * The entry script's folder, which is what the compiler resolves includes against.
   * Cached: resolveEntryScript reads directories, and this is asked once per include.
   */
  /**
   * The game the TARGET GUI says this script is for, if it says anything.
   *
   * Looked up by the entry script, so it answers for a header as well as for the .tmc
   * the association actually names. Returns null whenever there is no association, no
   * settings file, or the executable is one we have no parser for.
   */
  private associatedGame(doc: vscode.TextDocument): string | null {
    const { entry, candidates } = resolveEntryScript(doc.uri.fsPath);
    const mine = new Set((entry ? [entry] : candidates).map(comparablePath));
    if (!mine.size) return null;
    const now = Date.now();
    if (!this.associationsCache || now - this.associationsCache.at > 10_000) {
      this.associationsCache = {
        at: now,
        list: targetSettingsPaths(windowsSystemRoot()).flatMap(readAssociations),
      };
    }
    for (const a of this.associationsCache.list) {
      if (a.game && mine.has(comparablePath(a.script))) return a.game;
    }
    return null;
  }

  private entryDirFor(file: string): string {
    const hit = this.entryDirCache.get(file);
    if (hit !== undefined) return hit;
    const { entry } = resolveEntryScript(file);
    const dir = path.dirname(entry ?? file);
    if (this.entryDirCache.size > 64) this.entryDirCache.clear();
    this.entryDirCache.set(file, dir);
    return dir;
  }

  /**
   * Directories searched for `include "..."`, nearest first.
   *
   * The first one is the ENTRY script's folder, not the including file's. Interpreter.exe
   * resolves every include against its working directory, which is where the .tmc sits -
   * it does not look beside the file doing the including the way a C preprocessor would.
   * Searching the including file's folder got this wrong in both directions: a header in
   * a subfolder including its own sibling looked fine here and failed at build time,
   * while a layout that really compiles was judged unresolvable, which silently switched
   * off every check needing a complete symbol table.
   */
  private searchDirs(fromFile: string, entryDir?: string): string[] {
    const dirs = [entryDir ?? path.dirname(fromFile)];
    const configured = vscode.workspace
      .getConfiguration('targetScript', vscode.Uri.file(fromFile))
      .get<string>('installPath')
      ?.trim();
    if (configured) {
      // findInstall() tolerates this setting pointing at either the install root or
      // its scripts folder, so include resolution must too. Otherwise the compile and
      // run commands work while `include "target.tmh"` silently fails to resolve,
      // which quietly disables the checks that need a complete symbol table.
      dirs.push(configured, path.join(configured, 'scripts'));
    }
    for (const d of defaultInstallDirs()) if (!dirs.includes(d)) dirs.push(d);
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(fromFile));
    if (folder) dirs.push(folder.uri.fsPath);
    return dirs;
  }

  /**
   * Resolves an include to an absolute path.
   * Per the manual, macro and header files live alongside the main script; only
   * the TARGET-supplied headers come from the install directory.
   */
  resolveInclude(fromFile: string, includePath: string, entryDir?: string): string | null {
    const from = entryDir ?? this.entryDirFor(fromFile);
    // Memoised: resolution costs two syscalls per candidate directory, and the
    // default search list includes the TARGET install under /mnt/c, where a single
    // stat is milliseconds. The graph is walked several times per refresh.
    const key = `${from}\u0000${includePath}`;
    const cached = this.resolveCache.get(key);
    // Confirm the cached path is still there. One stat, against the up-to-twelve the
    // full search costs. Without it, deleting or renaming a header left the stale
    // success in place: closureComplete stayed true while the file had dropped out of
    // the closure, so the entry script filled with "not defined" for every symbol that
    // lived in it - the exact false positive the cache was meant to avoid.
    if (cached !== undefined) {
      if (cached === null || this.stillExists(cached)) return cached;
      this.resolveCache.delete(key);
      this.closureCache.clear();
    }
    const resolved = this.resolveIncludeUncached(fromFile, includePath, from);
    // Only successes are cached. A failure is a file that does not exist *yet* - the
    // ordinary workflow is to write the include and then create the file - and caching
    // that would keep the include broken for the session: no go-to-definition, its
    // symbols never in the table, and closureComplete stuck false, which silently
    // disables the checks that need a complete symbol table.
    if (resolved !== null) {
      if (this.resolveCache.size > 512) this.resolveCache.clear();
      this.resolveCache.set(key, resolved);
    }
    return resolved;
  }

  private resolveIncludeUncached(fromFile: string, includePath: string, entryDir?: string): string | null {
    const normalized = includePath.replace(/\\/g, path.sep).replace(/\//g, path.sep);
    if (path.isAbsolute(normalized) && fs.existsSync(normalized)) return normalized;
    for (const dir of this.searchDirs(fromFile, entryDir)) {
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
  includeClosure(startFile: string, startModel: DocModel, limit = CLOSURE_LIMIT): { file: string; model: DocModel }[] {
    // Memoised per generation: a single diagnostics refresh walks the graph from
    // several directions, and the walk is the expensive part.
    const cachedClosure = this.closureCache.get(`${startFile}@${this.generation}`);
    if (cachedClosure) return cachedClosure;
    const result = this.includeClosureUncached(startFile, startModel, limit);
    // Keyed on the generation the walk ENDED at, not the one it started from. The walk
    // parses files off disk, and each parse bumps the generation - so an entry stored
    // under the starting value was already unreachable when it was written, and the
    // first walk after any reparse was always repeated.
    const cacheKey = `${startFile}@${this.generation}`;
    // The generation bumps on every reparse, so entries from older generations are
    // dead the moment they are replaced. Drop them rather than letting the map grow
    // one entry per keystroke between saves.
    if (this.closureCache.size > 32) this.closureCache.clear();
    this.closureCache.set(cacheKey, result);
    return result;
  }

  private includeClosureUncached(
    startFile: string,
    startModel: DocModel,
    limit = CLOSURE_LIMIT
  ): { file: string; model: DocModel }[] {
    const out: { file: string; model: DocModel }[] = [{ file: startFile, model: startModel }];
    const seen = new Set([startFile]);
    const entryDir = this.entryDirFor(startFile);
    const queue: { file: string; model: DocModel }[] = [{ file: startFile, model: startModel }];

    while (queue.length && out.length < limit) {
      const cur = queue.shift()!;
      for (const inc of cur.model.includes) {
        const resolved = this.resolveInclude(cur.file, inc.path, entryDir);
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
  /**
   * Every name the PROJECT declares, resolved from the entry script rather than from
   * this document.
   *
   * TARGET has no include guards and the order of includes matters, so a header
   * routinely uses a name its includer defined earlier - ED_UserSettings.tmh reads
   * `define CMDRNameOverride DISABLED` while DISABLED lives in ED_ScriptDefines.ttm,
   * which it does not include. Judged on its own closure that is an undefined name; in
   * the project it is perfectly ordinary. Anything reporting undefined names in a
   * header has to ask the entry script, or it invents errors in working code.
   */
  projectSymbols(doc: vscode.TextDocument): { symbols: Set<string>; complete: boolean } {
    const { entry, candidates } = resolveEntryScript(doc.uri.fsPath);
    if (entry === doc.uri.fsPath) return this.symbolTable(doc);
    // Every .tmc that could be the entry, not just an unambiguous one. A folder holding
    // two profiles is ordinary, a header may belong to either, and a name defined by
    // one of them is not a typo just because the other does not define it.
    const roots = entry ? [entry] : candidates;
    if (!roots.length) return this.symbolTable(doc);

    const symbols = new Set<string>();
    let complete = false;
    let reachesThisFile = false;
    for (const root of roots) {
      const rootModel = this.getModelForPath(root);
      if (!rootModel) continue;
      const closure = this.includeClosure(root, rootModel);
      if (!closure.some((c) => c.file === doc.uri.fsPath)) continue;
      reachesThisFile = true;
      let thisComplete = closure.length < CLOSURE_LIMIT;
      const entryDir = this.entryDirFor(root);
      for (const { file, model: m } of closure) {
        for (const d of m.decls) symbols.add(d.name);
        for (const inc of m.includes) {
          const resolved = this.resolveInclude(file, inc.path, entryDir);
          if (!resolved || !closure.some((c) => c.file === resolved)) thisComplete = false;
        }
      }
      // One fully-resolved project is enough to judge against; a second that happens to
      // be broken should not switch the checks off.
      if (thisComplete) complete = true;
    }
    // A header no entry script includes is not part of any project here, and its names
    // would be judged against the wrong table.
    if (!reachesThisFile) return this.symbolTable(doc);
    // The open buffer wins over what is on disk for its own declarations.
    for (const d of this.getModel(doc).decls) symbols.add(d.name);
    return { symbols, complete };
  }

  symbolTable(doc: vscode.TextDocument): { symbols: Set<string>; complete: boolean } {
    const model = this.getModel(doc);
    const symbols = new Set<string>();
    let complete = true;
    const closure = this.includeClosure(doc.uri.fsPath, model);
    // Hitting the traversal cap means files were left out, so the table is partial -
    // which is exactly the condition closureComplete exists to report. Without this,
    // a large project produced confident "not defined" warnings for symbols that were
    // simply never visited.
    if (closure.length >= CLOSURE_LIMIT) complete = false;
    const symEntryDir = this.entryDirFor(doc.uri.fsPath);
    for (const { file, model: m } of closure) {
      for (const d of m.decls) symbols.add(d.name);
      for (const inc of m.includes) {
        const resolved = this.resolveInclude(file, inc.path, symEntryDir);
        if (!resolved) {
          complete = false;
          continue;
        }
        // Resolving is not the same as reading. A header that exists but cannot be
        // decoded is dropped from the closure, and calling the table complete then
        // re-enables the very check this flag exists to gate.
        if (!closure.some((c) => c.file === resolved)) complete = false;
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
    const graphEntryDir = this.entryDirFor(rootFile);
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
        const resolved = this.resolveInclude(file, inc.path, graphEntryDir);
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

/** How many files one traversal will visit before giving up. */
const CLOSURE_LIMIT = 64;

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
