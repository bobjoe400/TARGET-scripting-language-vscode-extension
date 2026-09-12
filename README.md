# TARGET Script for VS Code

Language support for the Thrustmaster **T.A.R.G.E.T.** HOTAS scripting language
(`.tmc`, `.tmh`, `.ttm`).

Thrustmaster's bundled editor is little more than a text box with a Compile button,
and nothing else existed for this language — the usual advice was "use C# highlighting,
it's close enough". This gives it real tooling.

## Features

**Syntax highlighting**, including the hard part: `EXEC()` and `REXEC()` take TARGET
source code *inside a string literal*, and that code is highlighted as code, escaped
nested strings and all.

```c
MapKey(&Joystick, S4, EXEC("SetSCurve(&Joystick, JOYX, 0,0,0,5,0);"));
//                          ^^^^^^^^^ highlighted as a builtin, not as string text
```

**Device-aware completion.** Nobody remembers whether the button is `TG1`, `TS1` or
`TBTN1`. Type `MapKey(&T16000, ` and you get the T.16000M's controls — only those,
ordered by button index. It follows handles the script binds itself:

```c
alias MyJoystick;
&MyJoystick = &T16000;             // completion after &MyJoystick, knows it is a T16000
MapKeyUMD(&MyJoystick, TS1, ...);
```

Axis functions (`MapAxis`, `SetSCurve`, …) rank that device's axes first instead.

**Hover and signature help** for all 171 builtins, with the real parameter lists and
default values.

**Outline and go-to-definition**, including across `include` files — large scripts are
split over a dozen headers and Thrustmaster's editor has no navigation at all.

**Diagnostics** for things the TARGET compiler reports poorly or not at all:

| Check | Example |
| --- | --- |
| Constructs forbidden inside `EXEC`/`REXEC` | `EXEC("SEQ(a,b);")` — the manual forbids `SEQ`, `CHAIN`, `EXEC`, `REXEC`, `TEMPO`, `AXIS`, `LIST`, `SetCustomCurve` there |
| Argument count | `MapKeyIOUMD` takes 2–8 arguments |
| `REXEC` handle range | must be 0–99 |
| `AXMAP2` zones vs events | the counts must match |
| `AXMAP1` centre event | silently ignored when the zone count is odd |
| Numeric ranges | `SetSCurve` curve is −32..32; `LEDV` value is 0–7 |
| Control named for the wrong device | `MapKey(&T16000, APALT, …)` — `APALT` is a Warthog Throttle control |
| `include "target.tmh"` ordering | must come first |
| Missing `main()` | TARGET runs `main()`; without it the script does nothing |
| `main()` that never calls `Init()` | no virtual devices are ever created |
| Event handler passed to `Init()` does not exist | fails at runtime with `Symbol not found` |
| Handler that never calls `DefaultMapping()` | mappings and shift layers never take effect |
| Call to a function defined nowhere | a typo that TARGET only discovers mid-flight |
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

## Compiling and running

Three commands, from the Command Palette or the editor title bar:

| Command | What it does |
| --- | --- |
| **TARGET: Check Script for Compile Errors** (`Ctrl+Shift+B`) | Compiles without running. Errors land in the Problems panel at the right file and line. |
| **TARGET: Run Script** | Compiles, then launches the script with `TARGETGUI.exe -r`. |
| **TARGET: Stop Running Script** | Closes TARGET. |

While a script is running, a `TARGET: <script>` indicator sits in the status bar; click
it to stop. It clears itself once TARGET is no longer running, whether you stopped it
from here or closed TARGET's own window.

Run a header (`.tmh`/`.ttm`) and it compiles the `.tmc` beside it, since a header on its
own is not a compilation unit.

**The compile check never runs your script**, so it cannot touch your HOTAS. It invokes
`Interpreter.exe` asking for a function name that does not exist, which compiles every
file and then stops before executing anything. Checking the 15-file Elite Dangerous
script takes about 200 ms.

`Run` is different — it really does start TARGET and create the virtual devices, exactly
as the community `.cmd` launchers do. It compiles first and asks before launching if
there are errors.

### There is no headless run

Only TARGET's own GUI hosts can run a script. The runtime methods a script depends on —
the virtual devices, the event pump, even `printf` — are not in the interpreter: as
`hid.tmh` puts it, they are *"interpreter mapped methods (available from TmService)"*,
declared with empty bodies and bound by the host application at load time.
`Interpreter.exe` links neither `TmHidControl.dll` nor `TmCommon.dll`, and a script run
through it executes its logic but produces no output and drives no hardware. That is
precisely why it makes a good compile checker and cannot be a runner.

