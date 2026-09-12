// Compiling and running scripts through the installed TARGET toolchain.
//
// Two separate tools do the work, and they behave differently:
//
//   TARGETGUI.exe -r <script.tmc>   compiles and RUNS a script, creating the virtual
//                                   devices. This is what the community launcher
//                                   scripts invoke.
//
//   Interpreter.exe <script> <fn>   compiles a script and calls one function in it.
//                                   Passing a function name that does not exist gives
//                                   a compile check with nothing executed, so no
//                                   hardware is touched.
//
// Interpreter.exe resolves `include` ONLY against the current working directory - it
// has no search path - so a project cannot see both the TARGET headers and its own
// headers from any single directory. compileCheck works around that by staging both
// into a scratch directory, and maps reported paths back to the originals by name.
//
// This module deliberately avoids importing `vscode` so it can be tested directly.

import { execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** Function name used to force a compile without running anything. */
const NO_RUN_SENTINEL = '__targetscript_compile_check__';

const SCRIPT_EXT = /\.(tmc|tmh|ttm)$/i;
/** The headers TARGET ships, which every script includes. */
const TARGET_HEADERS = ['target.tmh', 'defines.tmh', 'hid.tmh', 'sys.tmh'];

export type Host = 'windows' | 'wsl' | 'unsupported';

export function detectHost(): Host {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'linux') {
    try {
      // WSL can launch Windows executables directly through interop.
      const v = fs.readFileSync('/proc/version', 'utf8').toLowerCase();
      if (v.includes('microsoft')) return 'wsl';
    } catch {
      /* not WSL */
    }
  }
  return 'unsupported';
}

/** A path in the form Windows understands. Under WSL that means asking wslpath. */
export async function toWindowsPath(p: string): Promise<string> {
  if (process.platform === 'win32') return p;
  const { stdout } = await execFileAsync('wslpath', ['-w', p]);
  return stdout.trim();
}

export interface TargetInstall {
  /** Install root, e.g. C:\Program Files (x86)\Thrustmaster\TARGET */
  root: string;
  scripts: string;
  targetGui: string | null;
  interpreter: string | null;
}

const CANDIDATE_ROOTS = [
  'C:\\Program Files (x86)\\Thrustmaster\\TARGET',
  'C:\\Program Files\\Thrustmaster\\TARGET',
  '/mnt/c/Program Files (x86)/Thrustmaster/TARGET',
  '/mnt/c/Program Files/Thrustmaster/TARGET',
];

/**
 * Locates the TARGET install.
 * `configuredScriptsDir` is the `targetScript.installPath` setting, which points at
 * the scripts folder; the install root is its parent.
 */
export function findInstall(configuredScriptsDir?: string): TargetInstall | null {
  const roots: string[] = [];
  if (configuredScriptsDir?.trim()) {
    const s = configuredScriptsDir.trim();
    roots.push(path.dirname(s));
    // Tolerate the setting pointing at the root itself.
    roots.push(s);
  }
  roots.push(...CANDIDATE_ROOTS);

  for (const root of roots) {
    const scripts = path.join(root, 'scripts');
    if (!safeIsDir(scripts)) continue;
    if (!safeIsFile(path.join(scripts, 'target.tmh'))) continue;
    return {
      root,
      scripts,
      targetGui: firstExisting([
        path.join(root, 'x64', 'TARGETGUI.exe'),
        path.join(root, 'TARGETGUI.exe'),
      ]),
      interpreter: firstExisting([path.join(root, 'Interpreter.exe')]),
    };
  }
  return null;
}

const safeIsDir = (p: string) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const safeIsFile = (p: string) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};
const firstExisting = (ps: string[]) => ps.find(safeIsFile) ?? null;

/** A byte-order mark, which the TARGET compiler cannot read. */
export function bomKind(buf: Buffer): string | null {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return 'UTF-16 LE';
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return 'UTF-16 BE';
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return 'UTF-8 with BOM';
  return null;
}

/**
 * Copies a file by reading and writing it.
 *
 * fs.copyFileSync fails with EACCES on WSL's drive mounts when the source is
 * read-only, which the TARGET headers under Program Files are. Reading and writing
 * the bytes sidesteps the mode-preserving syscall and behaves the same on Windows.
 */
function copyFileBytes(src: string, dst: string): void {
  fs.writeFileSync(dst, fs.readFileSync(src));
}

export interface CompileProblem {
  /** Absolute path of the original file, mapped back from the staging copy. */
  file: string;
  /** 1-based. */
  line: number;
  message: string;
}

