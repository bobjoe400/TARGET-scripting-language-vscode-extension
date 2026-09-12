# Test fixtures

`ED_*.tmc`, `ED_*.tmh` and `ED_*.ttm` in this folder are copied verbatim from
[ED_Enhanced_T16000](https://github.com/bobjoe400/ED_Enhanced_T16000)
(MIT License, Copyright (c) 2024 Clicker).

They are used as a known-good corpus: roughly 295 KB of real-world TARGET script that
compiles and runs. The test suite relies on that:

- `run-grammar-test.mjs` tokenizes every file and fails if the grammar ever ends a
  file still inside a string or comment.
- `run-diagnostics-test.mjs` fails if any rule reports an error or warning on this
  code, since by definition none of it is broken.

`DEMO.tmc` is not from that project. It is written for this repository and deliberately
contains mistakes, as a place to see the diagnostics working.
