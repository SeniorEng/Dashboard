---
name: Qonto amount-only auto-match is bind-for-review
description: Why a Qonto payment matched only by equal amount must NOT auto-mark an invoice paid, and what counts as corroboration.
---

# Qonto reiner Betrags-Treffer → Prüf-Zustand, nicht „bezahlt"

An auto-match whose ONLY signal is an equal amount (no invoice number, no
corroborating token in the reference) must NOT silently mark an invoice paid.
It binds the transaction with confidence `auto_amount_review` and records an
`invoice_payment_review_required` audit — the invoice stays open until an admin
confirms (confirm-paid → graduates confidence to `auto_amount`) or rejects
(unmatch). Only strong matches (invoice number / exact / Sammel-Avis) still
settle automatically; the guard is scoped to the `auto_amount` path only.

**Why:** A same-amount payment from a *different* customer (AOK 77,40 € for an
insured person, period 04-2026) auto-settled a stranger's §45b invoice of the
same amount — and its bank date was even before that invoice existed. Pure
amount equality is not proof of payment.

**How to apply:**
- Corroboration lives in `shared/domain/qonto/amount-match-guard.ts`
  (`evaluateAmountOnlyMatch` → block/confirm/review; pure, unit-tested).
- Corroboration = insured **Versichertennummer**, insured **name**, or the
  **billing period** appearing in the reference text.
- CRITICAL: the name check uses the invoice's `customerName` (the insured
  person), **never** `recipientName`. For Pflegekasse invoices `recipientName`
  is the insurer (e.g. "AOK Bayern") = the payer, which appears in the
  reference of *every* payment from that insurer and would falsely corroborate
  the exact bug above.
- Period matching accepts only delimited forms (MM/YYYY, MM.YYYY, MM-YYYY,
  YYYY-MM, month-name+year) — NOT a bare 6-digit "MMYYYY" (IBAN substring risk).
- Plausibility guard: implausible when `startOfLocalDay(emittedAt) <
  startOfLocalDay(invoiceCreatedAt)` (day granularity; same day = plausible).
  An implausible amount-path match is **skipped entirely** (counted as skipped,
  not bound). It applies ONLY to the amount path — number matches are unguarded.
- `autoMatch` returns `{ matched, skipped, review }`; the review count surfaces
  in the admin toast and the transactions list (amber "nur Betrag ·
  Bestätigung nötig" badge + review filter).
