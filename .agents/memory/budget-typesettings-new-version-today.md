---
name: Budget type-settings new-version-ab-heute vs BUG-13 pull-forward
description: When a PUT without validFrom on a future-open budget type-settings row must become a new version instead of pulling the future row forward.
---

`upsertBudgetTypeSettings` (server/storage/budget/preferences-storage.ts) has two
mutually-exclusive behaviours for a PUT **without** explicit `validFrom` when the
open row is future-dated (`current.validFrom > today`):

- **BUG-13 pull-forward (Task #754):** the future row is the ONLY config covering
  the stichtag → re-date it in-place to `today` (single row).
- **New-version-ab-heute (Task #1169):** another row already in force covers
  `today` (a predecessor phase with `validFrom <= today` and `validTo IS NULL OR
  validTo >= today`) → DO NOT pull forward. Route through the existing
  phase-append path with `appendVf = today`: close predecessor at `today-1`,
  insert `[today .. successor.validFrom-1]`, leave the future phase intact.

**Why:** pulling the future row forward when a still-in-force predecessor exists
overwrites the planned future phase AND overlaps the predecessor → two active
rows for the same budget_type at the same date → `getActiveBudgetTypeSettings`
returns duplicates, GoBD "which limit applied on day X?" no longer reconstructible.

**How to apply:** the discriminator is `hasInForcePredecessor` (some OTHER row
covers today). Both paths share ONE code path (the phase-append block); only the
stichtag differs (explicit future date vs `today`). Don't add a second
versioning codepath. If you touch the gate, keep both
`tests/budget/type-settings-future-row-overwrite.test.ts` (BUG-13) and
`tests/budget/task-1169-settings-revisionssicher.test.ts` green.
