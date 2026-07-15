---
name: Statistics economics (Wirtschaftlichkeit) SSoT
description: Cost/margin/valuation decisions behind the revenue dashboard's profitability block, reused by performance.
---

# Statistics economics SSoT

The Wirtschaftlichkeit calc lives in `shared/domain/statistics/economics.ts` (pure) and is the SSoT for both the revenue dashboard (`/admin/statistics/revenue`) and the performance dashboard margin math.

## Durable valuation decisions
- **Non-billable time** (büroarbeit/vertrieb/sonstiges/krankheit/urlaub) is valued at the **Hauswirtschaft rate** (`nonBillableRateCents` = cheapest productive rate) — a deliberate conservative overhead valuation, NOT the AB or Erstberatung rate.
- **Time-entry km** is paid out at the **travel_km** catalog rate (the `kilometers` column on time entries); appointment km use `travel_kilometers`/`customer_kilometers`.
- **All rates come ONLY from the service catalog** (`shared/config/services.ts`): HW rate 1600/price 3800, AB rate 1800/price 4200, Erstberatung rate 1600/**price 0** (`isBillable:false`), km rate 30/price 35 (cents). Never hardcode parallel rates.
- **Erstberatung is NEVER part of the HW category in ANY of the 3 economics readers**, even though the `erstberatung` service carries `lohnart_kategorie='hauswirtschaft'`. All readers key off `appointment_type='Erstberatung'` (checked FIRST) to split it out, so the HW effective rate (38,00 €) is never diluted by ≈0-€ Erstberatung labor. The presentation differs **on purpose**: Reader 1 (billing `economics-reader.ts`) routes Erstberatung labor into **Gemeinkosten/Overhead** (`erstberatungMinutes:0`, own overhead category); Reader 2 (`statistics/economics.ts`) and Reader 3 (`statistics/performance.ts`, inherits Reader 2 via `getEconomics`+`categoryRevenue`) show it as its **own productive `erstberatung` line**. Drift-guarded in `tests/economics-effective-rate-drift.test.ts` (same-period HW+AB+Erstberatung fixture).
- `marginPercent(revenueCents, marginCents)` = `revenue>0 ? round(margin/revenue*100) : 0` — the one margin formula; `performance.ts` imports it (don't re-inline).
- km totals go through `computeKmLineTotalCents` (arch test `calculations-in-shared` forbids `Math.round(km*rate)` in TS).

**Why:** §1355 required ONE reusable cost/quantity calc so the revenue and performance views never drift; the HW-rate-for-overhead choice was an explicit product decision.

## Verifying statistics tests
- `statistics-v2.test.ts` and `performance-stats-category.test.ts` assert **specific properties/lengths**, never whole-object equality — so adding fields to the revenue response (`economics`, `stageHours`) is safe and won't break them. `performance-stats-category` checks category *minute aggregation*, independent of margin math.
- The agent harness saturates when all validation workflows (test/e2e-smoke/billing-cov) run at once (`pthread_create: Resource temporarily unavailable`, shell 500s) — isolate a clean signal with `npx tsx scripts/with-ephemeral-db.ts <port> npx vitest run --no-file-parallelism <files>`.
