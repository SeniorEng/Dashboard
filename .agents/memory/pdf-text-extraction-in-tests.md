---
name: PDF text extraction in route tests
description: How to extract text from final invoice/LN PDF bytes returned by real HTTP billing routes in vitest.
---

# Extracting text from invoice/LN PDF bytes in tests

When a route-level test drives the real billing routes and must assert on the
*rendered* PDF text (e.g. that the Leistungsnachweis shows the patient master
address, not the Pflegekasse address):

- `pdf-parse` (devDependency) bundles an OLD pdf.js (v1.10.100) that CANNOT read
  the object-stream PDFs produced by `pdf-lib`'s default `save()` — it throws
  `Invalid PDF structure` / `Unknown compression method in flate stream`. The
  `bundle` and `bulk-print` routes return pdf-lib-MERGED bytes, so a naive
  `pdf-parse(bytes)` fails on exactly those routes.
- **Fix:** normalize first — `PDFDocument.load(buf)` then
  `save({ useObjectStreams: false })`, and feed THAT buffer to pdf-parse. This
  rewrites a classic xref table that old pdf.js reads; text streams are
  unchanged. Works for both Chromium-rendered and pdf-lib-merged PDFs.
- Import pdf-parse via the subpath `pdf-parse/lib/pdf-parse.js` to skip the demo
  code in its `index.js`.

**Why:** the project renders LN/invoice pages with Puppeteer/Chromium but merges
multi-page bundles with pdf-lib; the extractor must survive both.

**LN address layout (server/lib/pdf-generator.ts, generateLeistungsnachweisHtml
from ~line 545):** "Leistungsempfänger/in" renders `customerAddress` (the master
address); the Kasse appears only as `insuranceProviderName` (NAME + IK), never as
its street/`recipientAddress`. So a negative assertion "LN has no Kasse street/
city" is valid, but do NOT assert the Kasse NAME is absent. The Kasse
`recipientAddress` appears only in the INVOICE header, not the LN page.
