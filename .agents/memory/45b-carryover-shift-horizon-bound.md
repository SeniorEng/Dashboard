---
name: §45b carryover-shift horizon bound
description: Why the §45b allocStart-shift and IB-floor must bound carryovers by the read date, or backdated reads/bookings wrongly zero out §45b.
---

# §45b carryover-shift must be bounded by the read horizon

In `calculateAllocated45b` (`server/storage/budget/allocation-storage.ts`) there is a
"carryover-aware allocStart shift": if a `source='carryover'` allocation exists for target
year Y, `allocStart` is pushed to Jan-1 of the latest carryover year (the carryover condenses
all prior years, so we must not re-accrue them). The same `latestCountedCarryoverYear` value
also feeds the IB-supersession floor (`ibFloorYear`).

**The rule:** the set of carryovers considered for that shift MUST be bounded by the read date
(`opts.asOfDate`), exactly the same `validFrom <= asOfDate` predicate that `carryoverTotal`
already uses further down. Shift and counted total must stay consistent.

**Why:** Once §45b leftovers are materialized forward as carryovers (universal expiry/accrual
model), a carryover can have a FUTURE `validFrom` relative to a backdated read. Example: a
carryover into 2026 (`validFrom 2026-01-01`) must not influence a read/booking as-of
2024-06-15. Without the bound, `Math.max(carryoverYears)` returns 2026, `allocStart` jumps to
2026 while the horizon end stays 2024 → `allocStart > end` → §45b availability collapses to 0,
and a legitimately backdated booking silently cascades into the next pot (§45a). This is a GoBD
regression: the historical booking should consume the §45b budget that was live at its
`transactionDate`.

**How to apply:** Any code that derives a "latest carryover year" to gate accrual start or IB
supersession must filter carryovers by `validFrom <= (opts.asOfDate ?? end-of-current-year)`.
The aggregate read uses `asOfDate`; `{year}`-mode / default reads fall back to current year-end.
The consumption engine reads §45b availability with `asOfDate = transactionDate` (see
`computeFifoAvailability` in `consumption-engine.ts`, `today = transactionDate`), so backdated
bookings depend on this bound being correct.
