---
name: priceFor pricing SSoT
description: The one price-resolution function, its shadow mode, the FK-safe by-ID rule, and the human-gated table consolidation still pending.
---

# priceFor — the one price-resolution SSoT

The fachliche Frage "Welcher Preis gilt für Kunde X, Service Y am Datum Z?" has
exactly ONE answer path now. Anzeige- und Schreibpfade import the same function.

- Pure resolver: `shared/domain/pricing/price-for.ts` (`resolvePriceFor`).
- Server loader: `server/storage/pricing/price-for.ts` (`loadCustomerPriceContext`
  → `resolveByCode`/`resolveById`).
- Order: Kunden-Override → Standard → Katalog-Default (`services.defaultPriceCents`),
  zeitversioniert.

**Rule:** the EXISTENCE of a customer price row wins over
standard/default, even at `priceCents = 0` (explicit free). Always `??`/row-present,
NEVER `||`/`value > 0` — a 0 must never fall through to standard/default.

**Why:** a customer can legitimately have a free service (e.g. "keine Anfahrt");
`||` would silently re-price it to the catalog default.

## Shadow mode (current state)

The Standard scope is intentionally EMPTY, so resolution falls value-neutrally from
override straight to catalog default = exactly today's behavior. Wiring the 3 live
consumers (appointment-cost-calculator, invoice-data, routes/budget) changed no
computed price.

## Pending — HUMAN-GATED (do not auto-do)

Step 4 = consolidate the 3 price tables (`customer_service_prices`,
`customer_contract_rates`, `service_rates`) into one `prices` table, delete the old
tables, and activate a destructive arch guard. Requires Alrik sign-off based on the
two read-only diagnostics (`server/scripts/report-price-consolidation-conflicts.ts`,
`server/scripts/shadow-diff-price-for.ts`). Migrate BOTH customer sources losslessly,
preserving 0/free rows.

## GoBD

Already-invoiced snapshots are NOT recomputed: sealed invoices re-render from
`render_snapshot`; the priceFor path only runs at invoice/booking GENERATE time.
Full doc: `docs/pricing-ssot.md`.
