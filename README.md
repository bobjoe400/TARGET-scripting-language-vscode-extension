# T.A.R.G.E.T. Script for VS Code

Language support for the Thrustmaster **T.A.R.G.E.T.** HOTAS scripting language
(`.tmc`, `.tmh`, `.ttm`).

Thrustmaster's bundled editor is little more than a text box with a Compile button,
and nothing else existed for this language — the usual advice was "use C# highlighting,
it's close enough". This gives it real tooling.

> **Unofficial.** A community extension, not made or supported by Thrustmaster /
> Guillemot. Bug reports belong
> [here](https://github.com/bobjoe400/TARGET-scripting-language-vscode-extension/issues).

![Syntax highlighting of a TARGET script](https://raw.githubusercontent.com/bobjoe400/TARGET-scripting-language-vscode-extension/main/images/highlighting.png)

## What you get

**Syntax highlighting**, including the hard part: `EXEC()` and `REXEC()` take TARGET
source code *inside a string literal*, and that code is highlighted as code.

**Device-aware completion.** Nobody remembers whether the button is `TG1`, `TS1` or
`TBTN1`. Type `MapKey(&T16000, ` and you get the T.16000M's controls — only those,
in button order. It follows handles your script binds itself, and axis functions rank
that device's axes first.

**Plain-English control names.** `EFLNORM` is meaningless; "Engine Fuel Flow Left" is
not. Taken from the per-device diagrams TARGET installs.

**USB scancodes by name.** `USB[0x2C]` is Space. Typing inside `USB[` lists every code.

**Hover and signature help** for all 171 builtins with real parameter lists and defaults
— and for your own functions, including the comment above them, looked up across
`include` files. **Outline and go-to-definition** work across them too.

**Diagnostics** for what the TARGET compiler reports poorly or not at all — a missing
`main()`, an event handler that does not exist, a call to a function defined nowhere,
a header included twice, C syntax TARGET lacks. All of those compile cleanly and fail
mid-flight instead. → [the full list and why they matter](https://github.com/bobjoe400/TARGET-scripting-language-vscode-extension/blob/main/docs/diagnostics.md)

![Hovering a key shows what the game binds it to](https://raw.githubusercontent.com/bobjoe400/TARGET-scripting-language-vscode-extension/main/images/bindings-hover.png)

**What the game does with the key.** A script sends keystrokes and virtual buttons; the
game decides what they mean. The extension reads the game's own binding files — Elite
Dangerous `.binds`, DCS World `.diff.lua`, Star Citizen ActionMaps — and tells you.
It answers for the whole chord, narrows to the preset the game will really load, and
right-click → **Show Where This Key Is Bound** peeks every place it is bound.
→ [more](https://github.com/bobjoe400/TARGET-scripting-language-vscode-extension/blob/main/docs/game-bindings.md)

## Compiling and running

| Command | What it does |
| --- | --- |
| **TARGET: Check Script for Compile Errors** | Compiles without running. Errors land in Problems at the right file and line. |
| **TARGET: Run Script** | Compiles, then launches with `TARGETGUI.exe -r`. |
| **TARGET: Stop Running Script** | Closes TARGET. |

The compile check **never runs your script**, so it cannot touch your HOTAS — it asks
`Interpreter.exe` for a function that does not exist, which compiles everything and
stops. Checking a 15-file script takes about 200 ms.

Works on Windows, and from WSL through interop. Run a header and it compiles the `.tmc`
beside it. → [why there is no headless run, and the WSL caveat](https://github.com/bobjoe400/TARGET-scripting-language-vscode-extension/blob/main/docs/game-bindings.md#compiling-and-running-in-detail)

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `targetScript.installPath` | auto-detect | The TARGET `scripts` folder. Set this if TARGET is not in the default location. |
| `targetScript.bindsFolder` | auto-detect | Folder holding your game's binding files. |
| `targetScript.diagnostics.enable` | `true` | Turn diagnostics off entirely. |
| `targetScript.diagnostics.unboundKeys` | `false` | Report keys the game's loaded bindings do nothing with. Off by default: the answer depends on which preset is loaded on your machine. |

## More

- [Diagnostics in full](https://github.com/bobjoe400/TARGET-scripting-language-vscode-extension/blob/main/docs/diagnostics.md) — every check, and why the structural ones exist
- [Game bindings](https://github.com/bobjoe400/TARGET-scripting-language-vscode-extension/blob/main/docs/game-bindings.md) — which files, how they are found, compiling in detail
- [Is this C?](https://github.com/bobjoe400/TARGET-scripting-language-vscode-extension/blob/main/docs/not-quite-c.md) — what TARGET has and lacks, checked against the compiler
- [The DX button ceiling](https://github.com/bobjoe400/TARGET-scripting-language-vscode-extension/blob/main/docs/dx-buttons.md) — why `DX121`+ warn, measured from the device
- [Where the data comes from](https://github.com/bobjoe400/TARGET-scripting-language-vscode-extension/blob/main/docs/data-sources.md) — the generated tables and how to rebuild them
- [Development](https://github.com/bobjoe400/TARGET-scripting-language-vscode-extension/blob/main/docs/development.md)

## Acknowledgements

Validated against
[ED_Enhanced_T16000](https://github.com/bobjoe400/ED_Enhanced_T16000), a large
real-world Elite Dangerous TARGET script.

## License

MIT. "Thrustmaster" and "T.A.R.G.E.T." are trademarks of Guillemot Corporation S.A.,
used here only to say what this extension is for. The extension is not affiliated with
them.
