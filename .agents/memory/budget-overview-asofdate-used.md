---
name: Budget overview as-of-date used vs history equality
description: Why date-correct totalUsedCents breaks the history===overview SSoT invariant
---

The budget overview/summary read path (`getBudgetSummary` in
`server/storage/budget/summary-queries.ts`) is as-of-date correct: `totalUsedCents`,
the current-month/year consumption+reversal windows, and `currentYearAllocatedCents`
all bound transactions to `transactionDate <= asOfDate` (default today).

**Rule:** `totalUsedCents` MUST stay date-bounded in lockstep with
`totalAllocatedCents` (which only accrues up to `asOfDate`). If used were a lifetime
sum while allocated is as-of-date, `availableCents` would subtract not-yet-incurred
usage from not-yet-accrued budget → wrong.

**Why this bites:** the Phase-1.3 SSoT invariant test
(`tests/equality/budget-history-vs-overview.test.ts`) asserts
`SUM(history month buckets) === overview.totalUsedCents`. The history view is a
per-MONTH ledger (not date-bounded); overview-as-of-today bounds by exact DATE. When
a test books consumption on a *future* weekday (the common cutoff-dodge pattern,
still in the current month), the history bucket counts it but the today-snapshot
excludes it → mismatch.

**How to apply:** when an equality/SSoT test compares history (or any all-rows
aggregate) against overview/summary used numbers, query the overview AS-OF the latest
booked transaction date (`?date=<latestApptDate>`), not bare `/overview`. Same applies
to any new consumer that expects overview used to equal a lifetime sum.
