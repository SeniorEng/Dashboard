# Chunk 8 — Billing & Invoicing

**Tiefenstufe:** Pattern-Scan (eigenes Coverage-Gate vorhanden)
**Commit:** `3e0d3fb`
**Risiko:** HOCH
**LOC / Files:** 7 194 / 13

## Befunde

- ✅ `script/coverage-billing.ts` erzwingt Lines ≥ 55 % / Branches ≥ 45 %
  auf `server/routes/billing.ts`.
- ✅ `tests/billing/billing-flow.test.ts` 27 Tests + Concurrency-Tests
  (`invoice-number-concurrency.test.ts`) decken Happy-Path, Storno,
  Nachberechnung, ZUGFeRD.
- ⚠️ **MITTEL:** `server/routes/billing.ts:6` hat 6 `console`-Aufrufe →
  Logger-Pattern-Verstoß. Code-Quality-Cleanup.
- ⚠️ **HOCH:** Qonto-Webhook-Signaturprüfung — nicht pattern-scanbar (Code
  vermutlich in `webhook.ts` / `qonto`-Service); vertiefter Audit empfohlen.
- ⚠️ **MITTEL:** ZUGFeRD-PDF-Validator-Pass auf Test-Stichprobe
  (Stop-Kriterium) nicht in CI verankert.

## Empfohlener Folge-Task

`[HOCH] Billing Deep-Audit (Qonto-Webhook-Sig + ZUGFeRD-Validator-CI)`.
