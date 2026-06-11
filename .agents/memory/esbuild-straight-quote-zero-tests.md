---
name: esbuild straight-quote in test titles = silent 0-test file
description: A stray straight double-quote inside a double-quoted it()/describe() title makes the whole vitest file collect "0 test" via an esbuild transform error, and tsc can disagree.
---

# esbuild/vite rejects inner straight `"` in a `"`-delimited test title → whole file "0 test"

A test title written as `it("... Sentinel „keine ... Aufstockung" → kein Cap ...", () => {`
where the quote after the German word is a STRAIGHT `"` (U+0022) — not the curly
German close `"` (U+201C) — terminates the JS string early. esbuild/vite then fails
the transform (`Expected ")" but found "→"`) and the ENTIRE file reports
`(0 test)` / "no tests" instead of a normal failure.

**Why it bites:** it reads like a flaky/empty file, not a syntax error. And `tsc`
(typecheck workflow) can pass the same file while esbuild/vitest rejects it — so a
green typecheck is NOT proof the test file will collect. Only the orchestrated
`vitest run` (esbuild path) surfaces it.

**How to apply:**
- If a test file shows `(0 test)` / "no tests" with a transform error, scan its
  `it(...)`/`describe(...)` titles for inner straight `"` (and `→`/special chars).
  Quickest fix: rewrite the title with no inner double-quotes (single quotes or
  none); curly German quotes `„ "` U+201E/U+201C are safe inside a `"`-string.
- German low-quote `„` in plain `//` comments is harmless — only string literals
  break.
- Trust the synchronous `vitest run` (esbuild) over a green `tsc` for "does this
  file actually collect tests".
