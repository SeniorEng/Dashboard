---
name: §45b allocation eligibility must be date-independent
description: calculateAllocated45b eligibility/anchor gate + how to repro "expired-window" bugs without hiding them
---

# §45b eligibility/anchor gate (calculateAllocated45b)

Inside the `if (!budgetStartDate)` fallback branch of `calculateAllocated45b`
(server/storage/budget/allocation-storage.ts), the eligibility gate MUST test
`all45bSettings.some(s => s.enabled)` (ALL §45b settings rows, date-independent),
NOT the settings row valid "today".

**Why:** A customer whose only §45b settings row had `validTo` in the past
(window already ended relative to wall-clock) returned a hard `return 0`, so the
top-up for a month *inside* that window vanished. The actual time-windowing is
done later by the `allocStart/end` validFrom/validTo clamp — the gate is only an
on/off eligibility check, so it must not re-apply a "today" date filter.

**How to apply:** Any new eligibility/anchor short-circuit for a statutory pot
must separate "is this pot ever enabled for this customer" (date-independent)
from "which months fall in the window" (the clamp). Don't gate on today's row.

# Reproducing "expired-window" lookups deterministically

To repro/guard a bug that only fires when real "today" is AFTER the queried
window, use the query's `asOfDate` param (e.g. `asOfDate: "2026-05-31"`), NOT a
frozen clock. asOfDate pins the horizon to `min(asOf, today)` (the repro month)
while the real clock keeps moving past the window — so the test both reproduces
the bug and stays green as wall-clock advances. Freezing the clock to inside the
window makes the row valid "today" and HIDES the bug.

# §45b integration-test contamination signal

billing-flow.test.ts and budget-concurrency tests heavily exercise §45b
splits/PDF and are very sensitive to a shared dev DB being hit by two test runs
at once. If `test` runs concurrently with `e2e-smoke` (or a stray isolated
`vitest run`) on the one dev DB, expect spurious BF-2.x/BF-6.x/BC-K4.x failures
that are NOT regressions. Cross-check against e2e-smoke (green = billing/PDF
paths healthy) and confirm none of the §45b equality/conservation tests
(`tests/equality/45b-*`, `tests/budget/45b-*`) are in the failure set.
