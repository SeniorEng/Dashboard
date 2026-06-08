---
name: Invoice/LN PDF byte-instability vs sealed pdf_hash
description: Why re-rendering an invoice/LN PDF does NOT reproduce the stored pdf_hash, and what that means for any restore/verify routine.
---

Embedded invoice/Leistungsnachweis PDFs are **NOT byte-stable**: Puppeteer writes a
wall-clock `CreationDate`/`ModDate` into the PDF and the ZUGFeRD/PDF-A-3 embed sets
an XMP creation time. A fresh re-render therefore almost never reproduces the
originally-persisted `pdf_hash` byte-for-byte, even from the sealed `render_snapshot`.

**Why it matters:** `invoice-integrity-verifier.ts` deliberately compares only the
deterministic ZUGFeRD-XML (re-render → parse → bit-compare against `zugferd_xml`)
and the persisted bucket-hash against `pdf_hash` — it never compares a fresh
re-render-hash against `pdf_hash`. Any new tool that re-renders and gates on
"re-render hash == pdf_hash" will FLAG nearly everything and repair almost nothing.
That strict gate is the *required* GoBD safety property (never silently replace a
sealed document with a differing re-render), so do NOT weaken it.

**How to apply:** A restore-from-snapshot routine (e.g. the Task #1043 clobbered-PDF
restore, `server/scripts/regenerate-clobbered-invoice-pdfs.ts`) will, in production,
mostly produce `flagged` outcomes for manual review rather than `repaired`. That is
expected and correct, not a bug. To actually enable auto-repair you must first make
PDF rendering byte-deterministic (freeze Puppeteer creation timestamps + ZUGFeRD XMP
creation time). Test repair/restore paths by INJECTING the renderer (return known
bytes), since real Chromium output is non-deterministic.
