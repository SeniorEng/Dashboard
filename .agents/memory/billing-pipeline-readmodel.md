---
name: Billing pipeline read-model SSoT
description: The Abrechnung pipeline-board reader and the trap of cross-checking it against revenue-stats "planned".
---

# Billing pipeline read-model (Abrechnung board)

The Abrechnung page is a status-oriented pipeline board over the full monthly
lifecycle (Offen → Dokumentiert → Unterschrieben → Rechnung erstellt → Versendet
→ Avis erhalten → Bezahlt). Its read-model is a composed SSoT:

- Pure stage/side/aging assignment lives ONLY in `shared/domain/billing-pipeline.ts`
  (total + disjoint per atomic unit; arch-guarded by
  `tests/architecture/billing-pipeline-stage-identity.test.ts`).
- The server reader (`server/storage/billing/pipeline-reader.ts`,
  `readBillingPipeline`) COMPOSES existing SSoTs — it does NOT re-derive them:
  per-appointment revenue uses the IDENTICAL `prices`/`unit_type='hours'` formula
  as the revenue statistics, "documented & signed" uses
  `documentedAndSignedSqlRaw`, invoices come from `getInvoices`.

**Hybrid break-line (the key €-conservation rule):** while an appointment is NOT
yet invoiced its € lives on the appointment card (early stages); once it is
invoiced via a non-storn- invoice it leaves the appointment stages
(`excluded: invoiced`) and its € lives on the invoice card (late stages). That is
how every € is counted exactly once. Money basis is NET integer-cents on both
sides (Pflegekasse pots are USt-exempt ⇒ net == gross).

## Trap: revenue funnel "planned" status filter
The revenue funnel (`computeStages` in `server/storage/statistics/revenue.ts`)
sums `planned` over `status IN ('scheduled','completed','documented')`. There is
NO `documented` appointment status — the real in-progress status is
`documenting`, which is therefore SILENTLY EXCLUDED from `planned`. The pipeline
maps `documenting` → "Offen" (a stage). So a cross-SSoT €-conservation test
between pipeline stage-total and revenue `planned` only holds on a fixture with
NO `documenting` (and no invoiced/cancelled/no-show) appointments. Robust
approach: compare per-customer (`revenue.byCustomer[].planned` vs the customer's
"Offen" card) on scheduled-only appointments.

## Phase-1 scope limits (deferred)
- `expired_unsigned` side-state is in the pure layer but the reader does NOT yet
  derive it (needs the month-close readiness SSoT) → undocumented completed appts
  in a closed month still show as "Dokumentiert".
- Post-avis aging has no anchor: there is no `avisErhaltenAm`/avis-received
  timestamp column on `invoices` (only the `avis_erhalten` status), so the reader
  uses pre-avis (sentAt) aging for both versendet and avis stages.
- No caching (deliberate, to avoid the cross-process company-settings-style cache
  traps); the endpoint is `GET /api/billing/pipeline?year&month&date`.
