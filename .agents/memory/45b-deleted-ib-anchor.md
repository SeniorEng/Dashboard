---
name: §45b deleted-IB anchor fallback
description: Why calculateAllocated45b must anchor on soft-deleted initial_balance rows
---

# §45b anchor must survive soft-deleted initial_balance

In `calculateAllocated45b` (server/storage/budget/allocation-storage.ts) the
`budgetStartDate` anchor chain only looks at ACTIVE rows (`existingAllocations`
is filtered `isNull(deletedAt)`). If a §45b customer has NO enabled
`customer_budget_type_settings` (`s45bEnabled = false`) and the only anchor was
an `initial_balance` row, soft-deleting that row drops the anchor and the
eligibility gate `if (!s45bEnabled) return 0` fires — permanently zeroing the
regular monthly accrual for that month.

**Rule:** a soft-deleted `initial_balance` is still evidence §45b was set up.
Anchor `budgetStartDate` from the earliest validFrom of soft-deleted IB rows as
a fallback (after active pgStart/IB/monthly anchors fail, before the gate). Keep
the skip-set + IB totals ACTIVE-only so a deleted month returns to renewal while
a still-active startwert keeps blocking its own month (Task #101 no-double-pot).

**Why:** active-IB anchored renewal but deleted-IB hit the gate → asymmetric €0.
**How to apply:** any change to the §45b anchor chain or the `!s45bEnabled` gate
must keep deleted IBs as a valid anchor source, or backdated/deleted-startwert
reads regress to 0.
