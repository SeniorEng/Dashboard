---
name: Reporting rate labels must be effective (money ÷ quantity)
description: Anzeige-vs-Buchung rule for the 3 reporting readers' per-unit rate labels + how to drift-test them.
---

The three reporting readers — billing economics (`server/storage/billing/economics-reader.ts`),
statistics economics (`server/storage/statistics/economics.ts` → `getEconomics`), and
performance profitability (`server/storage/statistics/performance.ts` → `servicePrices`) —
must derive every displayed per-unit RATE from persisted money ÷ quantity, NOT from the flat
catalog columns (`services.default_price_cents` / `employee_rate_cents`). Money columns already
use effective role-based wages (`role_wage_rates`) + customer-specific prices (`prices`), so a
catalog-sourced label drifts from the booking. Quantity ≤ 0 ⇒ rate 0 (no divide).

**Why:** the money side went effective (role wages Task #1503, customer prices) but the labels
stayed catalog ⇒ "Anzeige-vs-Buchung" drift the user reported.

**How to apply / drift-test trap:** these readers filter services by CODE
IN ('hauswirtschaft','alltagsbegleitung','erstberatung'), so a drift test MUST book against the
REAL seeded service, not a custom-code test service (a custom code is invisible to the readers).
Isolate in a far-future year on the shared test DB; seed a `role_wage_rates` row (role='admin'
for the seed superadmin, latest valid_from wins so no clash with the 2025/2026 wage-sql fixtures)
and a `prices` row (scope='customer', origin='customer_service_prices') both ≠ catalog, then
assert each reader shows the effective value. See `tests/economics-effective-rate-drift.test.ts`.

**Two per-category traps (Task #1551):**
- Erstberatung is NOT a line in Reader 1 (billing economics-reader): it hard-sets
  `erstberatungMinutes:0`/`erstberatungCostCents:0`, so only Readers 2 & 3 expose an EB rate.
  An EB appointment needs `appointment_type='Erstberatung'` (the category branch keys off it),
  and EB catalog `default_price_cents=0` so the effective customer price is what makes the label ≠ catalog.
- Each category MUST live in its OWN far-future year. Reader 1 categorizes purely by
  `lohnart_kategorie`, and the erstberatung service carries `lohnart_kategorie='hauswirtschaft'`,
  so an EB appointment in the same year as HW gets merged into Reader 1's Hauswirtschaft row and
  corrupts its rate assertion. Reader 3 falls back to the CATALOG rate (not 0) when minutes=0 by
  design ("Katalog-Referenz"), so don't assert "qty0⇒rate0" on Reader 3 — that guard only holds
  for Reader 1's gemeinkosten row.