TARGETGUI and TARGET Script Editor are also mutually exclusive — TARGET enforces this
itself. `Run` checks for the conflict first and offers to close the other application,
rather than letting the launch fail silently in a window you may not be looking at.

Works on Windows, and from WSL (the Windows tools are invoked through interop).

**Keep scripts on a Windows drive if you want to run them.** TARGET cannot load a
script from the WSL filesystem: it can only reach one through a `\\wsl.localhost\`
UNC path and fails with "File not found". Run detects this and offers to run a copy
staged on a Windows drive, which is a copy - edits need another Run. The compile check
is unaffected either way, since `Interpreter.exe` handles UNC paths fine.

### Why compiling needs a staging directory

`Interpreter.exe` resolves `include` against the working directory only — it has no
search path — so no single directory can see both the TARGET headers and your project's
own headers. The extension stages the four TARGET headers and your project's script
files into a scratch directory, compiles there, and maps reported paths back to your
real files. The scratch directory is removed afterwards; nothing is written into your
project.

## Is this C?

No. It is a small C-flavoured interpreted language, and the resemblance runs out fast.
The following were all checked against the real TARGET compiler:

| Not supported | Write instead |
| --- | --- |
| `for`, `switch` / `case`, `continue` | `while`, `do ... while`, `if` / `else` |
| `++`, `--` | `i = i + 1` |
| `+=`, `-=`, `*=`, `/=`, `&=`, `\|=`, `<<=`, … | `x = x + y` |
| `\|\|` | `\|` (TARGET's logical or) |
| ternary `? :` | `if` / `else` |
| pointers (`int *p`) | `alias`, TARGET's reference type |
| `typedef`, `enum`, `const`, `unsigned` | `define` |
| `#include`, `#define` | `include`, `define` - no `#` |
| `include <stdint.h>` | there is no C standard library |
| `sizeof x` | `sizeof(&x)` - a function, not an operator |

What it does have that C does not: `alias` (a reference type), `byte` and `word`,
default parameter values (`int Key(int c, int delay=0)`), `Dim()` for sizing arrays at
runtime, and lazy symbol resolution - a call to a function that does not exist compiles
cleanly and fails only when it runs.

`&&` is worth singling out. It is **not** logical and: it is address-of-address, used
throughout `target.tmh` as `&&tmp`. `&` and `|` serve as the logical operators. The
extension does not flag `&&` for that reason.

Every item above is reported as an error with the TARGET equivalent, so reaching for
C out of habit tells you immediately rather than at runtime.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `targetScript.installPath` | auto-detect | The TARGET `scripts` folder. Used to resolve `include "target.tmh"` and to locate `TARGETGUI.exe` and `Interpreter.exe`. Set this if TARGET is not in the default location. |
| `targetScript.diagnostics.enable` | `true` | Turn diagnostics off entirely. |

## Where the data comes from

The builtin tables are **generated from the headers of an installed TARGET**
(`target.tmh`, `defines.tmh`, `hid.tmh`, `sys.tmh`) rather than transcribed from the
PDF manual, which is older than the shipping software and incomplete. The shipped
tables cover 171 functions, 851 constants and 38 devices.

Regenerate them after a TARGET update:

```bash
npm run gen -- --scripts "/path/to/Thrustmaster/TARGET/scripts"
```

The generator refuses to guess: any section or device alias it cannot place is
reported as a warning rather than silently dropped, so new hardware in a future TARGET
release shows up as something to map instead of quietly missing from completion.

## Development

```bash
npm install
npm run gen      # regenerate builtin tables and the grammar from your TARGET install
npm run compile
npm test
```

Press <kbd>F5</kbd> to launch an Extension Development Host on `test/fixtures`.

The test suite runs the grammar through `vscode-textmate` — the same engine VS Code
uses — and checks both directions: that broken code produces the expected diagnostic,
and that a corpus of known-good real-world scripts produces **none**.

## Acknowledgements

Grammar and diagnostics are validated against
[ED_Enhanced_T16000](https://github.com/bobjoe400/ED_Enhanced_T16000), a large
real-world Elite Dangerous TARGET script.

## License

MIT
