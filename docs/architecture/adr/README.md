# Architecture Decision Records (ADRs)

This directory holds the durable, reviewed decision records for the codebase. An ADR
captures **one** decision: the context, the chosen option, the rejected alternatives, and
the reason. ADRs are append-only history — a superseded decision is not edited away, it is
marked `Superseded by ADR-NNNN` and a new ADR is added.

## Format

Each ADR follows a light template:

- **Status** — `Proposed` | `Accepted` | `Superseded by ADR-NNNN`
- **Context** — the forces and constraints that make the decision necessary.
- **Decision** — the choice, stated unambiguously.
- **Rejected alternatives** — what we considered and why we did not pick it.
- **Consequences** — what this commits us to (invariants, follow-up work).

## Index

| ADR | Title | Status | Area |
|---|---|---|---|
| [0001](./0001-reservation-financial-split.md) | Reservation-vs-financial split and transition-storage model (`[R8][R9]`) | Accepted | Budget Greenfield Phase 0 |
| [0002](./0002-reservation-history-model.md) | Reservation history model (`[N1]`) | Accepted | Budget Greenfield Phase 0 |
| [0003](./0003-capture-transaction-boundary.md) | Capture transaction boundary (`[N2]`) | Accepted | Budget Greenfield Phase 0 |
| [0004](./0004-two-table-non-negativity-guard.md) | Two-table non-negativity guard (`[N3]`) | Accepted | Budget Greenfield Phase 0 |

ADRs 0001–0004 lock the four hard-to-reverse Phase-0 decisions of the
[Budget Greenfield Architecture north star](../budget-greenfield-architecture.md). They are
the gate deliverable of Phase 0 (Task #870): no schema or runtime code ships in this phase —
these records exist so the second-order edges are designed before any table is built.
