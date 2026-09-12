# Where the data comes from

Every table the extension ships is generated from files the TARGET installer puts on disk - never transcribed from the manual, which is older than the shipping software and incomplete.

*Part of the [T.A.R.G.E.T. Script](https://marketplace.visualstudio.com/items?itemName=bobjoe400.tm-target-script) VS Code extension. Back to the [README](../README.md).*

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
