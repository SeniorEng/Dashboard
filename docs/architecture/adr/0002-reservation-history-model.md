# ADR-0002 — Reservation history model

- **Status:** Accepted (Budget Greenfield Phase 0, Task #870)
- **References:** `[N1]`; north star
  [Budget Greenfield Architecture](../budget-greenfield-architecture.md) §"GoBD posture",
  §"Reservation lifecycle"; invariant I10; builds on
  [ADR-0001](./0001-reservation-financial-split.md).
- **Date:** 2026-05-31

## Context

[ADR-0001](./0001-reservation-financial-split.md) splits operational holds
(`budget_reservations`) from the GoBD-immutable financial ledger (`budget_ledger`). Because
`Available = Allocated − HoldsActive − ConsumedNet` now spans both layers, the value of
`Available` at a past instant depends on the reservation state *as it was then*.

The open Phase-0 question (N1): does the system guarantee that a **past `Available` is
replayable as-of an arbitrary date** — which requires the reservation layer to be
append-only / bitemporal — or are the temporal/replay guarantees **scoped to the financial
ledger only**, with reservations carrying just an operational transition log?

The decision matters because it fixes what an auditor or a disputed-booking review can
reconstruct, and it is expensive to add bitemporality to a high-churn operational table
later.

## Decision

**Temporal as-of-replay guarantees are scoped to the financial ledger only.** The
reservation layer is **not** bitemporal.

Concretely:

- `budget_ledger` (`consumed`/`reversed`) is the bitemporal source of truth: bookings,
  reversals and corrections at a past `transactionDate` bind to the settings, allocations
  and immutability rules valid then. An auditor reconstructs **what was actually consumed**
  and every correction from this layer (it is append-only and GoBD-immutable).
- `budget_reservations` carries an **append-only transition audit log** (who / when /
  from→to) for every state change, sufficient for a **disputed-booking review** ("when was
  this appointment planned, when was the hold released/captured, by whom"). It does **not**
  guarantee numeric as-of replay of past `HoldsActive` / `Available`.
- Therefore the product **does not** promise "reconstruct the exact `Available` balance as
  it stood on date X" for dates in the past. It promises: (a) the exact financial position
  (allocations − consumed-net) as-of any date, and (b) the operational audit trail of every
  reservation transition.

This is recorded explicitly so a later phase does not silently assume full bitemporal
replay, and so I10's "as-of replay test if in scope" is settled as **out of scope** for the
reservation layer.

## Rejected alternatives

- **Append-only / bitemporal reservation layer (full as-of replay of `Available`).**
  Rejected: holds are operational and high-churn; making the reservation table bitemporal
  (valid-time + transaction-time, no in-place state mutation) imposes significant modeling
  and write cost on routine plan/cancel/reschedule activity, for an audit need that the
  financial ledger already covers. Reservations are not tax-relevant
  ([ADR-0001](./0001-reservation-financial-split.md)); GoBD does not require their
  bitemporal reconstruction.
- **No reservation history at all (pure mutable state).** Rejected: a disputed-booking
  review needs who/when/from→to for each transition; a bare current-state row cannot answer
  "who released this hold and when". The append-only transition audit log is the minimum.

## Consequences

- I10 is satisfied for the financial ledger (historization tests incl. reversal/correction
  path); the as-of `Available` replay test is explicitly **not** required for the
  reservation layer.
- Any future requirement for true historical `Available` reconstruction is a new decision
  (a superseding ADR) and a schema change to make reservations bitemporal — it is not
  assumed by any Phase 1–6 deliverable.
- The reservation transition audit log is mandatory wherever a reservation state changes;
  the orphan sweep (`[R6]`) and reschedule atomicity (I19) rely on it for traceability.
