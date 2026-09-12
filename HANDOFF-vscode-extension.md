# HANDOFF — Build a VS Code extension for the Thrustmaster T.A.R.G.E.T. scripting language

Spec for an agent building this from scratch. Written 2026-09-11.
Greenfield: nothing has been built yet. This document is research + design, not a status report.

> Lives in `.claude/`, which is gitignored via `.claude/.gitignore` containing `*`.
> The extension itself should be a **separate repository**, not built inside
> `ED_TargetScript_T16000`. That tree is a fork of a third-party TARGET script and is
> only useful here as a test corpus.

---

## 1. The opportunity

T.A.R.G.E.T. (Thrustmaster Advanced pRogramming Graphical EdiTor) ships a scripting
language for programming Thrustmaster HOTAS hardware. Scripts are `.tmc` (main),
`.tmh` (headers), `.ttm` (macro files).

**Nothing exists for it.** Searched: VS Code marketplace, Notepad++ UDL list, GitHub.
No grammar, no extension, no language server. The current state of the art in the
community is "use C# or C highlighting, it's close enough" — which is what a French
DCS community guide (lesirreductibles.com) actually recommends, noting that
Thrustmaster's own bundled editor is poor and that people prefer VS Code with
approximate highlighting.

Thrustmaster's own editor (`TARGETScriptEditor.exe`) is barely more than a text box
with Compile and Run buttons. Its compiler errors are terse. So there is real value
in diagnostics (§6), not just coloring.

Audience is small but dedicated: DCS World, Elite Dangerous, MSFS, Star Citizen
simmers with Warthog / T.16000M / TWCS / Cougar hardware.

---

## 2. Authoritative sources

**Primary — read this first, cover to cover.** It is the complete language reference,
60 pages:
`https://ts.thrustmaster.com/download/accessories/pc/hotas/software/TARGET/TARGET_Script_Editor_Basics_v1.5_ENG.pdf`

