---
name: Cascade storno points every stornorechnung at the root invoice
description: Test-authoring trap — multi-pot billing_run_id cascade storno sets stornierteRechnungId=rootInvoiceId on ALL sibling stornorechnungen, not per-original.
---

# Cascade storno: stornierteRechnungId = root, not per-original

When `stornoInvoiceCascade` (server/services/invoice-storno.ts) reverses a
multi-pot split billing run, it creates one stornorechnung per original invoice
(main storno + one per `billing_run_id` sibling). BUT the `performStorno`
closure hardcodes `stornierteRechnungId: rootInvoiceId` for **every** one of
them — so all stornorechnungen point back at the *root* original, never at their
own sibling.

**Why:** the reversal is modeled as one logical cascade rooted at the invoice
that was directly targeted; siblings are collateral. Each original still gets
`status='storniert'` via `updateInvoiceStatusTx`, but only the root is
referenced by `stornierteRechnungId`.

**How to apply:** in tests, do NOT assert "exactly 1 stornorechnung per original"
by querying `stornierteRechnungId == thatOriginalId` — the root returns N, every
sibling returns 0. Count over the root instead: `stornierteRechnungId ==
summary.stornoedInvoiceIds[0]` yields the full set (== number of originals in the
run). Prove completeness via status='storniert' on every sibling + the summed
negated `grossAmountCents` == −Σ(originals). Stornorechnungen carry NO
`billingRunId` (stornoData omits it), so you can't group them by run id.
