# Changelog

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
