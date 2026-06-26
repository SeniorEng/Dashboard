---
name: Cockpit drill lazy pagination
description: Why the billing cockpit overview must not return drill rows inline; drill is a separate paginated endpoint.
---

# Cockpit overview ≠ drill rows

The billing cockpit (`/admin/cockpit`, read-only) overview (`GET /billing/cockpit`,
`server/storage/billing/cockpit-reader.ts` → `readBillingCockpit`) returns ONLY
aggregates: funnel stage contributions + €/minutes totals + the "Zu prüfen" buckets,
computed via SQL `GROUP BY` over an appointment CTE plus `getInvoices`. It must NOT
embed the underlying per-appointment/per-invoice rows.

Per-stage detail rows come from a SEPARATE lazy endpoint
`GET /billing/cockpit/drill?year&month&stage&limit&offset` (`readBillingCockpitDrill`),
fetched only when a funnel stage is clicked (`useBillingCockpitDrill`, `enabled: stage!==null`),
paginated by a growing limit (offset 0). The drill uses a 2-phase query: a cheap
classify query to page the IDs, then the expensive price query only for the page's IDs.

**Why:** the original reader returned ~4032 rows (~1.3 MB JSON) inline and the client
rendered them all synchronously → infinite spinner / overload (Task #1450). Re-inlining
rows or removing the drill endpoint reintroduces the hang.

**How to apply:** any new cockpit metric goes through SQL aggregation in the reader, not
row materialization. €-conservation and stage mapping MUST reuse the existing SSoTs
(`assignAppointmentStage` → `mapPipelineStageToFunnel`, the price formula
`csp.scope='customer' AND csp.origin='customer_service_prices'` … COALESCE
`default_price_cents`, and the `is_invoiced` EXISTS check matching `pipeline-reader.ts`) —
never hand-roll parallel math in SQL.