export interface CompileResult {
  ok: boolean;
  problems: CompileProblem[];
  /** Raw tool output, shown in the output channel. */
  output: string;
  /** Set when the check could not be performed at all. */
  error?: string;
}

/**
 * Compiles a script without running it.
 *
 * The whole project folder is staged alongside the TARGET headers because
 * Interpreter.exe resolves includes from the working directory only. Per the manual,
 * a script's headers live next to it, so copying that one folder is sufficient.
 */
export async function compileCheck(
  scriptPath: string,
  install: TargetInstall,
  opts: { stagingRoot?: string } = {}
): Promise<CompileResult> {
  if (!install.interpreter) {
    return { ok: false, problems: [], output: '', error: 'Interpreter.exe not found in the TARGET install.' };
  }

  const projectDir = path.dirname(scriptPath);
  const stagingRoot = opts.stagingRoot ?? (await defaultStagingRoot());
  const stage = path.join(stagingRoot, `target-compile-${process.pid}-${Date.now()}`);

  try {
    fs.mkdirSync(stage, { recursive: true });

    // The TARGET headers first, so a project file of the same name wins if it exists.
    for (const h of TARGET_HEADERS) {
      const src = path.join(install.scripts, h);
      if (safeIsFile(src)) copyFileBytes(src, path.join(stage, h));
    }

    /** Staged basename -> original absolute path, for mapping errors back. */
    const origin = new Map<string, string>();
    /** Files the compiler will choke on before reading a single statement. */
    const bomFiles: { file: string; kind: string }[] = [];
    for (const entry of fs.readdirSync(projectDir)) {
      if (!SCRIPT_EXT.test(entry)) continue;
      const src = path.join(projectDir, entry);
      if (!safeIsFile(src)) continue;
      const bytes = fs.readFileSync(src);
      const bom = bomKind(bytes);
      if (bom) bomFiles.push({ file: src, kind: bom });
      fs.writeFileSync(path.join(stage, entry), bytes);
      origin.set(entry.toLowerCase(), src);
    }

    const main = path.basename(scriptPath);
    const { stdout, stderr, timedOut } = await runTool(install.interpreter, [main, NO_RUN_SENTINEL], stage);
    const output = `${stdout}${stderr}`.replace(/\r/g, '');
    if (timedOut) {
      return { ok: false, problems: [], output, error: 'Interpreter.exe did not finish within 60 seconds.' };
    }

    const problems = parseCompileOutput(output, stage, projectDir, origin, scriptPath);
    // A byte-order mark makes the compiler fail on line 1 with "Type required", which
    // says nothing about the real cause. Thrustmaster's own editor writes UTF-16, so
    // this is easy to hit and baffling without being told.
    if (problems.some((p) => p.line <= 1)) {
      for (const b of bomFiles) {
        problems.unshift({
          file: b.file,
          line: 1,
          message: `${path.basename(b.file)} begins with a ${b.kind} byte-order mark. The TARGET compiler cannot read it and fails on line 1. Save the file as plain ASCII or UTF-8 without a BOM.`,
        });
      }
    }
    // Reaching the sentinel means every file compiled; only the fake entry point was missing.
    const compiled = output.includes(`Symbol not found: ${NO_RUN_SENTINEL}`);
    return { ok: compiled && problems.length === 0, problems, output };
  } catch (e) {
    return { ok: false, problems: [], output: '', error: e instanceof Error ? e.message : String(e) };
  } finally {
    try {
      fs.rmSync(stage, { recursive: true, force: true });
    } catch {
      /* a leftover scratch directory is harmless */
    }
  }
}

/**
 * Parses Interpreter.exe output.
 *
 *   Compile error: <message>, in <file>, at line <n>
 *   Runtime error: <message>, in <fn> (line <n> in <file>)
 *
 * The message can itself contain ", in ", so the trailing groups are matched greedily
 * from the left, which anchors on the LAST occurrence.
 */
