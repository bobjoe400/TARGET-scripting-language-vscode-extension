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

## manual-docs.json

Function descriptions from `TARGET_SCRIPT_EDITOR_basics.pdf`, twelve of them.

Reading that PDF needed a positional text extractor. Concatenating its text runs in
stream order - the obvious approach - interleaves the columns of a two-column page and
breaks words apart, because a TJ array's numeric elements are kerning adjustments and
treating every one as a space turns "creating" into "cr eating". Of 61 builtins the
manual mentions, that approach produced three usable sentences, all of them corrupt.

`tools/pdf-text.mjs` tracks the text matrix instead, groups runs into lines by their Y
coordinate, orders them by X, and treats only a large negative adjustment as a space. It
also maps the CP1252 punctuation the manual is typeset with back to ASCII - the smart
quotes around a word are invisible in a terminal and enough to fail a comparison.

The extraction is deliberately conservative. A sentence is kept only where the manual
introduces the function by name and follows it with a definition, and it is discarded if
it has run into a code sample, describes a restriction rather than the function, or is
commentary on an example. The generator refuses to write at all if its anchor sentences
do not come out right. A wrong description would be shown as fact, in the editor, beside
the reader's own code.
