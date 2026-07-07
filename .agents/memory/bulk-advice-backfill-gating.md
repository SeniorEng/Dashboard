---
name: Sammel-Avis backfill vs live triple-equality
description: Why the historical backfill verifier uses amount+window+IBAN, not the live triple-equality.
---
The live Sammel-Avis auto-match (SSoT `shared/domain/qonto/bulk-advice-match.ts`)
gates on a TRIPLE equality: abs(TX) ≈ advice.gesamtBetrag ≈ Σ(OPEN invoice gross),
open = status versendet/avis_erhalten only.

The historical backfill (`scripts/verify-advice-backfill.ts`) pairs
ALREADY-FULLY-PAID advices with unmatched credits. For those, every member invoice
is `bezahlt` ⇒ Σ(open) = 0 ⇒ the live triple-equality can never hold. Ships with a
dry-run default AND an `--apply` writer (requires `--user=<superadmin>` +
`--reason=…`≥10 chars).

**Rule:** backfill therefore falls back to a different gate set (per task spec K3):
exact amount (±BULK_ADVICE_TOLERANCE_CENTS) + ±21d window (TX.emittedAt vs advice
zahlungsDatum, fallback latest invoice.paidAt) + receiving-IBAN match. Payer/
Kostenträger name is ADVISORY context only, never a gate (Pflegekassen names too
variable for a safe fuzzy).

**Why:** do NOT "fix" the backfill to reuse satisfiesTripleEquality — it would match
zero fully-paid advices. And do NOT add a name-fuzzy gate — a wrong name-match would
auto-link 25 invoices.

**How to apply:** the `--apply` writer reuses these three gates + a uniqueness
guard (a credit matching >1 advice ⇒ ambiguous ⇒ skipped, no proposal). Per
proposal: one db.transaction, guarded UPDATE on qonto_transactions (isNull
matchedInvoiceId/matchedPaymentAdviceId/billingIrrelevantAt) sets
matchedPaymentAdviceId + matchConfidence=`backfill_bulk_advice`
(BACKFILL_MATCH_CONFIDENCE, distinct from live `auto_bulk_advice` for provenance);
does NOT touch invoices (already `bezahlt`); writes ONE `advice_payment_reconciled`
audit per advice. Idempotent (skips already-linked advices, guarded update hits 0
rows on re-run), XOR-safe (DB partial-unique idx + XOR check constraint back it).
