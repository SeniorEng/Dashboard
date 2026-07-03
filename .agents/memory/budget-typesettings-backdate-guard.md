---
name: Budget type-settings backdate guard
description: Why the "Gültig ab" backdating rejection in upsertBudgetTypeSettings must be evaluated independent of the open row's freshness.
---

Rule: In `upsertBudgetTypeSettings` an explicit `validFrom <= today` that shifts where a pot's value starts is REJECTED (hard 400, `BudgetBackdateNotAllowedError`) iff a NON-FRESH valued phase is in force anywhere in the window `[validFrom..today]`. Otherwise (empty window) the backdate is accepted as a real, clamped phase append. This is the user-confirmed "Option 1".

**Why:** The rejection must NOT be gated on the open `current` row or `currentIsFresh`. Two bypasses slipped through when it was:
1. After a same-day transition the open row is fresh (`validFrom = tomorrow`) → a second, backdated save hit the in-place path and retroactively overwrote the valued predecessor.
2. A pot with only closed/expired valued rows has NO open `current` row → a backdated first-write inserted an open row overlapping the closed valued window.

**How to apply:** Build the blocker set as ALL rows of the pot EXCEPT the current row when it is fresh (a never-in-force row must not block backdating itself — this preserves the legitimate same-day correction of a fresh NULL-baseline or a fresh valued row created today). Reject if any blocker is valued and its `[validFrom..validTo]` overlaps `[validFrom..today]` (NULL validFrom = -∞, NULL validTo = open; closed rows count when `validTo >= backdate`). Future-dated valued rows are correctly non-blockers (window overlap excludes them). Do NOT "simplify" this check back to a `current`/`currentIsFresh` gate.

Residual (Option-1-compliant, intentionally not fixed): on genuinely value-empty windows the fresh in-place and no-current first-write paths do NOT clamp an unvalued predecessor to `backdate-1`, so `getActiveBudgetTypeSettings` can return two rows in the overlap window (enabled/priority ambiguity). No amount is changed retroactively.
