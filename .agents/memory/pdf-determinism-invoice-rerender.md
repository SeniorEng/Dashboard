---
name: PDF determinism for byte-stable invoice/LN re-render
description: How invoice/Leistungsnachweis PDFs are made byte-reproducible so a re-render from render_snapshot reproduces the sealed pdf_hash.
---

# Byte-reproducible invoice/LN PDFs

Embedded invoice/LN PDFs are NOT byte-stable by default: three sources write
wall-clock timestamps or random/counter IDs, so a re-render from the sealed
`render_snapshot` never reproduced the sealed `pdf_hash` →
`regenerate-clobbered-invoice-pdfs.ts` flagged everything instead of repairing.

## The fix (the rule)
Freeze the creation instant ONCE at first persist and seal it in the snapshot
(`InvoiceRenderSnapshot.pdfCreationDate`). All re-render paths (integrity
verifier, clobbered-PDF restore) reuse exactly that value. Invoice + LN share
one frozen value so they reproduce together.

**Why:** GoBD requires the sealed artifact to be reproducible from the snapshot
without ever mutating `pdf_hash`/`zugferd_xml`/`render_snapshot` content.

## How the non-determinism is killed (all length-preserving)
- `server/lib/pdf-determinism.ts` `normalizePdfDeterminism()` — latin1 byte-patch
  of `/CreationDate`/`/ModDate` (14 digits), XMP 24-char millis-ISO
  (`xmp:CreateDate|ModifyDate|MetadataDate|rdf:li`), and `/ID [<a> <b>]`
  (deterministic `sha256(idSeed:slot)`, equal length so XRef-stream offsets stay
  put). idSeed = invoice number.
- Chromium `page.pdf({ tagged: false })` removes StructElem `/ID (nodeNNNN)`
  counters (these also get carried, compressed, into node-zugferd ObjStm where
  they can't be byte-patched). PDF/A-3b needs no tagging.
- node-zugferd Info-dict dates live compressed in an ObjStm (not byte-patchable),
  so `embedZugferdXml(..., { creationDate })` passes createDate/modifyDate into
  node-zugferd's embed metadata to freeze them at the source.

## Key facts
- pdf-lib merge (customer/Beihilfe path) is NOT deterministic on its own: a FRESH
  `PDFDocument.create()` + `save()` stamps Info `/CreationDate`+`/ModDate` with the
  wall-clock (`new Date()`). With default `useObjectStreams:true` those dates land
  COMPRESSED in an ObjStm → invisible to `normalizePdfDeterminism`'s plaintext
  regex → the merge byte-drifts run-to-run (single-byte diff in a compressed
  stream). Fix: call `merged.setCreationDate(frozen)` +
  `merged.setModificationDate(frozen)` with the snapshot `pdfCreationDate` BEFORE
  `save()`. copyPages does NOT copy doc-level `/ID`, XMP, or the source Info dates,
  so the merged doc's OWN Info dates are the only drift source — freezing them is
  sufficient (no post-merge re-normalize, which couldn't reach the compressed
  tokens anyway).
- node-zugferd uses an XRef STREAM (no `trailer` keyword); `/ID` is 64-hex inside
  it.
- The send path (`loadOrRenderSendablePdfs`) is intentionally left unnormalized;
  its background persist runs through the normalized path anyway.
- Pre-fix invoices (wall-clock era, no `pdfCreationDate` in snapshot) still flag
  on restore — accepted by design.

## How to apply
Any NEW invoice/LN render or persist path must thread `pdfCreationDate` (frozen
from snapshot when present, else `new Date().toISOString()` once) into both
`embedZugferdXml` and `normalizePdfDeterminism`, and seal it in the snapshot on
first persist. The clobbered-restore script needs no changes — it just re-renders
via the verifier path and compares hashes.
