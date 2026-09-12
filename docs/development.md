# Development

Building, testing and regenerating the data tables.

*Part of the [T.A.R.G.E.T. Script](https://marketplace.visualstudio.com/items?itemName=bobjoe400.tm-target-script) VS Code extension. Back to the [README](../README.md).*

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

## Installing your build into Windows VS Code from WSL

```bash
npm run install:local
```

The script copies the package onto a Windows drive before installing it, which is not
optional: VS Code on Windows refuses to read a `.vsix` over a `\\wsl.localhost\` path -
*"UNC host 'wsl.localhost' access is not allowed"* - the same restriction TARGET has
with scripts, and the reason the Run command stages a copy.

Set `WIN_USER` if your Windows username differs from the one `%USERNAME%` reports.

A version installed from a `.vsix` does not auto-update. VS Code only replaces it when
the Marketplace has a **higher** version, so a local build that is ahead of the
published one stays put until the Marketplace catches up.
