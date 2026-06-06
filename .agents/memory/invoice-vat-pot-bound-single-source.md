---
name: Invoice/LN VAT is pot-bound & single-source
description: USt-Behandlung in Rechnung+Leistungsnachweis hängt am Budget-Topf, nicht am billingType; Renderer darf USt nie eigenständig ×1,19 hochrechnen.
---

# Invoice/Leistungsnachweis VAT — pot-bound & single-source

Two rules every invoice/Leistungsnachweis (LN) render or new line-item math MUST follow.

## Rule 1 — VAT treatment is bound to the budget POT, not the billingType string
- Any real budget/Kasse pot (`BUDGET_TYPES` in `shared/domain/budgets.ts`) ⇒ **exempt**
  ("Umsatzsteuerbefreit gem. § 4 Nr. 16 UStG", net === gross, NO "USt." crumb).
- `private` pot / Selbstzahler (or no pot marker + selbstzahler billingType) ⇒ **standard 19 %**.
- Single resolver: `resolveVatTreatment({billingType, budgetType})` in `shared/domain/invoice-vat.ts`.
- **Why:** the old code keyed exemption off `billingType` alone, so a correctly-booked exempt pot could still render a stray "USt 0,04 €" crumb (RE-2026-0023). Exempt invoices can even carry a legacy non-zero `vatAmountCents` in storage — the renderer MUST suppress it in display (treatment wins over the stored amount).

## Rule 2 — the renderer never recomputes VAT independently (no ×1,19 per line)
- The persisted VAT *sum* is distributed across lines via `distributeVatAcrossLines(lineNets, totalVat)` (largest-remainder, sign-safe so storno works), guaranteeing **Σ(gross lines) === gross total**.
- The per-unit "Satz (brutto)" column uses `grossUpUnitPriceCents` and is informational only — never summed.
- **Why:** rounding each line independently with ×1,19 drifts from the gross total (e.g. 3 lines × 3 ct: per-line rounding → 12, correct → 11). This was the core line-sum-≠-gross bug.

## How to apply
- New invoice/LN line-item math or a second renderer path must reuse `shared/domain/invoice-vat.ts`, not re-derive VAT.
- Regression guards: `tests/equality/invoice-vat-treatment.test.ts` (pure) + `tests/equality/invoice-vat-render.test.ts` (renders `generateInvoiceHtml`/`generateLeistungsnachweisHtml`, asserts Σ-lines===gross and exempt = no crumb). Renderers live in `server/lib/pdf-generator.ts`.
- LN scoping (separate but same task): each LN is scoped to its own invoice's customer + only that invoice's billed appointment IDs, fail-closed on a foreign customer (`server/services/invoice-pdf-orchestrator.ts`); the Beihilfe-duplicate page is gated off for stornorechnung.