**Critical shortcut: `target.tmh`.** Every script begins with `include "target.tmh"`.
That header ships with the TARGET install (look under the TARGET program folder, e.g.
`C:\Program Files (x86)\Thrustmaster\TARGET\Scripts\`) and contains the **actual
declarations** for every built-in function, device alias, button name and constant.

**Parse `target.tmh` to generate the builtin tables rather than transcribing the PDF.**
The PDF is v1.5 and incomplete; the header is ground truth for the installed version.
Ship the generator as a script in the repo so the tables can be regenerated when
Thrustmaster updates TARGET.

Per-device button-name PDFs also ship with TARGET (the manual refers to them). Those
give the authoritative button name list per hardware model.

**Secondary:** the DCS forum thread "TARGET - Advanced programming"
(`https://forum.dcs.world/topic/60448-target-advanced-programming/`) covers behavior
beyond the official manual.

**Test corpora:**
- `C:\Thrustmaster\ED_TargetScript_T16000\ScriptFiles\` — 11 files, real-world,
  `ED_Functions.tmh` alone is 64 KB. Exercises nearly every construct.
- `github.com/ClickerNZ/ED_TargetScript-500` (same author, Warthog variant)
- `github.com/cpuwolf/TARGETWarthog`
- Sample scripts bundled with the TARGET install

---

## 3. Language summary

C-like, case sensitive, semicolon-terminated, braces for blocks. Compiles to a DLL.

### Keywords (complete list per the manual)
```
char  byte  short  word  int  alias  float  struct  include
if  else  do  while  return  goto  break
```
**Note what is absent: no `for`, no `switch`, no `continue`.** Do not inherit these
from a C grammar. Flagging `for` as an error is a legitimate diagnostic.

### Operators
```
&  &&  !  *  /  %  +  -  >>  <<  >  <  <=  >=  ==  !=  &  ^  |
```

### Comments
`//` line comments, and `/* */` block comments (confirmed in the corpus).

### Declarations seen in practice
```c
include "target.tmh"                       // no angle brackets, quotes only
define MapKeyProfile FULL                  // object-like macros only, no args observed
alias StatusFile = "C:\\path\\file.json";  // aliases hold strings...
alias MyJoystick;                          // ...or are declared bare and assigned later
int EnableVoice = ENABLED;
short Joystick_Curve[] = { 1, 2, 0, 3, 4 };
char CMDRName;
```

### Two things that will surprise a C parser

**Functions are declared as variables.** To create a reusable event, you declare it
with `int` and assign a construct to it:
```c
int autopilot;                             // declaration
autopilot = SEQ(EXEC("..."), EXEC("..."));  // definition
MapKey(&Throttle, LTB, autopilot);          // use
```
Real function definitions also exist (`int MainKeyMap() { ... }`), so `int name;` and
`int name() {}` are both valid and mean different things.

**Device state is read with array-index syntax on the device alias:**
```c
if(Joystick[TG1]) ActKey(PULSE+KEYON+'a');
if(Throttle[APALT] & Throttle[RDRNRM]) ...
```

### Built-in function families
- **Mapping:** `MapKey`, `MapKeyR`, and the layer variants `MapKeyIO`, `MapKeyUMD`,
  `MapKeyIOUMD`, `MapKeyRIO`, `MapKeyRUMD`, `MapKeyRIOUMD`
- **Axes:** `MapAxis`, `RotateDXAxis`, `SetSCurve`, `SetJCurve`, `SetCustomCurve`,
  `KeyAxis`, `LockAxis`, `TrimDXAxis`, `DXAxis`
- **Setup:** `Init`, `Configure`, `SetShiftButton`, `SetKBRate`, `SetKBLayout`,
  `DefaultMapping`
- **Execution:** `EXEC`, `REXEC`, `DeferCall`, `StopAutoRepeat`, `ActKey`
- **Composition:** `CHAIN`, `SEQ`, `TEMPO`, `D()`, `LOCK`, `LIST`, `AXMAP1`, `AXMAP2`,
  `AXIS`, `X(list, index)`
- **Misc:** `printf`, `system`, `LED`, plus math (`abs`, `sin`, `cos`, `ln`)

### Constant families (highlight distinctly)
- Axis: `DX_X_AXIS`, `DX_Y_AXIS`, `DX_Z_AXIS`, `DX_XROT_AXIS`, `DX_YROT_AXIS`,
  `DX_ZROT_AXIS`, `DX_SLIDER_AXIS`, `DX_THROTTLE_AXIS`, `MOUSE_X_AXIS`, `MOUSE_Y_AXIS`
- Axis options: `AXIS_NORMAL`, `AXIS_REVERSED`, `MAP_ABSOLUTE`, `MAP_RELATIVE`
- DX buttons: `DX1`–`DX32`, `DXHATUP`, `DXHATUPRIGHT`, … `DXHATUPLEFT`
- Event flags: `PULSE+`, `DOWN+`, `UP+`, `KEYON`, `LOCK+`, `RNOSTOP`
- Modifier/special keys: `L_CTL`, `R_CTL`, `L_SHIFT`, `R_SHIFT`, `L_ALT`, `R_ALT`,
  `L_WIN`, `R_WIN`, `ESC`, `F1`–`F12`, `BSP`, `TAB`, `CAPS`, `ENT`, `SPC`, `INS`,
  `HOME`, `PGUP`, `DEL`, `END`, `PGDN`, `UARROW`, `DARROW`, `LARROW`, `RARROW`,
  `NUML`, `KP0`–`KP9`, `KPENT`, `PRNTSCRN`, `SCRLCK`, `BRK`
- USB codes: `USB[0x2C]` — hex literal inside brackets, worth its own scope
- LED: `LED_ONOFF`, `LED_INTENSITY`, `LED_CURRENT`, `LED1`–`LED5`
- Other: `MODE_EXCLUDED`, `KB_ENG`, `KB_FR`, `IOTOGGLE`, `UDTOGGLE`, `SET()`,
  `CURRENT`, `AMAXF`

### Device aliases
`Joystick`, `Throttle` (Warthog), `HCougar`, `T16000`, `T16000L`, `TWCSThrottle`,
`LMFD`, `RMFD`, `TFRPRudder`, `TFRPHARudder`. Referenced as `&Joystick`.

Button names are **per device** — `TG1`/`S1`–`S4`/`H1U` on the Warthog stick,
`TS1`–`TS4`/`B5`–`B16`/`H1U` on the T16000M, `TBTN1`–`TBTN5`/`THAT1U`/`TLOCK` on the
TWCS. **Make this table data-driven, keyed by device**, so completion can be filtered
to the device in the current `&Device` argument. That device-aware completion is the
single highest-value feature for a user — nobody remembers these names.

---

## 4. The hard part: EXEC

`EXEC` takes **TARGET source code inside a string literal**:
```c
MapKey(&Joystick, S4, EXEC("SetSCurve(&Joystick, JOYX, 0,0,0,5,0);"));
```
Multi-line form concatenates adjacent string literals:
```c
MapKey(&Joystick, S4, EXEC(
    "SetSCurve(&Joystick, JOYX, 0, 0, 0 ,5, 0);"
    "SetSCurve(&Joystick, JOYY, 0, 0, 0 ,5, 0);"
));
```
And nesting escapes stack:
```c
MapKey(&Device, S2, EXEC("printf(\" i've just pressed S2 \\xa\");"));
```

**Highlighting inside EXEC strings is the marquee feature** and the thing that most
justifies a dedicated extension over borrowing C#. Implement it as a TextMate
**injection grammar** scoped to the string contents of `EXEC(...)` and `REXEC(...)`,
recursively including the main grammar.

Get basic highlighting shipped first. Nested-escape handling is a rabbit hole; the
single-level case covers the overwhelming majority of real code.

---

## 5. Suggested phases

**Phase 1 — grammar only.** `package.json` contributions for the three extensions,
`language-configuration.json` (comments, brackets, auto-closing), and a TextMate
grammar. Ship it. This alone puts you ahead of everything that exists.

**Phase 2 — static intelligence, no server.** Snippets for the MapKey family and
common scaffolding. Hover docs for builtins, sourced from the manual. Document
symbols so the outline lists `int fnName()` definitions, `define`s and `alias`es —
valuable because real scripts are large and Thrustmaster's editor has no navigation.

**Phase 3 — language server (TypeScript, `vscode-languageclient`).** Go-to-definition
and find-references across `include` files, device-aware completion, signature help,
and the diagnostics below.

**Phase 4 — tasks.** A build task that shells out to the TARGET compiler. The launcher
in the corpus invokes `targetgui -r <script>`; investigate whether a headless
compile-only invocation exists, and parse its output into the Problems panel.

A hand-written tokenizer in TypeScript is adequate. The language is small and the
grammar is mostly C minus features. Tree-sitter is likely overkill, though it would
make `EXEC` re-parsing cleaner if you want to go that route.

---

## 6. Diagnostics worth implementing

These are the payoff. The TARGET compiler reports little and the language has sharp
edges the manual documents but the tooling never checks.

**Documented hard rules:**
- `SEQ`, `CHAIN`, `EXEC`, `TEMPO`, `AXIS` and `LIST` are **forbidden inside `EXEC` or
  `REXEC`**. The manual states this explicitly and gives the workaround (wrap in a
  named function). High-confidence error with a clear fix-it.
- `SetCustomCurve` may not be used inside `EXEC`.
- `AXMAP2` requires the number of zones to equal the number of events.
- `AXMAP1`'s optional center event is silently ignored with an odd zone count, since
  zones are equal divisions and no zone boundary lands on center. Warning.
- DirectX ceiling: 32 buttons, 8 axes, regardless of how many physical devices are
  merged. Warn when a script exceeds it. (This is exactly the limit the Elite
  Dangerous script in the corpus works around by sending keystrokes instead.)
- `REXEC` handle must be 0–99.
- `include "target.tmh"` must be the first line.
- A `CHAIN` with more than ~5 simultaneous keystrokes and no `D()` delays will have
  outputs silently dropped by Windows. Warning with a fix-it inserting `D()`.

**Arity checks** (cheap, catches real mistakes in dense nested calls):
`MapKeyIO` 4 args, `MapKeyUMD` 5, `MapKeyIOUMD` 8, `SetSCurve` 7, `SetJCurve` 4,
`MapAxis` 3 or 5.

**Range checks:** curve parameter -20..20, scale -20..20, deadzones 0-100,
`LED_INTENSITY` 0-255, trim ±1024.

**Name resolution:** unknown button name for the device passed in that call; device
alias used but never `Configure`d or present.

---

## 7. Gotchas

**File encoding.** Real-world TARGET scripts in the wild are often **UTF-16**. Several
files in the test corpus are. VS Code handles this for display, but any Node-side code
that reads files directly (a language server resolving `include`s, or the
`target.tmh` parser) must sniff the BOM and decode accordingly. Getting this wrong
produces silent garbage rather than an error.

**Tabs.** The corpus is heavily tab-indented with alignment tabs inside comment
blocks. Do not ship an opinionated formatter early; you will mangle files people care
about.

**Case sensitivity** is explicit in the manual. Do not offer case-insensitive
completion matching that inserts the wrong case.

**`include` resolution** is relative to the `.tmc` file's folder, per the manual's note
that macro files must live alongside the main file. `target.tmh` itself resolves from
the TARGET install directory — the server will need a configurable setting for that
path, since it varies and may be on a non-default drive.

**Do not invent syntax.** If something is not in `target.tmh` or the manual, leave it
out. Simmers debugging a config at midnight do not need a plausible-looking
autocomplete for a function that does not exist.

---

## 8. Repo conventions for whoever builds this

- New standalone repo, MIT.
- TypeScript, `yo code` scaffold, `vsce` for packaging.
- Generator script that parses `target.tmh` into the builtin JSON tables; commit both
  the generator and its output.
- Grammar test fixtures pulled from the corpora in §2. A snapshot test that tokenizes
  `ED_Functions.tmh` and diffs against a golden file will catch regressions well.
- The user's `C:\Thrustmaster\ED_TargetScript_T16000\` is the handiest local corpus —
  read from it, never write to it.

## 9. User context

Computer engineer; comfortable with TypeScript, C, Python, embedded work. No need to
simplify technical explanations. Strong preference for **fixing root causes over
suppressing symptoms** — do not paper over parser gaps with permissive catch-all
regexes that mis-highlight rather than admitting the construct is unhandled. Prefers
things be looked up and verified rather than asserted from memory.
