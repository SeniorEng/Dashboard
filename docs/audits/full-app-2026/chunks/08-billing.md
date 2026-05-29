# Chunk 8 — Billing & Invoicing (Deep-Audit, Refresh #822)

**Commit:** `178b2574` · **Stand:** 2026-05-29 · **Tiefe:** Deep
**Skills:** Database · Business-Logic · Security · Performance

## Befunde

### MITTEL-1 — getInvoice JOIN-Alias-Falle
- `server/storage/billing-storage.ts:40` — `getInvoice` liefert `customers.name` als
  `customerName` und überschreibt damit den GoBD-Snapshot `invoices.customer_name`.
  Verifier/Re-Render, die roh aus `invoicesTable` selektieren, driften. Fix: `customerName`
  aus dem Mapping entfernen, Snapshot bevorzugen. Effort S.

### MITTEL-2 — updateInvoiceStatus ohne Tx-Kontext
- `server/storage/billing-storage.ts:111` — nutzt `db` direkt statt eines `DbOrTx`-Parameters
  → bricht Atomizität, wenn aus einem Batch aufgerufen. Fix: `DbOrTx`-Param, Default `db`. Effort S.

### NIEDRIG — Route-Größe
- `server/routes/billing.ts` = 3656 LOC (war 2131). Refactor → `billing-service.ts` (siehe REPORT §6). Effort L.
- Inkonsistente `console.*`-Nutzung statt zentralem `log`.

## Positive Confirmations
- **Per-Pot-Split (Task #759):** Σ-Invariante via `shared/domain/budget-invoice-split.ts`
  (Largest-Remainder, deterministischer `POT_ORDER`-Tiebreak); Cascade-Storno atomar in
  einem `withAudit`-Tx; Geschwister via `billing_run_id` verbunden.
- **km-Quantisierung (Task #561):** `quantizeKm`/`computeKmLineTotalCents` durchgängig →
  `Menge × Satz == Summe` im PDF.
- **GoBD-Immutability der Rechnung:** `persistInvoicePdf` überschreibt kein bestehendes
  `pdf_path`/`zugferd_xml`; Storno = neue Stornorechnung mit negativen Beträgen.
- **Qonto:** Secret `encryptedText`; `autoMatch` mit Row-Guards gegen Doppel-Match.
- **ZUGFeRD:** `validateZugferd` strukturell, Send-Pfad `strict:true`, Byte-Repro-Tests.
- **PDF-Resilienz:** Concurrency-Semaphore (`PDF_RENDER_CONCURRENCY`), Background-Persist via `setImmediate`.
