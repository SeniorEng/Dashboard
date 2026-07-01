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
REAL seeded `hauswirtschaft` service, not a custom-code test service (a custom code is invisible
to the readers). Isolate in a far-future year (e.g. 2035) on the shared test DB; seed a
`role_wage_rates` row (role='admin' for the seed superadmin, latest valid_from wins so no clash
with the 2025/2026 wage-sql fixtures) and a `prices` row (scope='customer',
origin='customer_service_prices') both ≠ catalog, then assert each reader shows the effective
value. See `tests/economics-effective-rate-drift.test.ts`.
