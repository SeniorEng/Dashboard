---
name: Sammel-Avis backfill vs live triple-equality
description: Why the historical backfill verifier uses amount+window+IBAN, not the live triple-equality.
---
The live Sammel-Avis auto-match (SSoT `shared/domain/qonto/bulk-advice-match.ts`)
gates on a TRIPLE equality: abs(TX) ≈ advice.gesamtBetrag ≈ Σ(OPEN invoice gross),
open = status versendet/avis_erhalten only.

The historical backfill (`scripts/verify-advice-backfill.ts`, dry-run only) pairs
ALREADY-FULLY-PAID advices with unmatched credits. For those, every member invoice
is `bezahlt` ⇒ Σ(open) = 0 ⇒ the live triple-equality can never hold.

**Rule:** backfill therefore falls back to a different gate set (per task spec K3):
exact amount (±BULK_ADVICE_TOLERANCE_CENTS) + ±21d window (TX.emittedAt vs advice
zahlungsDatum, fallback latest invoice.paidAt) + receiving-IBAN match. Payer/
Kostenträger name is ADVISORY context only, never a gate (Pflegekassen names too
variable for a safe fuzzy).

**Why:** do NOT "fix" the backfill to reuse satisfiesTripleEquality — it would match
zero fully-paid advices. And do NOT add a name-fuzzy gate — a wrong name-match would
auto-link 25 invoices.

**How to apply:** any `--apply` writer (separate approved run) reuses these three
gates + the uniqueness guard (exactly one candidate credit); it must skip advices
already linked via matched_payment_advice_id and stay XOR-safe.
