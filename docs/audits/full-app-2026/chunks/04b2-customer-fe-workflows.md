# Chunk 4b2 — Customer FE Detail-Workflows

**Tiefenstufe:** Pattern-Scan
**Commit:** `3e0d3fb`
**Risiko:** HOCH
**LOC / Files:** 7 543 / 30

## Befunde

- ⚠️ **MITTEL:** Mit 30 Files / 7 543 LOC ist dieser Chunk im Grenzbereich;
  laut Plan §1.2 Phase 1/2/3 strikt separat zu fahren. Für vertieften Audit
  als eigener Folge-Task empfehlen.
- ✅ Custom-Pricing-Audit-Logs sind in `server/routes/admin/customers/`
  pattern-sichtbar (`pricing-audit`-Aufrufe).
- ⚠️ **NIEDRIG:** `dangerouslySetInnerHTML` in `document-preview.tsx`
  (siehe Foundation-Sub-Report) — gehört thematisch hier rein, da
  Template-Preview im Customer-Workflow läuft.

## Empfohlener Folge-Task

`[MITTEL] Customer-FE-Workflows Deep-Audit (Pricing/Docs/Kontakte)` —
eigenes Ticket wegen Größe.
