---
name: Qonto payment≠gross bind+flag rule
description: Bank-payment→invoice matching must never silently mark an invoice "bezahlt" when paid ≠ gross beyond tolerance; bind + audit-flag instead.
---

# Qonto Zahlung≠Rechnungsbetrag: bind + flag, never silent "bezahlt"

**Rule:** Any bank-payment→invoice matching write path must classify the paid
amount vs. the invoice gross through the ONE SSoT
`shared/domain/qonto/payment-difference.ts` (`classifyPaymentDifference`,
`isPaymentFullyCovered`, tolerance = 100 ct):

- deviation ≤ 100 ct (Skonto/rounding) ⇒ fully covered ⇒ invoice(s) → `bezahlt`.
- deviation > 100 ct ⇒ transaction is still BOUND to the invoice/advice, but the
  invoice is NOT set to `bezahlt`. Instead record an audit-only flag per invoice
  (`invoice_payment_mismatch`) plus `advice_payment_mismatch` at advice level for
  manual review. No status-enum value, no schema/migration change.
- Explicit operator override: `POST /transactions/:id/confirm-paid` (superadmin
  only) records `invoice_payment_difference_accepted` and flips ONLY still-open
  bound invoices (`versendet`/`avis_erhalten`) to `bezahlt`; idempotent no-op if
  already paid.

Gates live in EVERY write path: `autoMatch` (server/services/qonto.ts), manual
`/match`, `/bulk-match`, and `mark-paid` (server/routes/admin/qonto.ts). The
bulk-advice auto-match path is implicitly tighter — it only binds on
triple-equality (payment = advice total = Σ open invoices, ±2 ct), well inside
the 100 ct tolerance, so it needs no separate classifier call.

**Why:** the old behaviour silently booked a full `bezahlt` even when the paid
amount was a partial/over/under payment, corrupting the paid-state and GoBD
audit trail. The flag keeps the money bound (so it isn't re-matched) while
forcing a human decision, and every branch records difference metadata
(differenceCents, result, gross sums, tolerance) so the review trail is complete
and attributable.

**How to apply:** any NEW payment→invoice write path (import, re-book, new
matcher) MUST route through the classifier and gate on `isPaymentFullyCovered`;
over-tolerance ⇒ bind + flag, never `bezahlt`. Tests that assert an invoice
goes `bezahlt` on a mismatched payment are encoding the OLD bug — update them to
assert bind+flag + `confirm-paid`, don't "fix" the gate.

**Sammel-Avis wins over single-invoice bind+flag (disambiguation):** when a
payment names ONE invoice number but its amount does NOT fully cover that single
invoice, `autoMatch` first tries a bulk-advice reconciliation BEFORE falling back
to single-invoice bind+flag. Two guards keep it honest:
- **Containment gate:** only advices whose `openInvoiceIds` actually INCLUDE the
  matched single invoice are candidates. A foreign advice that merely happens to
  total the payment amount must NOT win — otherwise the named invoice would be
  left falsely open. (Capture `bestMatch.invoiceId` into a const first; passing
  `bestMatch.invoiceId` inside the `.filter` closure trips TS narrowing.)
- **Triple-equality:** the candidate advice still binds only on payment = advice
  total = Σ open invoices (±2 ct). If none reconciles, it stays the old
  single-invoice bind+flag (no regression).

**Why:** a Sammelzahlung referencing one member invoice number should settle the
whole Avis, not just flag one invoice as a mismatch. But amount-equality alone is
ambiguous (a different Avis can share the total), so containment is required.

**How to apply:** the disambiguation block sits BEFORE the `#1672` bulk block in
`autoMatch`; it's gated on `!isPaymentFullyCovered(...)` so covered single-invoice
payments are untouched. Tests locking this: `tests/billing/bulk-advice-match.test.ts`
cases (e) advice-wins, (e2) no-regression bind+flag, (e3) foreign-advice-containment.
