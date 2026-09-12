# Changelog

## 1.0.0

First release on the Marketplace. Everything below shipped during development and is
listed here because the Marketplace shows this file.

### Game bindings, for every game people script for

A TARGET script sends keystrokes and virtual joystick buttons; what they *mean* lives
in the game's own binding files. The extension reads them and tells you.

- **Three formats**: Elite Dangerous `.binds`, DCS World `.diff.lua`, and Star Citizen
  ActionMaps `.xml`. Files are identified by their contents, not their extension - Star
  Citizen exports a plain `.xml` and TrackIR profiles live in the same folders.
- **Virtual buttons as well as keystrokes.** All three games bind the DX buttons a
  script creates, and that is the half a script is actually for. Hovering `DX25` says
  what the game does with it.
- **The preset the game will really load.** Elite records it in `StartPreset.start`;
  without that, a hover was a pile of contradictory answers from presets the game is
  not reading.
- **The aircraft, for DCS.** DCS has no active profile - every module's bindings are
  live at once - so the extension filters by *device* and reports which aircraft each
  binding came from.
- **The TARGET GUI's own association**, where you have set one, settles which game a
  script is for so the other games' files are left out.
- **Show Where This Key Is Bound** (right-click, or the palette) opens a peek with every
  place that key or button is bound, across every game and preset.

### Diagnostics

- **A name nothing declares**, in a `define` value. `L+CTL+USB[0x1E]` compiles cleanly -
  TARGET resolves symbols lazily and never checks - so this is the only thing that can
  catch it. Judged against the whole project, since headers routinely use names their
  includer defined first.
- **Keys the game does nothing with**, off by default as `targetScript.diagnostics.unboundKeys`,
  because the answer depends on which preset is loaded on *your* machine.
- **Modifiers are part of the question.** `L_ALT+USB[0x4F]` and `USB[0x4F]` send
  different things, and a binding needing `L_SHIFT` fires for neither. An unrecognised
  modifier is reported rather than quietly ignored.

### Compiling and running

- **Fixed on Windows.** Staging computed a drive-relative path, so nothing you wrote was
  staged, a scratch tree accumulated outside the temp directory, and every compile
  reported a phantom "File not found" on a script that builds. WSL paths hid it.
- Projects whose headers sit outside the entry script's folder are staged completely,
  and compiling and running now stage identically.
- A launch that cannot start is reported instead of announced, and the compile timeout
  always answers.

### Editing

- **Includes resolve the way `Interpreter.exe` does** - against the entry script's
  folder, not the including file's. The old rule was wrong in both directions.
- Unsaved edits anywhere in the project are saved before a compile, not just those
  beside the entry script.
- Settings are read per-folder in a multi-root workspace.
- Works in a virtual workspace for everything that needs no local files.

## 0.12.0

- **Elite Dangerous bindings.** Hovering a scancode now says what the game does with
  that key: `USB[0x18]` shows "u U" *and* `DeployHardpointToggle (Primary)`. A script
  only sends keystrokes - what they mean lives in the game's `.binds` file and nowhere
  in the script.
- `.binds` files are found beside the script, one level up, and in the workspace root,
  including `BindFiles/` and `Bindings/` subfolders, or set `targetScript.bindsFolder`.
- The lookup is by key, not by name, and deliberately so: of the 200 defines in the
  test corpus only 15 match a game action name - the game calls deploying hardpoints
  `DeployHardpointToggle` while the script calls it `DeployHardpoints` - so matching by
  name would be wrong far more often than right. 99% of the key names in a real binds
  file resolve to a USB code; only `Key_Apps` does not, its code being absent from the
  manual's table.
- Modifiers are carried through, so a Shift+Home binding reads as `L_SHIFT+`.
- Fixed two faults found while building this: the USB table lost `Insert` because
  Break and Pause share code 48 and the shared code desynced the walk, and modifier
  keys were silently dropped because an optional closing tag let the lazy body match
  nothing.

## 0.11.0

- **Default DirectX mappings.** Hover and completion now say which DX button a control
  sends with no script running - `TS1` sends `DX1`, `MSP` sends `DX26` - taken from the
  same per-device diagrams as the descriptions. 94 mappings across the Warthog, Cougar
  and T.16000M. Useful when a script means to preserve a default, or when working out
  what an existing game binding referred to.
- The diagrams use three different layouts, so each is handled and every result is
  checked: a DX number must be 1..128, no control may claim two numbers, and no number
  may be claimed by two controls. Direction-labelled groups are paired by direction
  letter rather than by position, which is self-checking - "Up DX 7" must land on a
  control whose name ends in U. The T.16000M comes out as a complete consecutive run,
  `TS1`=DX1 through `B16`=DX16, with nothing rejected.
