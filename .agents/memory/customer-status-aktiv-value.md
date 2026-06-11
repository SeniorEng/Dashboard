---
name: Customer status DB value is German "aktiv"
description: Counts/filters on customer status must use "aktiv", not "active"; intake-checklist SSoT location.
---

# Customer status value & intake checklist

The `customers.status` value for an active customer is the German string
**`"aktiv"`**, NOT `"active"`. Any server filter/count keying off active
customers must use `"aktiv"`.

**Why:** While adding the "Kunden in Anlage" inbox count (Phase 3 task-list
onboarding) the neighbouring budget-setup-missing-count was found filtering on
`"active"` — a pre-existing latent bug that makes that counter always return 0.
Left untouched (out of scope) and filed as a follow-up; the new in-intake count
correctly uses `"aktiv"`.

**How to apply:** When writing or reviewing customer status filters/counts in
`server/routes/admin/customers.ts` (or storage filters), confirm the literal is
`"aktiv"`. If you see `"active"` for a customer status comparison, it's a bug.

## Intake-checklist onboarding pattern
- "In intake" (queryable milestone, no new status store) = status `"aktiv"`
  AND no active contract (`hasActiveContract=false`). This is the coarse server
  signal behind the count/filter/pipeline.
- The richer per-customer step display is the pure SSoT
  `computeIntakeChecklist` in `shared/domain/customers/intake-checklist.ts`
  (arch rule: `compute*`/`calculate*` only in `shared/domain/`).
  `computeIntakeChecklist` is NOT a guarded hotspot name.
- Customer creation default is the minimal-create form at
  `/admin/customers/new`; an "Alle Schritte" toggle reveals the full wizard in
  the same page (reuses `useCustomerWizard`), so the §45b creation-time override
  + its smoke test stay reachable — the smoke test must click the toggle first.
