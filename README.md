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
| C keywords TARGET lacks | `for`, `switch`, `continue`, `typedef`, `enum`, `const`, … |

Names borrowed from another device that happen to land on the same index (`TG1` and
`TS1` are both 0) are reported as a naming hint rather than an error, because that code
does work and real scripts rely on it.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `targetScript.installPath` | auto-detect | The TARGET `scripts` folder, used to resolve `include "target.tmh"`. Set this if TARGET is not installed in the default location. |
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
