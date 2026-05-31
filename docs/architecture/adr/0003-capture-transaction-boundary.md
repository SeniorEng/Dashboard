# ADR-0003 — Capture transaction boundary

- **Status:** Accepted (Budget Greenfield Phase 0, Task #870)
- **References:** `[N2]` `[R5]`; north star
  [Budget Greenfield Architecture](../budget-greenfield-architecture.md) §"Data model"
  (point 2), §"Concurrency, overdraft & idempotency"; invariants I13, I15; builds on
  [ADR-0001](./0001-reservation-financial-split.md).
- **Date:** 2026-05-31

## Context

When a planned appointment is completed, its operational hold in `budget_reservations` must
become a financial `consumed` row in `budget_ledger` (capture). This write crosses the two
tables introduced in [ADR-0001](./0001-reservation-financial-split.md):

1. update the reservation `hold → captured` and set `capturedLedgerId`, and
2. insert the `consumed` row in the financial ledger.

If these two writes can land independently, a crash or a retry between them produces a
**half-captured state**: a hold marked captured with no ledger row, or a ledger row with the
hold still open — which breaks conservation (I13) and double-books or loses budget.

Both tables live in the **same PostgreSQL database**.

## Decision

**`hold → captured` is one local ACID transaction across both tables, under one idempotency
key.** In a single same-database transaction:

- the reservation row transitions `hold → captured` and records `capturedLedgerId`, and
- the new `consumed` row is inserted into `budget_ledger`,

committed together or not at all. The operation carries a single idempotency key (unique per
`(appointmentId, occurrenceId, intendedTransition)`); a replay is a no-op, never a second
ledger row (post-or-void-once, I15). I13 cross-checks **both** sides: every captured hold
has its ledger row and vice versa — half-captured states are flagged by the conservation
verifier.

Because both tables are in the same database, **no saga, outbox, or two-phase commit is
needed**, and this is written down so nobody later splits capture into two calls.

## Rejected alternatives

- **Two separate calls / write the ledger then update the reservation (or vice versa).**
  Rejected: a failure between the two writes leaves a half-captured state that violates
  conservation. There is no atomicity guarantee across two calls.
- **Saga / outbox / two-phase commit.** Rejected as accidental complexity: those patterns
  exist to coordinate writes across *separate* datastores. Here both tables share one
  database and one transaction — a saga would add eventual-consistency windows and
  compensation logic for a problem a local transaction already solves.
- **A single mutable "balance" row updated on capture.** Rejected: violates the core
  principle (no mutable balance column) and the reservation/ledger split.

## Consequences

- The capture path is implemented as exactly one storage-layer transaction; route handlers
  must not orchestrate the two writes separately.
- The idempotency key makes complete/replay safe (I15); the unique constraint turns a
  duplicate into a no-op.
- The conservation verifier (I13, read-only, prod-safe) asserts `reservations.capturedLedgerId
  ↔ ledger` integrity and surfaces any half-captured row.
- Reconciliation when actuals differ from the hold (partial capture, overflow to private
  pot, over-budget completion) is governed by the R4 rules in the north star and is layered
  *on top of* this atomic boundary — the capture write itself stays single-transaction.
