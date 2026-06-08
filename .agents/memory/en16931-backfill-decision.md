---
name: EN 16931 historical-invoice backfill decision
description: Why old BASIC-profile invoices are NOT re-sealed to en16931, and the only GoBD-clean path if it were ever required.
---

# Historical invoices are NOT force-upgraded to the en16931 profile

**Decision:** sealed pre-#1073 invoices keep their BASIC ZUGFeRD/Factur-X XML. No in-place re-seal script is built.

**Why:**
- ZUGFeRD/Factur-X **BASIC is already a conformant EN 16931 subset** (only MINIMUM/BASIC WL are non-conformant booking aids). en16931 (COMFORT) just adds *optional* fields — not "more compliant". So there is no compliance gap to close.
- `pdf_hash`/`zugferd_xml`/`render_snapshot` are GoBD-sealed (BEFORE-triggers). A re-seal mutates them → GoBD violation; and a re-render of pre-#1047 estate never reproduces the sealed hash byte-for-byte anyway (lost wall-clock/XMP timestamps), which is exactly why the existing correction scripts *flag* rather than overwrite.
- Render pipeline deliberately re-renders snapshots without `profile` as `basic` for byte-stability; a backfill would break that.

**How to apply:** If a future legal mandate ever requires an EN-16931 field that BASIC structurally lacks, the GoBD-clean path is **storno + reissue** (cancel old, issue new numbered en16931 doc), NOT silent re-seal. A forced in-place re-seal would only be a last resort and must mirror `regenerate-clobbered-invoice-pdfs.ts`/`restore-legacy-invoice-pdfs-from-backup.ts` (dry-run default, --apply + superadmin + --reason, own append-only audit action, atomic pdf+xml+hash+snapshot.profile write, `SET LOCAL app.allow_gobd_mutation='on'`). Intentionally not built.

Decision doc: `docs/architecture/budget.md` → "Bestandsrechnungen-Backfill auf EN 16931 — Entscheidung".
