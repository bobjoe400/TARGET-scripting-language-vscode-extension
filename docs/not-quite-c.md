# Is this C?

No. It is a small C-flavoured interpreted language, and the resemblance runs out fast. Everything below was checked against the real TARGET compiler.

*Part of the [T.A.R.G.E.T. Script](https://marketplace.visualstudio.com/items?itemName=bobjoe400.tm-target-script) VS Code extension. Back to the [README](../README.md).*

No. It is a small C-flavoured interpreted language, and the resemblance runs out fast.
The following were all checked against the real TARGET compiler:

| Not supported | Write instead |
| --- | --- |
| `for`, `switch` / `case`, `continue` | `while`, `do ... while`, `if` / `else` |
| `++`, `--` | `i = i + 1` |
| `+=`, `-=`, `*=`, `/=`, `&=`, `\|=`, `<<=`, … | `x = x + y` |
| `\|\|` | `\|` (TARGET's logical or) |
| ternary `? :` | `if` / `else` |
| pointers (`int *p`) | `alias`, TARGET's reference type |
| `typedef`, `enum`, `const`, `unsigned` | `define` |
| `#include`, `#define` | `include`, `define` - no `#` |
| `include <stdint.h>` | there is no C standard library |
| `sizeof x` | `sizeof(&x)` - a function, not an operator |

What it does have that C does not: `alias` (a reference type), `byte` and `word`,
default parameter values (`int Key(int c, int delay=0)`), `Dim()` for sizing arrays at
runtime, and lazy symbol resolution - a call to a function that does not exist compiles
cleanly and fails only when it runs.

`&&` is worth singling out. It is **not** logical and: it is address-of-address, used
throughout `target.tmh` as `&&tmp`. `&` and `|` serve as the logical operators. The
extension does not flag `&&` for that reason.

Every item above is reported as an error with the TARGET equivalent, so reaching for
C out of habit tells you immediately rather than at runtime.
