# What the game does with the key

A TARGET script sends keystrokes and virtual buttons; the game decides what they mean. That mapping lives only in the game's own binding files, and the extension reads them.

*Part of the [T.A.R.G.E.T. Script](https://marketplace.visualstudio.com/items?itemName=bobjoe400.tm-target-script) VS Code extension. Back to the [README](../README.md).*

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

## Compiling and running, in detail

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
