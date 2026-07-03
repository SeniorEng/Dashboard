---
name: Qonto billing-irrelevant soft-flag
description: Invariants for the "nicht abrechnungsrelevant" flag on Qonto transactions — mutual exclusion with matched, survives re-sync, credit-only.
---

A Qonto transaction can be flagged "nicht abrechnungsrelevant": a soft flag
(nullable timestamp, never deleted, GoBD-audited symmetrically on mark/unmark)
that removes non-invoice income from the open reconciliation list AND the
auto-match feed.

Invariant: a transaction is NEVER both matched to an invoice AND billing-irrelevant.

**Why:** the flag exists to keep non-invoice income out of reconciliation +
auto-match; a matched-and-flagged row would double-count and contradict itself.

**How to apply:**
- Enforce mutual exclusion at the SQL WHERE level in EVERY match write path —
  the manual match route AND the autoMatch service loop. Both guarded UPDATEs
  must carry `isNull(billingIrrelevantAt)` next to `isNull(matchedInvoiceId)`.
  A read-time check alone leaves a TOCTOU window (an admin can flag between
  another session's read and its match-commit).
- The auto-match feed and the "offen/unmatched" list must both exclude flagged rows.
- The flag is credit-only (Zahlungseingänge); marking is rejected for the debit side.
- The flag MUST survive re-sync/CSV import: the transaction upsert deliberately
  does not touch billing_irrelevant_at (nor matched_invoice_id) on update.
