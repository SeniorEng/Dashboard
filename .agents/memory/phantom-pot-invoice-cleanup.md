---
name: Phantom-pot invoice cleanup storno
description: Why cleaning up an already-issued phantom-pot invoice must be a document-only storno, never a per-appointment budget reversal.
---

# Phantom-pot invoice cleanup (already-issued superfluous pot invoices)

A "phantom-pot invoice" is an issued pot-specific invoice (`invoices.budget_type` set)
whose pot is, for the invoice's appointments, net-zero because ALL its consumption
`budget_transactions` were reversed (linked OR note-based orphan storno). The classic
case: a §45a split invoice survives while the §45b sibling stays live.

## Detection SSoT
`isPotEntirelyReversed(consumptions, reversals, potKey)` in
`shared/domain/budget-invoice-split.ts` — reuses `collectReversedConsumptionIds`
(the same reversed-id set used by the live `buildBudgetSplitFromLedger`). Returns
true only if the pot HAD consumption and none of it is live. Never-consumed pots
return false (real Selbstzahler/legacy, nothing to clean).

## Storno must be DOCUMENT-ONLY — do NOT re-reverse by appointment
**Why:** the canonical `PATCH /api/billing/:id/status` cascade-storno reverses ALL
consumption for the invoice's appointments. For a phantom-pot invoice those
appointments are SHARED with the live §45b sibling, so reversing by appointment
would wrongly credit back the live §45b consumption and turn the sibling phantom too.
**How to apply:** for a phantom-pot invoice the ledger is ALREADY correct (that's
why it's phantom). Cleanup is purely document-level: create a negated stornorechnung
+ set original to `storniert` + audit `invoice_cancelled`. Touch NO budget_transactions.
Single-invoice only — never cascade onto sibling pot invoices.

Implementation: `server/scripts/reconcile-phantom-pot-invoices.ts` (dry-run default;
`--apply` needs `--user=<superadmin-id>` + `--reason` ≥10 chars; reuses the granular
billing-storage Tx helpers inside `withAudit`). Task #1012 already blocks NEW such
invoices; this cleans existing ones.
