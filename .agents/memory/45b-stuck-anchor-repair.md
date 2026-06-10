---
name: §45b stuck-on-one-month anchor repair
description: Why repairing a NULL-origin §45b anchor needs a date re-derive, not just an origin flip
---

# §45b "stuck on one month" anchor repair

Legacy customers can have customer-wide `budget_start_date` pinned to the Stichmonat
with `budget_start_date_origin = NULL`. The §45b read path (`calculateAllocated45b`)
only floors/clamps an anchor when origin === 'derived_pflegegrad'; with NULL it reads
the anchor RAW, so §45b stays stuck on the Stichmonat (~131€) instead of accruing YTD.

## The trap
Just flipping origin NULL→'derived_pflegegrad' does NOT un-stick a Stichmonat anchor
that sits in the CURRENT year: `floorAutoAnchor45bToCurrentYear` only RAISES pre-Jan-1
dates, it never pulls a later date earlier. To actually un-stick, you must ALSO
re-derive the anchor date to the earliest Pflegegrad start (`resolve45bAccrualAnchor`)
— then the floor takes it back to Jan-1 of the current year (full YTD). This mirrors
the #1143 forward fix in the DELETE / wizard paths.

**Why:** the floor is one-directional (raise-only). Origin only enables the floor; the
date is what determines how far back accrual starts.

**How to apply:** repair gate = §45b enabled (date-independent `.some(enabled)`),
origin IS NULL, budget_start_date set, has Pflegegrad history, AND
derivedAnchor < currentAnchor (genuinely stuck; protects manual/earlier anchors).
Set date=derivedAnchor + origin='derived_pflegegrad'. §45a/§39 keep reading the anchor
raw — the re-derived value IS the canonical Pflegegrad anchor they should use.

## Second-order gotcha
A §45b `initial_balance` allocation dated at/after the corrected anchor still re-pins
the accrual start via the `initialBalanceMonths` shift in `calculateAllocated45b`, so
the anchor fix alone can be incomplete for those customers — detect and warn (separate
allocation-aware repair needed; older `fix-customer-45b-anchor.ts`/#856 moved
allocations but predates the origin-aware read path).

Tool: `server/scripts/repair-45b-stuck-anchor.ts` (dry-run default; --apply; prod
allowed but needs --confirm-prod; measures before/after via calculateAllocatedCents
inside a rolled-back txn; audit-logged).
