---
name: §45a statutory default cap by Pflegegrad
description: Why §45a Umwandlungsanspruch showed 0 and how the statutory default must flow through both allocation and cap SSoT.
---

# §45a statutory default cap (Umwandlungsanspruch)

§45a available is bounded by BOTH the allocated amount (`getCustomerBudgetAmounts` →
the §45a/pflegesachleistungen allocation) AND the per-window cap (cap SSoT
`computeCapSlot`/`cap-math.ts`). If a PG≥2 customer enables §45a but leaves
`monthlyLimitCents` null, the cap resolves to 0 and the overview shows 0 even though
the law grants a statutory monthly cap.

**The rule:** the statutory §45a default (`resolve45aMonthlyLimitCents(explicit, pflegegrad)`
in `shared/domain/budgets.ts`, backed by `BUDGET_45A_MAX_BY_PFLEGEGRAD`) must be applied
in *both* read paths in lockstep:
- the cap SSoT (`shared/domain/budget/cap-math.ts` §45a branch), used by overview + booking
- the allocation read (`server/storage/budget/allocation-storage.ts` `getCustomerBudgetAmounts`)

Apply only when `setting45a.enabled && monthlyLimitCents == null`. Explicit values
(including an explicit `0`) always override — never coerce 0 to the statutory default.

**Why:** if the default flows through only one of the two readers, overview and booking
drift (Anzeige-vs-Buchung), or the value clamps back to 0 at the other reader. Guard
this with an equality test asserting `overview.umwandlung45a == cost-estimate availableCents`
for a PG2 defaulted customer (`tests/equality/45a-statutory-default.test.ts`).

**How to apply:** any new §45a amount/availability reader must call the resolver, not
read `monthlyLimitCents` bare. PG<2 §45a-enable is rejected at the API (400), so the
PG<2→null branch is only reachable as a pure resolver unit test, not an integration scenario.
