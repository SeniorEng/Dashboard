# Chunk 5a — Appointments-Backend + Import/Export (Deep-Audit, Refresh #822)

**Commit:** `178b2574` · **Stand:** 2026-05-29 · **Tiefe:** Deep (Import/Export-Teil)
**Skills:** Business-Logic · Error-Handling · Security · Performance

> Hinweis: Die Appointment-km-Rebook-on-Edit-Regression ist als KRITISCH-1 in
> `chunks/07-budget-ledger.md` geführt (Budget-Ledger-Pfad), betrifft aber den
> Appointment-`PATCH`-Endpunkt mit.

## Befunde Import/Export

### HOCH-1 — Bulk-Reconcile nicht atomar
- `server/services/appointment-import-reconcile.ts:405` — Stornierung im Bulk-Reconcile
  wrappt **jede** Zeile in eine eigene Transaktion innerhalb der Schleife. Mid-Batch-Fehler
  hinterlässt teil-reconcilierten Zustand. Fix: eine Transaktion über den Batch (oder
  Saga/Resume mit Idempotenz-Marker). Effort M. → T-822-IMPORT-01

### MITTEL-1 — Excel Formula-Injection-Härtung
- `server/services/appointment-import.ts:146` — `ExcelJS.xlsx.load` ohne explizites
  Formula-Disabling; `unwrapCellValue` behandelt `result`, aber Härtung empfohlen. Effort S.

### MITTEL-2 — Lexware-Export N+1
- `server/routes/admin/lexware-export.ts` — pro Mitarbeiter Einzel-Fetch der Monatsdatensätze. Effort M.

### NIEDRIG-1 — Duplizierte Date-Helper
- `appointment-import.ts:90` — `excelDateToISO` vs `dateToISO` redundant.

### NIEDRIG-2 — Dead-Code
- `appointment-import-reconcile.ts:459` — `__testing`-Export im Prod-Pfad.

## Positive Confirmations
- `parseGermanDecimal` für „Stunden"/„Kilometer" → kein stilles GoBD-Rounding.
- SHA-256-File-Hash (`import-batches.ts:29`) verhindert Doppelverarbeitung derselben Datei.
- EDIFACT-Pflegekassen-Import: `latin1` (DE-Standard) — NIEDRIG-Hinweis BOM/Header-Check.
