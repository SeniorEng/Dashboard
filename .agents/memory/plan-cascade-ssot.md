---
name: planCascade cascade SSoT
description: The one pure pot-cascade function and how the consume engine wires it byte-identically
---

# planCascade — the one pure pot-cascade function

`shared/domain/budget/plan-cascade.ts` is the single deterministic distributor of
an appointment cost across priority budget pots (§45b → §45a → §39/§42a →
optional uncapped private/Selbstzahler pot). Pure, no DB/time/random. Emits one
split per pot (positional), `outstandingCents` = remainder no pot covered.

## How the consume engine stays byte-identical
The legacy `consumeFifo` interleaved read+write per pot inside the cascade loop.
It was split into:
- `computeFifoAvailability()` — read-only, returns `{totalAvailable, specialAllocations, consumedBySpecial, reversalBySpecial}`
- `consumeFifoWithAvailability()` — write-only, books against a precomputed availability
- `consumeFifo()` — thin wrapper (read+write) kept for non-cascade callers (rebook).

`createCascadeConsumption` now: Phase 1 precompute every pot's effective capacity
(disabled/out-of-window → 0; capped §45a/§39_42a with cap → min(FIFO-avail,
`computeCapSlot` remaining); else FIFO-avail) AND stash each availability; Phase 2
`planCascade`; Phase 3 write each split>0 via `consumeFifoWithAvailability`.

**Why precompute == just-in-time:** FIFO availability is computed per `budgetType`
and a booking against one budgetType never changes another budgetType's
availability query (all queries filter by budgetType). So reading all pots up
front yields identical numbers to reading each one just before its write.

**Why each pot's write consumes exactly its split:** split.amountCents ≤ effective
capacity ≤ totalAvailable, so `consumeFifoWithAvailability` always books the full
requested amount (the null-allocation leg absorbs whatever special allocations
don't cover) ⇒ consumed == split, ⇒ outstanding == plan.outstandingCents.

**`CascadeResult.breakdown` is NOT consumed externally** (client `.breakdown` hits
are the vacation-entitlement preview, a different type). planCascade emits a
breakdown entry per pot even after the cost is exhausted; the legacy loop
`break`ed early and omitted later entries. This difference is non-observable.

## Conservation verifier (I13)
`server/scripts/verify-budget-conservation.ts` (read-only, prod-runnable, exit
0/1). Checks no pot overdrawn (netConsumed ≤ Σ allocated) per (customer,
budgetType), EXCLUDING the uncapped `private`/`selbstzahler` overflow pot (it has
no allocation by design), plus reservation↔ledger cross-links. I13 is checked as
non-overdraw, NOT strict `allocated-consumed==available` — caps make available
smaller where they bind, so strict equality would false-positive.