export function parseCompileOutput(
  output: string,
  stageDir: string,
  projectDir: string,
  origin: Map<string, string>,
  /** Where to attach an error the compiler reports without a position. */
  fallbackFile?: string
): CompileProblem[] {
  const problems: CompileProblem[] = [];
  const resolve = (reported: string): string => {
    const base = path.basename(reported.trim()).toLowerCase();
    return origin.get(base) ?? path.join(projectDir, path.basename(reported.trim()));
  };

  for (const line of output.split('\n')) {
    const text = line.trim();
    if (!text) continue;

    let m = /^Compile error: (.+), in (.+), at line (\d+)$/.exec(text);
    if (m) {
      problems.push({ file: resolve(m[2]), line: parseInt(m[3], 10), message: m[1] });
      continue;
    }
    m = /^Runtime error: (.+), in (.+) \(line (\d+) in (.+)\)$/.exec(text);
    if (m) {
      problems.push({ file: resolve(m[4]), line: parseInt(m[3], 10), message: `${m[1]} (in ${m[2]})` });
      continue;
    }
    // A compile error without position information still deserves reporting.
    m = /^Compile error: (.+)$/.exec(text);
    if (m && !/at line \d+$/.test(text)) {
      // Attach to the entry script, not the folder: path.join(dir, '') is the
      // directory itself, which is not a document and cannot be opened.
      problems.push({ file: fallbackFile ?? path.join(projectDir, 'unknown'), line: 1, message: m[1] });
    }
  }
  return problems;
}

/**
 * Runs a Windows tool, from WSL if need be. A non-zero exit is not an error here:
 * Interpreter.exe reports compile errors on stdout and still exits 0.
 *
 * stdin MUST be 'ignore'. The interpreter supports an input() builtin and blocks
 * forever reading an inherited pipe that is never closed; with stdin ignored the
 * same compile returns in milliseconds.
 */
function runTool(
  exe: string,
  args: string[],
  cwd: string,
  timeoutMs = 60_000
): Promise<{ stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout?.on('data', (d) => (stdout += d.toString()));
    child.stderr?.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', () => resolve({ stdout, stderr, timedOut }));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.on('close', () => clearTimeout(timer));
  });
}

async function defaultStagingRoot(): Promise<string> {
  if (process.platform === 'win32') return os.tmpdir();
  // Under WSL the tool is a Windows process, so it must be able to see the staging
  // directory: use the Windows temp directory rather than the Linux one.
  try {
    const { stdout } = await execFileAsync('/mnt/c/Windows/System32/cmd.exe', ['/c', 'echo %TEMP%'], {
      cwd: '/mnt/c',
    });
    const win = stdout.trim().replace(/\r/g, '');
    if (win && !win.includes('%')) {
      const { stdout: lin } = await execFileAsync('wslpath', ['-u', win]);
      const dir = lin.trim();
      if (safeIsDir(dir)) return dir;
    }
  } catch {
    /* fall through */
  }
  return os.tmpdir();
}

/** Launches the script through TARGETGUI, which creates the virtual devices. */
export async function runScript(scriptPath: string, install: TargetInstall): Promise<{ ok: boolean; error?: string; command?: string }> {
  if (!install.targetGui) return { ok: false, error: 'TARGETGUI.exe not found in the TARGET install.' };
  const winScript = await toWindowsPath(scriptPath);
  const command = `"${install.targetGui}" -r "${winScript}"`;
  try {
    const child = spawn(install.targetGui, ['-r', winScript], {
      cwd: path.dirname(install.targetGui),
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return { ok: true, command };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), command };
  }
}

/** Stops a running script by closing TARGETGUI. */
export async function stopScript(): Promise<{ ok: boolean; error?: string }> {
  const host = detectHost();
  const taskkill = host === 'windows' ? 'taskkill' : '/mnt/c/Windows/System32/taskkill.exe';
  try {
    await execFileAsync(taskkill, ['/IM', 'TARGETGUI.exe', '/F'], { cwd: host === 'windows' ? undefined : '/mnt/c' });
    return { ok: true };
  } catch (e) {
    // taskkill exits non-zero when nothing matched, which is not a failure worth raising.
    const msg = e instanceof Error ? e.message : String(e);
    if (/not found|not running/i.test(msg)) return { ok: true };
    return { ok: false, error: msg };
  }
}

/**
 * The .tmc a given file belongs to. Compiling a header on its own is meaningless,
 * so an open .tmh resolves to the single .tmc beside it when there is exactly one.
 */
export function resolveEntryScript(filePath: string): { entry: string | null; candidates: string[] } {
  if (/\.tmc$/i.test(filePath)) return { entry: filePath, candidates: [filePath] };
  const dir = path.dirname(filePath);
  let candidates: string[] = [];
  try {
    candidates = fs
      .readdirSync(dir)
      .filter((f) => /\.tmc$/i.test(f))
      .map((f) => path.join(dir, f));
  } catch {
    /* unreadable */
  }
  return { entry: candidates.length === 1 ? candidates[0] : null, candidates };
}