- Illustrator metadata that rides along inside these PDFs ("t16000top.psd AI10 ArtUID
  0.000000") is now filtered out of the descriptions; a caption never contains a
  filename or a decimal.

## 0.10.0

- **Arguments now offer only what belongs in them.** Previously every position offered
  all 1049 symbols, so the event argument of `MapKey` suggested `OSB01` and `SOL_B5` -
  controls of devices that were not even in the call.
  - `Configure(&dev, ...)` offers the three `MODE_*` values and nothing else.
  - `MapAxis`'s DirectX axis argument offers the 11 axis constants, its direction
    argument `AXIS_NORMAL`/`AXIS_REVERSED`, its last `MAP_ABSOLUTE`/`MAP_RELATIVE`.
  - `SetKBLayout`, `Init`'s `cfg`, `LED`'s mode and LED number, and the DirectX axis
    arguments of `DXAxis`, `TrimDXAxis`, `LockDXAxis` and `RotateDXAxis` likewise.
  - The event argument of the `MapKey` family and `ActKey` offers events: the
    composition functions, DX buttons, keyboard keys, modifier and event flags, and
    the events your own script declares - roughly 250 instead of 1049.
- `MAP_ABSOLUTE`/`MAP_RELATIVE` are listed explicitly rather than by prefix, because
  `MAP_*` also covers `sys.tmh`'s `MAP_IPTR` and `MAP_THISCALL`, which belong to
  `Map()` and have nothing to do with axes.

## 0.9.0

- **The layer parameters are explained.** The headers name them `keyIU`, `keyOM`,
  `keyID`, which says nothing unless you already know the scheme. Signature help and
  hover now spell it out: the main layers are Up, Middle and Down, "by default, you
  program the Middle layer", and each has an In/Out sub-layer driven by the button
  named in `SetShiftButton` - In meaning that shift button held, Out meaning not held.
  So `keyOM` reads "Out (shift button not held) - Middle layer (the default)".
- `SetShiftButton`'s own six arguments are described too: which device and button
  selects the In sub-layer, which selects Up and Down, and what `IOTOGGLE`/`UDTOGGLE`
  change.

## 0.8.0

- **USB scancodes are named.** Hovering `USB[0x2C]` says "Space"; typing inside
  `USB[` offers all 119 codes by key name, filterable by name as well as by number.
  Neither `target.tmh` nor `defines.tmh` carries this - the header only declares
  `short USB[256]` - so the names come from the manual's appendix. The test corpus
  uses 123 distinct codes across 318 references, which is a lot of opaque hex.
- The table is parsed by walking ascending codes rather than positionally, because the
  PDF scatters spaces through both names and codes ("Up Arro w", "w W 1 A"), and the
  result is checked against known USB HID values (`0x04`=a, `0x28`=Return, `0x2C`=Space,
  `0x3D`=F4) before anything is written. An entry where the walk loses its place is
  dropped rather than recorded wrongly.

## 0.7.1

- Fixed the label on the Warthog engine-operate switches, which read "Throttle Right
  Engine Operate Left / right" - the first two words bled in from a neighbouring
  caption. The extractor now cleans the text before trimming it, because words arrive
  split across the PDF's text runs ("T rim", "AL T") and counting raw tokens cut words
  in half.
- Every label is Thrustmaster's own caption, copied verbatim from the per-device
  diagrams. Only the pairing of caption to control name is inferred.

## 0.7.0

Findings from the official manual, the per-device PDFs and further compiler probing.

**Include rules** - TARGET has no include guards, and none of this is reported before
build time:
- `duplicate-include` - a header reached twice, directly or through a diamond
  (main -> A, main -> B, B -> A), is compiled twice and fails with "Name already
  defined".
- `include-too-deep` - nesting deeper than 8 fails with "Too many include files
  (max = 8)". Measured: a 9-deep chain fails, 40 flat includes are fine.
- `duplicate-symbol` - a name declared in two files of the graph. A `define` may
  legally shadow a declaration, so only define-against-define and
  declaration-against-declaration count.

**Declaration rules**, each confirmed by compiling it:
- function-like macros (`define ADD(a,b)`) are rejected; `define X (1+2)` is fine.
- `return;` without a value is a syntax error.
- `redefines-builtin` - redeclaring a builtin, device alias or constant.
- `statement-at-file-scope` - a bare call outside any function.

**Physical control descriptions.** Completion and hover now describe controls in plain
English, extracted from the per-device PDFs TARGET installs: `EFLNORM` shows as
"Engine Fuel Flow Left", `APALT` as "Autopilot Select Switch", `CHF` as "China Hat".
58 controls across the Warthog and Cougar devices. The T.16000M and MFD diagrams carry
only group headings, so those devices are deliberately left undescribed rather than
filled with noise.

**Corrections:**
- `REXEC` removed from the forbidden-in-EXEC set. The manual enumerates exactly
  "SEQ, CHAIN, EXEC, TEMPO, AXIS, LIST" and shows `EXEC("StopAutoRepeat(4);")` as
  supported, so flagging REXEC asserted a restriction nothing supports.
- `define X (1+2)` was parsed as a call to `X` - and `X` is a real builtin - which drew
  a spurious arity error. The define's value is now skipped properly.

## 0.6.0

- The DX button limits are now measured rather than quoted. A script creating only a
  virtual joystick was run and the resulting device's HID capabilities read live:
  TARGET's virtual controller declares **120 buttons** (`usage 1..120`), a 33-byte
  input report, and 9 value caps - 8 axes plus a hat, matching the eight `DX_*_AXIS`
  constants exactly.
- `DX121`-`DX128` are therefore names with no button behind them, and are now a
  warning: `defines.tmh` declares them but nothing is ever sent.
- `DX33`-`DX120` remain a hint: the button exists, but whether a game reads it depends
  on the DirectInput data format it requests (32 or 128).
- The community figure of 56 is contradicted by the measurement and by the absence of
  any 56-button descriptor in the installation.

## 0.5.2

- The DX button hint now explains the real reason the ceiling is disputed instead of
  reporting that sources disagree. DirectInput defines two joystick data formats and
  the game chooses which it asks for: `c_dfDIJoystick` gives `DIJOYSTATE` with
  `BYTE rgbButtons[32]`, `c_dfDIJoystick2` gives `DIJOYSTATE2` with
  `BYTE rgbButtons[128]`. A button above DX32 reaches a game reading the second and is
  invisible to one reading the first, which is why no single number is correct.
- Both structures carry exactly eight axes (`lX`, `lY`, `lZ`, `lRx`, `lRy`, `lRz` and
  `rglSlider[2]`), matching the eight `DX_*_AXIS` constants in `defines.tmh` exactly.

## 0.5.1

- Notes DX buttons above DX32 as a hint. This was previously dropped on the reasoning
  that `defines.tmh` names DX1..DX128, so the manual's 32-button ceiling no longer
  applied. That reasoning was wrong: naming a constant is not the same as the virtual
  device exposing it. The sources disagree and none can be settled without hardware -
  Thrustmaster's manual (2011) says 32, `defines.tmh` (2024) names 128, and community
  documentation for current TARGET reports 56 on the combined virtual device - so the
  message states the disagreement rather than picking a number, and is a hint rather
  than a warning.
- The 8-axis half of that limit needs no check: `defines.tmh` defines exactly eight
  `DX_*_AXIS` constants, so a ninth cannot be named.

## 0.5.0

- Hover, completion and signature help now show the comment block above a function,
  variable, alias or define you declared, not just its signature - across the whole
  include graph, so a call site shows what the function in another file is for.
- TARGET defines no documentation format: the compiler ignores comments and ships no
  doc tooling. Nothing is privileged as a result - the block above a declaration is
  shown verbatim, whether it is a one-liner, several lines, a `/* */` block or a
  javadoc-looking one. No labels such as `FUNCTION:` or `@param` are parsed.
- A blank line between the block and the declaration is stepped over, which is how
  real scripts are written. A banner of dashes or equals signs ends the search: it
  divides sections rather than documenting what follows.

## 0.4.0

- Flags C syntax the TARGET parser rejects. Every entry was confirmed against the
  real compiler, not inferred from the language's C-like appearance:
  `++`, `--`, all compound assignments (`+=`, `|=`, `<<=`, ...), `||`, the ternary
  `? :`, `#include` / `#define` with a `#`, and `include <angle.h>`.
- `&&` is deliberately not flagged. In TARGET it is address-of-address - `&&tmp`
  appears throughout `target.tmh` - not logical and. `&` and `|` are the logical
  operators.
- Operators are rebuilt from adjacent punctuation only when the characters touch, so
  `a & &b` is not read as `&&`, and comment banners such as `//-----` or `||||||`
  cannot be mistaken for code.

## 0.3.2

- The running indicator now tracks reality. It was a notification carrying a Stop
  button, and a notification with buttons stays until the user dismisses it and
  cannot be closed by the extension, so it went on claiming a script was running
  after it had stopped.
  - Running state now lives in a status bar item, which is hidden as soon as it no
    longer applies. Clicking it stops TARGET.
  - TARGET is polled every three seconds; when it is no longer running the indicator
    clears itself, however TARGET was closed.
  - The launch notification has no buttons, so it fades on its own.

## 0.3.1

- Fixed: running a script stored in the WSL filesystem handed TARGET a
  `\\wsl.localhost\` UNC path, and TARGET failed with "File not found" in its own
  window while the extension reported a successful launch. Run now detects a script
  that is not on a Windows drive and offers to run a copy staged there instead,
  saying plainly that it is a copy. A script already on a Windows drive is run
  directly, unchanged.
- `Interpreter.exe` reads UNC paths perfectly well, so the compile check was never
  affected and still works on scripts anywhere.

## 0.3.0

- Checks the structure a runnable script must have. The TARGET compiler reports only
  syntax errors and resolves every symbol lazily, so all of this compiles cleanly
  today and fails at runtime, or silently does nothing:
  - `missing-main` - no `main()`. TARGET runs `main()`; without it nothing happens.
  - `missing-init` - `main()` never calls `Init()`, so no devices are created.
  - `undefined-event-handler` - the handler passed to `Init()` does not exist.
  - `handler-missing-defaultmapping` - the handler never calls `DefaultMapping()`,
    so mappings and shift layers never take effect.
  - `unknown-function` - a call to a function defined nowhere in the include graph.
- The last two rules need a complete symbol table, so they are skipped when an
  `include` could not be resolved rather than guessing about files that were not read.
- Structural rules apply only to `.tmc` entry scripts, never to headers.

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
