---
name: PDF test introspection (text vs. geometry)
description: How to assert on Chromium-rendered invoice/LN PDFs in tests — when raw content-stream parsing works and when it doesn't.
---

# Asserting on Chromium-rendered PDFs in tests

Chromium subsets embedded fonts, so the glyph-show operators in a content stream
contain **glyph IDs, not readable ASCII**. Inflating the `stream`/`endstream`
blocks and regex-scanning the `(...)` show strings for words like "Uhrzeit"
returns **0** — the letters simply aren't there in literal form.

**To assert on rendered TEXT** (e.g. "header repeats on each page"): extract via
`pdf-parse` (`pdf-parse/lib/pdf-parse.js`), which uses pdf.js and resolves the
ToUnicode CMaps. Normalize first with pdf-lib `save({ useObjectStreams: false })`
so the old bundled pdf.js can read the xref. Counting occurrences of a
header-only keyword in the full text == number of pages the header repeats on.

**To assert on GEOMETRY / margins** (e.g. "content box shrinks by the margin
ratio"): raw content-stream parsing DOES work, because rectangle fills are
literal `x y w h re` operators (not font-encoded). Inject a full-bleed black
background, render at zero-margin vs. configured-margin, find the largest `re`
rect, compare the ratio. This `findLargestRect` helper **depends on the `zlib`
import** to inflate Flate streams — if `zlib` is removed it silently falls back
to raw bytes, finds no rect, and returns `{w:0,h:0}` ⇒ tests fail with `NaN`,
not a clear error.

**Why:** wasted a cycle assuming content-stream regex could verify repeated
table headers; it can't (subset fonts). Also broke margin tests by deleting a
"now-unused" zlib import that `findLargestRect` actually needs.

**Gotcha (template literals):** the PDF HTML templates in
`server/lib/pdf-generator.ts` are JS backtick strings. A backtick inside a CSS
**comment** (e.g. `` `table-header-group` ``) terminates the template literal and
produces baffling `tsc` errors deep in the "CSS". Never put backticks in CSS
comments there.
