# T.A.R.G.E.T. Script for VS Code

Language support for the Thrustmaster **T.A.R.G.E.T.** HOTAS scripting language
(`.tmc`, `.tmh`, `.ttm`).

> **Unofficial.** This is a community extension. It is not made, supported or endorsed
> by Thrustmaster / Guillemot, and bug reports about it belong
> [here](https://github.com/bobjoe400/TARGET-scripting-language-vscode-extension/issues)
> rather than with them.

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

**What the game does with the key.** A script sends keystrokes and virtual buttons; the
game decides what they mean, and that lives only in the game's own binding files. The
extension reads them:

| Game | File | Found in |
| --- | --- | --- |
| Elite Dangerous | `.binds` | beside the script, `BindFiles/`, or the game's `Bindings` folder |
| DCS World | `.diff.lua` | `Saved Games/DCS*/Config/Input/<aircraft>/` |
| Star Citizen | ActionMaps `.xml` | beside the script, or `Mappings/` |

Hover `L_ALT+USB[0x4F]` and it answers for *that chord* - not for the bare key, and not
for the same key under a different modifier, which belong to other lines of your script.
Hover `DX25` and it says what the game does with the button, which is what a TARGET
script is actually for.

It narrows to the preset the game will really load (Elite records it in
`StartPreset.start`), to the game your script is associated with in the TARGET GUI, and
for DCS to the device your script creates - reporting which aircraft each binding came
from, since DCS has every module's bindings live at once. Right-click → **Show Where
This Key Is Bound** opens a peek with every place it is bound, across all of them.

The lookup is by key rather than by name, because script authors name their defines
however they like: of the 200 defines in the test corpus only 15 match a game action
name.

**Default DirectX mappings.** With no script running, `TS1` sends `DX1` and `MSP` sends
`DX26`. Hover and completion say so, which matters when a script means to preserve a
default or you are working out what an existing game binding pointed at.

**Arguments offer only what belongs in them.** `Configure(&T16000, ` offers three
`MODE_*` values, not 1049 symbols. `MapAxis`'s direction argument offers two. The event
argument of `MapKey` offers events - composition functions, DX buttons, keys, flags and
your own declared events - rather than every control of every device you do not own.

**Layer parameters explained.** `MapKeyIOUMD(&Joystick, TG1, ...)` takes six keys named
`keyIU`, `keyOU`, `keyIM`, `keyOM`, `keyID`, `keyOD`. Signature help says which is
which: Up, Middle (the default) and Down are the main layers, and In/Out is the
sub-layer driven by the `SetShiftButton` button - In while it is held, Out while it is
not.

**USB scancodes by name.** `USB[0x2C]` is Space, `USB[0x18]` is U. Hover says so, and
typing inside `USB[` lists every code by key name. Nothing in `target.tmh` or
`defines.tmh` says what these mean - it only declares `short USB[256]` - so the names
come from the manual's appendix.

**Plain-English control names.** `EFLNORM` is meaningless; "Engine Fuel Flow Left" is
not. Completion and hover describe physical controls using the per-device diagrams
TARGET installs - `APALT` is the Autopilot Select Switch, `CHF` is China Hat forward.

The wording is Thrustmaster's own, copied verbatim from those PDFs, which are laid out
as a caption followed by the script names for the controls it covers. Only the pairing
is inferred, and captions describe a control *group* rather than a single position:
`CHF`, `CHM` and `CHB` all read "China Hat", since that is the one caption the diagram
gives them. Regenerate with `npm run gen`.

**Hover and signature help** for all 171 builtins, with the real parameter lists and
default values - and for your own functions too, including the comment block above
them, looked up across the include graph so a call site shows what a function in
another file is for.

TARGET defines no documentation format - the compiler ignores comments and ships no
doc tooling - so nothing is privileged: whatever you wrote above the declaration is
what you see, be it one line, several, a `/* */` block or something javadoc-shaped.
A blank line between the comment and the declaration is stepped over, since that is
how scripts are usually written, and a banner of dashes or equals signs is treated as
a section divider rather than documentation.

**Outline and go-to-definition**, including across `include` files — large scripts are
split over a dozen headers and Thrustmaster's editor has no navigation at all.

**Diagnostics** for things the TARGET compiler reports poorly or not at all:

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

## Compiling and running

Three commands, from the Command Palette or the editor title bar:

| Command | What it does |
| --- | --- |
| **TARGET: Check Script for Compile Errors** | Compiles without running. Errors land in the Problems panel at the right file and line. |
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

## The DX button ceiling

TARGET replaces your hardware with a virtual controller, and `DX1`..`DXn` are buttons on
it. Two separate limits apply, and they come from different places.

**What TARGET declares: 120 buttons.** Measured, not quoted - a script creating only a
virtual joystick was run and the resulting device's HID capabilities read live:

```
HID\THRUSTMASTERGAMEDEVICE
  usagePage=0x01 usage=0x04 (Joystick)   inputReport=33 bytes
  button caps: page=0x09 usage 1..120    value caps: 9
```

The report length confirms it: 1 report id + 15 bytes of button bits (120) + 8 axes at
16 bits + 1 byte of hat = 33 bytes. The 9 value caps are those 8 axes plus the hat,
matching the eight `DX_*_AXIS` constants exactly.

`defines.tmh` names `DX1..DX128` regardless, so **`DX121`-`DX128` have no button behind
them** and are reported as a warning.

**What the game reads: 32 or 128, the game's choice.** DirectInput defines two joystick
data formats:

| Data format | Structure | Buttons |
| --- | --- | --- |
| `c_dfDIJoystick` | `DIJOYSTATE` | `BYTE rgbButtons[32]` |
| `c_dfDIJoystick2` | `DIJOYSTATE2` | `BYTE rgbButtons[128]` |

So a button between `DX33` and `DX120` exists on the controller but is only seen by a
game reading `DIJOYSTATE2`. Elite Dangerous reads 32. That case is a hint, since it
cannot be judged from the script.

Neither is ever an error: exceeding either limit is silent, never a failure the script
can detect.

A figure of 56 buttons circulates in community documentation. The live measurement above
contradicts it, and no HID descriptor declaring 56 exists anywhere in the installation.
The measurement was taken with no physical devices attached, on TARGET 3.0.25; if the
declared count varies with attached hardware, re-run the check before trusting 120.

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
| `targetScript.bindsFolder` | auto-detect | Folder holding game binding files: Elite Dangerous `.binds`, DCS `.diff.lua`, or Star Citizen ActionMaps `.xml`. |
| `targetScript.diagnostics.unboundKeys` | `false` | Report keys the game's loaded bindings do nothing with. Off by default: the answer depends on which preset is loaded on your machine, so the same project reports differently elsewhere. |

## Where the data comes from

Four generated tables, all from files the TARGET installer puts on disk:

| Table | Source | Contents |
| --- | --- | --- |
| `builtins.json` | `target.tmh`, `defines.tmh`, `hid.tmh`, `sys.tmh` | 171 functions, 851 constants, 38 devices |
| `target.tmLanguage.json` | generated from `builtins.json` | the grammar |
| `device-labels.json` | the per-device PDFs | 58 control descriptions |
| `usb-codes.json` | the scripting manual's appendix | 119 key names |


The builtin tables are **generated from the headers of an installed TARGET**
(`target.tmh`, `defines.tmh`, `hid.tmh`, `sys.tmh`) rather than transcribed from the
PDF manual, which is older than the shipping software and incomplete. The shipped
tables cover 171 functions, 851 constants and 38 devices.

Regenerate them all after a TARGET update:

```bash
npm run gen
```

If TARGET is not in a default location, point the builtin generator at it directly —
`npm run gen -- …` would append the flag to the last script in the chain, which does not
read it:

```bash
node tools/gen-builtins.mjs --scripts "/path/to/Thrustmaster/TARGET/scripts"
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

MIT. "Thrustmaster" and "T.A.R.G.E.T." are trademarks of Guillemot Corporation S.A.,
used here only to say what this extension is for. The extension is not affiliated with
them.
