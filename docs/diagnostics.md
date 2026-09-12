# Diagnostics

Every check the extension performs, and why the structural ones exist at all.

*Part of the [T.A.R.G.E.T. Script](https://marketplace.visualstudio.com/items?itemName=bobjoe400.tm-target-script) VS Code extension. Back to the [README](../README.md).*

| Check | Example |
| --- | --- |
| Constructs forbidden inside `EXEC`/`REXEC` | `EXEC("SEQ(a,b);")` — the manual forbids `SEQ`, `CHAIN`, `EXEC`, `TEMPO`, `AXIS` and `LIST` there. `REXEC` is not on that list and is not flagged. `SetCustomCurve` is a hint rather than an error: the manual forbids it, but Thrustmaster's own shipped samples do it |
| Argument count | `MapKeyIOUMD` takes 2–8 arguments |
| `REXEC` handle range | must be 0–99 |
| `AXMAP2` zones vs events | the counts must match |
| `AXMAP1` centre event | silently ignored when the zone count is odd |
| Numeric ranges | `SetSCurve` curve is −32..32; `LEDV` value is 0–7 |
| Control named for the wrong device | `MapKey(&T16000, APALT, …)` — `APALT` is a Warthog Throttle control |
| `include "target.tmh"` ordering | must come first |
| Missing `main()` | TARGET runs `main()`; without it the script does nothing |
| A name nothing declares | `define CameraPreset1 L+CTL+USB[0x1E]` — `L` is defined nowhere, and `Interpreter.exe` compiles it anyway because TARGET resolves symbols lazily. Needs the TARGET headers to be resolvable: without a complete picture of what the project declares, the check stays quiet rather than guess |
| `main()` that never calls `Init()` | no virtual devices are ever created |
| Event handler passed to `Init()` does not exist | fails at runtime with `Symbol not found` |
| Handler that never calls `DefaultMapping()` | mappings and shift layers never take effect |
| Call to a function defined nowhere | a typo that TARGET only discovers mid-flight |
| DX buttons above `DX32` | a hint: whether it arrives depends on the game's DirectInput data format |
| A header included twice, or via a diamond | TARGET has no include guards: "Name already defined" |
| `include` nesting deeper than 8 | "Too many include files (max = 8)" |
| A name declared in two files of the graph | compiled twice, second one fails |
| `define ADD(a,b)` | no function-like macros |
| `return;` with no value | a syntax error in TARGET |
| Redeclaring a builtin, device or constant | "Name already defined" |
| A bare call at file scope | statements must live inside a function |
| C keywords TARGET lacks | `for`, `switch`, `continue`, `typedef`, `enum`, `const`, … |

Names borrowed from another device that happen to land on the same index (`TG1` and
`TS1` are both 0) are reported as a naming hint rather than an error, because that code
does work and real scripts rely on it.

### Why the structural checks matter

TARGET's compiler reports **only syntax errors**, and resolves every symbol lazily. All
of the following compile perfectly cleanly, verified against the real `Interpreter.exe`:

- a script with no `main()` at all
- `Init(&EventHandle)` where `EventHandle` is defined nowhere
- a call to a function that does not exist
- a script that never includes `target.tmh` while using builtins

Each one fails at runtime instead - which for a HOTAS script means discovering it after
the mapping silently does nothing, mid-flight. These checks exist because the
compiler's silence is not a guarantee.

The required skeleton is the one TARGET's own `CodeStart.template` generates: an
`include "target.tmh"` first, a `main()` that calls `Init(&EventHandle)`, and an
`EventHandle` that calls `DefaultMapping(&o, x)`. The `tmcmain` snippet writes it out.

The rules that need to know every declared name are skipped when an `include` cannot be
resolved, rather than reporting names that live in a file the extension could not read.
