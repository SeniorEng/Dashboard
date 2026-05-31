# ADR-0004 — Two-table non-negativity guard

- **Status:** Accepted (Budget Greenfield Phase 0, Task #870)
- **References:** `[N3]` `[R3]`; north star
  [Budget Greenfield Architecture](../budget-greenfield-architecture.md) §"Concurrency,
  overdraft & idempotency"; invariant I14; builds on
  [ADR-0001](./0001-reservation-financial-split.md).
- **Date:** 2026-05-31

## Context

Overdraft impossibility (`[R3]`, I14): no interleaving of concurrent plan/complete
operations may drive a **capped** pot below zero. Planning is read-then-write — a classic
TOCTOU race — and holds are a **new write path** not covered by today's consumption lock.

Critically, after [ADR-0001](./0001-reservation-financial-split.md), `Available` spans two
tables:

```
Available(pot, period) = Allocated − HoldsActive(budget_reservations) − ConsumedNet(budget_ledger)
```

A single-table `CHECK` constraint on `budget_ledger` cannot see active holds in
`budget_reservations`, and vice versa, so neither table alone can enforce non-negativity.
Application-level checking alone loses to concurrent writers.

## Decision

Enforce overdraft impossibility with **two cooperating mechanisms**:

1. **A per-`(customer, pot, period)` advisory lock** held for the whole plan-and-write
   transaction — the same serialization the consumption path already uses, now extended to
   the hold write path.
2. **A database trigger/guard that re-derives `Available` from BOTH tables** inside that
   advisory-locked transaction and **refuses** any hold or consume that would drive a
   **capped** pot negative. The guard aggregates active holds from `budget_reservations`
   **and** `ConsumedNet` from `budget_ledger` against `Allocated` for the
   `(customer, pot, period)` — it does not trust a single table's local view.

**Uncapped pots (the private/selbstzahler pot) are exempt** — their capacity is never read
as a number, so they cannot overdraft. §45b lazy materialization uses the same lock or an
idempotent `INSERT … ON CONFLICT DO NOTHING`.

This makes I14 a real, enforced guarantee rather than an asserted one.

## Rejected alternatives

- **Single-table `CHECK` constraint.** Rejected: structurally impossible — a `CHECK` on one
  table cannot see the other table's contribution to `Available`. It would silently permit
  overdraft via the unseen layer.
- **Application-level check only (read `Available`, then write).** Rejected: TOCTOU race —
  two concurrent planners both read sufficient budget and both write, driving the pot
  negative. No serialization, no guarantee.
- **Advisory lock only, no DB guard.** Rejected: the lock serializes writers that cooperate,
  but a write path that forgets to take the lock (or a future code path, or a manual fix)
  could still overdraft. The DB guard is the backstop that makes the invariant hold
  regardless of caller discipline.
- **A materialized `Available` column kept in sync by triggers.** Rejected: reintroduces a
  mutable balance (the forbidden drift source); the guard re-derives `Available` by `SUM`
  on demand instead.

## Consequences

- Every write path that creates a hold or a consume row must run inside the
  per-`(customer, pot, period)` advisory-locked transaction; the trigger/guard is the
  backstop if it does not.
- The guard reads both `budget_reservations` and `budget_ledger` — its cost is bounded by
  the per-pot/period row counts; series materialization (`[R12]`) is bounded/async to avoid
  holding the hot lock for long writes.
- I14 is validated by a parallel-writer stress test plus a cross-table trigger test; the
  guard's "capped only" scope is asserted against the uncapped-pot exemption (I5/I6).
- Conservation (I13) and this guard are complementary: I13 detects drift after the fact
  (read-only verifier), this guard prevents the negative state from being written at all.
