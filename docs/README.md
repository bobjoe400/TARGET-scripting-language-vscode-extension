# How it works

Notes on the internals. None of this is needed to use the extension — the
[README](../README.md) covers that.

Most of it exists because a fact had to be established before it could be relied on,
and the working out is worth keeping next to the conclusion.

| | |
| --- | --- |
| [Diagnostics](diagnostics.md) | Every check, and why the structural ones exist — TARGET's compiler reports only syntax errors and resolves symbols lazily, so a script with no `main()` compiles perfectly and fails mid-flight. |
| [Game bindings](game-bindings.md) | Which files each game uses, how the right one is found, and why compiling stages a scratch directory. |
| [Is this C?](not-quite-c.md) | What TARGET has and lacks, each item checked against the real compiler rather than assumed. |
| [The DX button ceiling](dx-buttons.md) | Why `DX121`+ warn. Measured from the virtual device's HID descriptor, not quoted from the manual — which is wrong about it. |
| [Where the data comes from](data-sources.md) | The four generated tables, their sources, and how to rebuild them after a TARGET update. |
| [Development](development.md) | Building, testing, and running the extension from source. |
