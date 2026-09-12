# Changelog

## 0.2.2

- Run now detects TARGET's mutually exclusive host applications before launching.
  TARGETGUI refuses to start while TARGET Script Editor is open and reports it in a
  modal of its own; because the GUI is launched detached, that refusal was invisible
  and the extension claimed success anyway. It now offers to close the Script Editor,
  or to restart TARGET if a script is already running.
- The success notification says "Launched", not "Running": TARGET is started
  detached, so anything it objects to appears in its own window.

## 0.2.1

- Fixed: the compile and run commands reported "Open a TARGET script first" when the
  active tab was not a text editor - the extension details page, a settings tab, a
  diff - even though the script was open in another tab. They now use the resource
  passed by the editor title-bar button, then the active editor, then a visible
  editor, then the last focused TARGET file, and only then report that nothing is
  open. Covered by a new command-layer test suite.

## 0.2.0

- Compile and run from the editor, without opening TARGET.
  - **TARGET: Check Script for Compile Errors** (`Ctrl+Shift+B`) compiles via
    `Interpreter.exe` and reports errors in the Problems panel at the correct file
    and line, including errors inside included headers. It asks for a function name
    that does not exist, so the script is compiled but never executed and no
    hardware is touched.
  - **TARGET: Run Script** compiles, then launches via `TARGETGUI.exe -r`.
  - **TARGET: Stop Running Script**.
- Works on Windows and from WSL.
- Compiling stages the TARGET headers and the project's scripts into a scratch
  directory, because `Interpreter.exe` resolves includes from the working directory
  only. Nothing is written into your project.

## 0.1.0

First release.

- Syntax highlighting for `.tmc`, `.tmh` and `.ttm`, including TARGET source
  embedded in `EXEC(...)` / `REXEC(...)` string arguments.
- Device-aware completion: the control names offered are those of the device in
  the call, resolved through handles the script binds itself.
- Hover documentation and signature help for all 171 builtins.
- Document outline, and go-to-definition across `include` files.
- Diagnostics: arity, constructs forbidden inside `EXEC`, `REXEC` handle range,
  `AXMAP1`/`AXMAP2` zone rules, numeric ranges, controls named for the wrong
  device, `include "target.tmh"` ordering, and C keywords TARGET does not have.
- Builtin tables generated directly from the headers of an installed TARGET,
  not transcribed from the manual.
