---
name: Qonto teilweise_bezahlt lifecycle & unmatch recompute
description: The partial-payment invoice status is fully derived from bound payments; every write path that can leave it must recompute via the SSoT, not hard-code a from-status.
---

# `teilweise_bezahlt` is a fully derived status — recompute, never hard-revert

`teilweise_bezahlt` (invoice partially paid) is NOT a manually settable status. It
exists ONLY as an output of the payment SSoT:
`getInvoicePaymentTotals(invoiceIds, exec)` (Σ of all bound Qonto txs + qonto-backed
avis items, integer-cents) → `resolveInvoicePaymentStatus({invoiceGrossCents, paidCents,
skontoCents})` which layers on `classifyPaymentDifference` (tolerance 100ct):
paid≤0 ⇒ null (leave open) · fully covered ⇒ `bezahlt` · underpaid & paid>0 ⇒
`teilweise_bezahlt` · over-tolerance overpaid ⇒ null (flag mismatch, never silent paid).

**Rule:** any write path that can *leave* an invoice at `teilweise_bezahlt` (or `bezahlt`)
must re-derive the status from the REMAINING bound payments through that same SSoT — it
must not hard-code a single from→to transition.

**Why:** the manual status endpoint / lifecycle graph offers NO path out of
`teilweise_bezahlt` (only →bezahlt/→storniert). The Qonto single-tx unmatch route
originally reverted status only where `status === "bezahlt"`. After the partial-payment
feature, unbinding a partial left the invoice stuck at `teilweise_bezahlt` forever with a
phantom open remainder and no manual exit. A status you can enter but never leave is an
incomplete lifecycle.

**How to apply:** on unmatch (and any future reversal that removes bound money), after
unbinding, read remaining totals via `getInvoicePaymentTotals(..., dbTx)` and decide:
remaining paid ≤ 0 → avis-backed prior status (`resolveAvisBackedStatus` → versendet /
avis_erhalten, paidAt=null); still underpaid → `teilweise_bezahlt` (paidAt=null); still
fully covered / over-tolerance rest → leave unchanged (stays `bezahlt`; overpayment is
flagged separately). Only touch invoices currently in `bezahlt`/`teilweise_bezahlt`;
never downgrade versendet/avis_erhalten/storniert. The Sammel-Avis (advice) unmatch path
does NOT produce `teilweise_bezahlt` (different triple-equality matcher), so it stays
bezahlt-only.
