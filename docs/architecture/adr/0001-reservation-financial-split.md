# ADR-0001 — Reservation-vs-financial split and transition-storage model

- **Status:** Accepted (Budget Greenfield Phase 0, Task #870)
- **References:** `[R8]` `[R9]`; north star
  [Budget Greenfield Architecture](../budget-greenfield-architecture.md) §"Data model — two
  layers, three tables", §"GoBD posture"; invariants I3, I8, I11, I17.
- **Date:** 2026-05-31

## Context

Today §45b's monthly allocations are computed on the fly and "used" has four different
definitions depending on the call path. The north star removes derivation from reads: every
euro that exists or is committed is a real row, balances are always `SUM` over immutable
rows.

The product owner decided to introduce **hard-hold reservations** on planned appointments.
This forces a structural question that is expensive to retrofit: is a planned hold a
*Buchung* (a tax-relevant booking) or not?

The validation passes were explicit: **a hold is not a *Buchung*.** Plan/cancel churn on
appointments is an *operational* concern; only `consumed`/`reversed` rows are tax-relevant
GoBD bookings. If holds live in the same immutable, append-only ledger as financial
bookings, routine re-planning pollutes the audit trail, and GoBD immutability would bind
rows that have no fiscal meaning.

## Decision

Split the model into **two layers across three tables**:

1. **`budget_allocations` — "what exists" (credits).** Every allocation is a materialized
   row, including §45b's monthly statutory amount. A pot may be `uncapped` via an explicit
   boolean flag (never a literal huge `amountCents`).
2. **`budget_reservations` — operational holds (NOT GoBD).** Mutable, sweepable holds
   created at plan time. State machine `hold → captured | released | expired`. Mutating
   these states is **allowed** because it is operational, but **every transition is
   audit-logged** (who / when / from→to). Reservations are excluded from GoBD/financial
   exports.
3. **`budget_ledger` — financial bookings (GoBD-immutable, append-only).** Only `consumed`
   and `reversed` rows. A correction is a **new `reversed` row plus a fresh `consumed`**,
   never an in-place edit. GoBD immutability triggers, storno semantics and retention bind
   **this table only**.

**Transition-storage model:** the financial ledger is **append-only** (correction =
reversed + new consumed — the purest GoBD posture, changes are never silent). The
reservation layer is **mutable-state with a transition audit log** (operational churn does
not create immutable financial history). This is the deliberate asymmetry: immutability
where it is fiscally required, mutability-with-audit where it is operationally needed.

The single read formula spanning both layers is the SSoT:

```
Available(pot, period) = Allocated − HoldsActive(reservations) − ConsumedNet(ledger)
```

## Rejected alternatives

- **Single ledger where holds are bookings.** Rejected: routine plan/cancel churn would
  pollute the GoBD audit trail with non-fiscal rows, and append-only immutability on holds
  would make cancellation/rescheduling require storno rows for work that never had fiscal
  meaning. It also conflates "committed but not performed" with "performed".
- **Trigger-logged immutability on the reservation table too.** Rejected: holds are
  operational and high-churn; binding GoBD immutability triggers to them adds storno
  overhead and retention obligations with no audit value. An append-only transition audit
  log gives the needed who/when/from→to traceability at far lower cost.
- **Storing reservations only in memory / a cache.** Rejected: violates the core principle
  (every committed euro is a real row) and makes overdraft impossibility (ADR-0004)
  unenforceable at the database level.
- **A mutable balance column per pot.** Rejected outright: the classic drift source. Nobody
  may "optimize" by adding one.

## Consequences

- GoBD immutability, storno semantics and retention apply to `budget_ledger` only
  (invariants I11, I17). Released/expired holds never appear in financial exports.
- The reservation state machine and the ledger state machine are both asserted by an
  architecture test that rejects every transition not in I3.
- Capture (`hold → captured`) crosses both tables atomically — see
  [ADR-0003](./0003-capture-transaction-boundary.md).
- Non-negativity must be re-derived across **both** reservations and ledger — see
  [ADR-0004](./0004-two-table-non-negativity-guard.md).
- What an auditor can reconstruct from the reservation layer is bounded by
  [ADR-0002](./0002-reservation-history-model.md).
