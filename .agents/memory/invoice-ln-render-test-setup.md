---
name: Invoice + Leistungsnachweis render test setup
description: Non-obvious data prerequisites to make buildInvoicePdfBytes emit a Leistungsnachweis (LN) and to repro the Beihilfe-storno duplicate gate in integration tests.
---

## A pflegekasse_privat customer with NO budget pot yields NO Leistungsnachweis

`buildInvoicePdfBytes` only renders an LN when `isPflegekasseInvoice` is true,
i.e. the **invoice** `billingType` is `pflegekasse_privat`/`pflegekasse_gesetzlich`.
But invoice-calc reclassifies a single-pot run to `billingType="selbstzahler"`
whenever the only pot consumed is the private/Selbstzahler pot
(`singlePotIsPrivate` → `invoiceBillingType="selbstzahler"`). So a
`pflegekasse_privat` **customer** that has no funded budget pot produces a
`selbstzahler` **invoice** → `leistungsnachweisPdf` comes back `null`.

**How to apply:** To get an LN-bearing Pflegekasse invoice in a test, fund a real
Pflegekasse pot (e.g. §45b via `/initial-budget` + `/type-settings` with the pot
enabled and enough capacity to fully cover the appointment). §45b "Unser Anteil"
is capped at 131,00 € — `monthlyLimitCents`/initial-budget above `13100` is
rejected with a `VALIDATION_ERROR`, so size the appointment to fit under the cap.

## Beihilfe storno = exactly one LN page

For a Beihilfe-berechtigt `pflegekasse_privat` invoice, `buildInvoicePdfBytes`
merges invoice+LN **twice** (Zweitausfertigung) for a regular `rechnung` but only
**once** for a `stornorechnung` (gated by `pdfData.invoiceType !== "stornorechnung"`).
So `pageCount(original) === 2 * pageCount(storno)` and the storno's standalone
`leistungsnachweisPdf` is a single page. The stornorechnung inherits the original's
`billingType`, so it stays a Pflegekasse invoice and still gets its (single) LN.