/**
 * TARGET's own hosts are mutually exclusive: TARGETGUI refuses to start while
 * TARGET Script Editor is open, and reports it in a modal of its own. Since the GUI
 * is launched detached, that refusal is invisible from here, so the conflict is
 * detected before launching rather than after.
 */
export interface TargetProcesses {
  gui: boolean;
  editor: boolean;
}

const IMAGE_GUI = 'TARGETGUI.exe';
const IMAGE_EDITOR = 'TARGETScriptEditor.exe';

/** Guards against a slow tasklist piling up behind an interval timer. */
let processListInFlight: Promise<TargetProcesses> | null = null;

export async function listTargetProcesses(): Promise<TargetProcesses> {
  if (processListInFlight) return processListInFlight;
  processListInFlight = listTargetProcessesUncached().finally(() => {
    processListInFlight = null;
  });
  return processListInFlight;
}

async function listTargetProcessesUncached(): Promise<TargetProcesses> {
  const running = async (image: string): Promise<boolean> => {
    const host = detectHost();
    const tasklist = host === 'windows' ? 'tasklist' : '/mnt/c/Windows/System32/tasklist.exe';
    try {
      const { stdout } = await execFileAsync(tasklist, ['/FI', `IMAGENAME eq ${image}`], {
        cwd: host === 'windows' ? undefined : '/mnt/c',
        // Without this a stalled tasklist would hang the poll indefinitely.
        timeout: 10_000,
      });
      return stdout.toLowerCase().includes(image.toLowerCase());
    } catch {
      // Unable to ask: assume nothing is running rather than block the user.
      return false;
    }
  };
  const [gui, editor] = await Promise.all([running(IMAGE_GUI), running(IMAGE_EDITOR)]);
  return { gui, editor };
}

/** Closes one of TARGET's host applications by image name. */
export async function killImage(image: string): Promise<{ ok: boolean; error?: string }> {
  const host = detectHost();
  const taskkill = host === 'windows' ? 'taskkill' : '/mnt/c/Windows/System32/taskkill.exe';
  try {
    await execFileAsync(taskkill, ['/IM', image, '/F'], { cwd: host === 'windows' ? undefined : '/mnt/c' });
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/not found|not running/i.test(msg)) return { ok: true };
    return { ok: false, error: msg };
  }
}

export const TARGET_IMAGES = { gui: IMAGE_GUI, editor: IMAGE_EDITOR };

/**
 * True when TARGET's tools can reach this path as an ordinary local file.
 *
 * Under WSL, a script in the Linux filesystem is only reachable through a
 * \\wsl.localhost\ UNC path. Interpreter.exe copes with those, but TARGETGUI fails to
 * load a script from one, reporting "File not found" for a path under the script's own
 * directory. Rather than hand TARGET a path it cannot use, such a project is staged
 * onto a Windows drive first.
 */
export function isWindowsLocalPath(p: string): boolean {
  if (process.platform === 'win32') return /^[A-Za-z]:[\\/]/.test(p);
  return /^\/mnt\/[a-z]\//i.test(p);
}

export interface RunStaging {
  /** Absolute path of the staged entry script. */
  entry: string;
  dir: string;
}

/**
 * Copies a project onto a Windows drive so TARGET can load it.
 *
 * Unlike the compile staging this directory is kept, because TARGET goes on reading
 * from it while the script runs. It is cleared at the start of the next run instead.
 */
export async function stageProjectForRun(
  scriptPath: string,
  install: TargetInstall
): Promise<{ ok: true; staging: RunStaging } | { ok: false; error: string }> {
  try {
    const projectDir = path.dirname(scriptPath);
    const root = await defaultStagingRoot();
    const dir = path.join(root, 'target-script-run', path.basename(projectDir) || 'script');

    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });

    // The TARGET headers first, so the script's includes resolve beside it whatever
    // search order TARGET uses.
    for (const h of TARGET_HEADERS) {
      const src = path.join(install.scripts, h);
      if (safeIsFile(src)) copyFileBytes(src, path.join(dir, h));
    }
    for (const entry of fs.readdirSync(projectDir)) {
      if (!SCRIPT_EXT.test(entry)) continue;
      const src = path.join(projectDir, entry);
      if (safeIsFile(src)) copyFileBytes(src, path.join(dir, entry));
    }

    return { ok: true, staging: { entry: path.join(dir, path.basename(scriptPath)), dir } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
