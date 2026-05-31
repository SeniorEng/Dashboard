# Budget Greenfield Architecture — North Star (v3, hardened)

> **Promoted:** This is the durable engineering reference for the Budget Greenfield
> architecture (promoted from `.local/tasks/` in Phase 0, Task #870). It supersedes the
> half-finished SSoT migration in [`../budget-ssot-inventory.md`](../budget-ssot-inventory.md)
> by giving it a concrete, defensible end state, and is cross-linked from
> [`./budget.md`](./budget.md). The Phase-0 design decisions it left open (R8/R9, N1, N2,
> N3) are now locked in the ADRs under [`./adr/`](./adr/); the GoBD process narrative is
> seeded in [`./budget-verfahrensdokumentation.md`](./budget-verfahrensdokumentation.md).
>
> **Phase-0 gate (confirmed):** the invariant set I1–I20 (§A) and the per-phase acceptance
> gate table (§C) below are the **agreed baseline** against which Phases 1–6 are measured.
> Reviewed and committed in Phase 0; later phases may add invariants but must not weaken an
> agreed one without a superseding ADR.
>
> **Status:** Target architecture / north star. **v3** — incorporates two independent
> ledger-architecture validation passes (31 May 2026). Pass 1: all 17 findings (F1–F17)
> and 12 recommendations (R1–R12) accepted and folded in, marked `[Rx]`. Pass 2 verdict
> **"Approved to build, Phase 0 first — no critical issues remain"**; its 8 second-order
> edges (N1–N8) and invariant adjustments (I19/I20) are folded in, marked `[Nx]`.
>
> **Decided with the product owner:** hard-hold reservations on planned appointments;
> §45b monthly amount materialized as rows; private/selbstzahler modeled as an
> uncapped pot; over-budget planning allowed only for private-capable customers,
> hard-blocked otherwise.
>
> **Gating rule (from validation):** do **not** ship Phase 5 (hard-holds) until the
> overdraft enforcement (R3), reconciliation semantics (R4) and idempotency (R5) items
> are designed and tested. Decide the reservation-vs-financial split (R8), the
> transition-storage model (R9), the reservation history model (N1), the capture
> transaction boundary (N2) and the two-table non-negativity guard (N3) in **Phase 0**,
> before any table is built.

## Core principle

**Every euro that exists or is committed is a real database row. Balances are always
derived by `SUM` over immutable rows — never stored as a mutable balance column.**
A cached balance column is the classic drift source; nobody may "optimize" by adding one.

Today's central problem: §45b's monthly 131 € allocations are *computed on the fly*
("virtual auto-renewal"), and "used" has four different definitions depending on the
call path. The north star removes derivation from reads entirely.

## Data model — two layers, three tables `[R8]`

The validation's most important structural correction: **a hold is not a *Buchung*.**
Reservations are an *operational* concern; only `consumed`/`reversed` are tax-relevant
GoBD bookings. We therefore separate the **operational reservation layer** from the
**financial ledger**, so routine plan/cancel churn never pollutes the audit trail and
GoBD immutability binds only the financial layer.

### 1. `budget_allocations` — "what exists" (credits)
Every allocation is a materialized row, **including** §45b's monthly statutory amount.
- Columns (conceptual): `customerId`, `budgetType`, `period`, `amountCents`, `source`
  (`statutory_monthly` | `initial_balance` | `carryover` | `manual_adjustment`),
  `validFrom`, `expiresAt`, audit fields.
- An allocation may be **uncapped** (the private pot): an explicit `uncapped` boolean
  flag, **never** a literal huge `amountCents`. `[R7]`
- **Allocated(pot, period) = `SUM(amountCents)`** over active capped rows.

### 2. `budget_reservations` — operational holds (NOT GoBD)
Mutable, sweepable reservations created at plan time. Not tax-relevant, not a *Buchung*.
- State: `hold → captured | released | expired`. Mutating these states is allowed
  (operational), but each transition is audit-logged (who/when/from→to). `[R9]`
- Columns: `appointmentId`, `occurrenceId`, `allocationId`, `budgetType`, `period`,
  `amountCents`, per-service breakdown, `state`, `idempotencyKey`, `expiresAt`,
  `capturedLedgerId` (set when `captured`).
- A hold can be **captured or released at most once** (post-or-void-once). `[R5]`
- **Capture is one local ACID transaction `[N2]`:** `hold→captured` writes the
  reservation update (`→captured` + `capturedLedgerId`) **and** the new `consumed`
  ledger row in a single same-database transaction under one idempotency key. Same DB →
  no saga/outbox needed; never split into two calls.

### 3. `budget_ledger` — financial bookings (GoBD-immutable, append-only)
Only `consumed` and `reversed` rows live here. Append-only: a correction is a new
`reversed` row plus a fresh `consumed`, never an in-place edit. `[R8][R9]`
- Columns: `appointmentId`, `occurrenceId`, `allocationId`, `budgetType`, `period`,
  per-service breakdown columns, `state` (`consumed` | `reversed`),
  `reversesLedgerId`, `transactionDate`, GoBD audit fields, `idempotencyKey`.
- GoBD immutability triggers + storno semantics + retention bind **this table only**.

### The single read formula (SSoT)
**`Available(pot, period) = Allocated − HoldsActive(reservations) − ConsumedNet(ledger)`**
where uncapped pots report `available = uncapped` (a flag), never a number `[R7]`.
Every surface reads this one function; the four conflicting "used" aggregations and
the four read algorithms collapse into one read layer, DTO in `shared/api/budget.ts`.

## Pots, cascade & the uncapped private pot

The statutory cascade is extracted into **one pure function** used by both reservations
and consumption:

```
planCascade(costCents, customerPots[], period) -> splits[]   // {pot, amountCents, uncapped?}
```

- `customerPots` is the per-customer, period-aware, priority-ordered list of enabled
  pots (from historized `customer_budget_type_settings`), with the **uncapped** private
  pot appended last when applicable. Overflow spills pot→pot.
- Statutory caps + carryover windows are applied via `computeCapSlot` inside
  `planCascade` only.
- `Σ splits.amountCents === costCents` exactly (subtract-last). An uncapped pot absorbs
  the entire remainder; its capacity is never read as a number anywhere. `[R7]`
- The **same** call backs both a `hold` and a `consumed` row — they differ only in which
  layer/state they land in. No selbstzahler fast-path, no per-pot cap re-implementation.

### Private / Selbstzahler = an uncapped pot (key insight)
| billingType / flag | pot order |
|---|---|
| `selbstzahler` | `[ private(uncapped) ]` |
| pflegekasse **+** `acceptsPrivatePayment = true` | `[ §45b, §45a, §39/§42a, private(uncapped) ]` |
| pflegekasse **+** `acceptsPrivatePayment = false` | `[ §45b, §45a, §39/§42a ]` — no private pot |

- With a private pot, overflow always lands there. Without it, `planCascade` cannot
  cover the remainder → the hold/booking is **refused (hard block)** — the product
  decision expressed purely as pot composition, no special-case branch.

## Reservation lifecycle & reconciliation `[R2][R4]`

### State machine (complete, including corrections) `[R2]`
- Reservation layer: `∅ → hold`; `hold → captured`; `hold → released`; `hold → expired`.
- Financial layer: `∅ → consumed`; `consumed → reversed`; correction =
  `consumed → reversed` **then** a fresh `∅ → consumed` (compound, explicitly allowed).
- **Reschedule across a period boundary** = release the hold in the old period, create
  a new hold in the new period (never silently move a row), **wrapped in one
  transaction**: if the new-period hold is refused, roll back the release so the original
  reservation stays intact — never leave the appointment with zero reservations. `[R2][N5]`
- The architecture test asserts exactly this set and rejects every other transition.

### Hold → consumed reconciliation (the pot-change problem) `[R4]`
Documented actuals will differ from the planned estimate. Rules:
- **(a) actuals ≤ hold:** capture the actual, **release the remainder** (partial capture).
- **(b) actuals > hold, still fits the same pots:** extend within the same pots.
- **(c) actuals > hold, overflow needs a different/private pot:** policy event —
  auto-spill to the private pot **only** for private-capable customers; otherwise raise
  a typed `OverBudgetCompletionError`. The operator's allowed resolutions are explicit
  `[N7]`: add a `manual_adjustment` allocation, downgrade the service, or book a
  documented write-off. The appointment can **never** silently vanish from conservation
  (I13/I20) — it stays surfaced by the orphan sweep until resolved.
- **Never silently re-pot already-performed work.** Each case is a golden test.

## Concurrency, overdraft & idempotency `[R3][R5][R6]`

- **Overdraft impossibility `[R3]`:** planning is read-then-write, a TOCTOU race. Holds
  are a NEW write path not covered by today's consumption lock. Enforce with **both**:
  (1) a per-`(customer, pot, period)` advisory lock held for the whole plan-and-write
  transaction (same serialization consumption already uses), **and** (3) a DB
  trigger/guard that refuses any hold or consume that would drive a **capped** pot
  negative. Because `Available` now spans two tables, a single-table `CHECK` cannot see
  it: the guard re-derives `Available` from **both** `budget_reservations` and
  `budget_ledger` inside the advisory-locked transaction. `[R3][N3]` Uncapped pots are
  exempt. §45b lazy materialization uses the same lock or an idempotent
  `INSERT … ON CONFLICT DO NOTHING`.
- **Idempotency `[R5]`:** every ledger/reservation-mutating op (plan, complete, cancel)
  carries an idempotency key unique per `(appointmentId, occurrenceId, intendedTransition)`.
  A unique constraint makes a duplicate a no-op, not a second row. Post-or-void-once is
  enforced: a closed hold rejects further transitions.
- **Orphan sweep `[R6]`:** holds have an `expiresAt` tied to the appointment lifecycle; a
  read-only reconciliation sweep flags holds whose appointment is terminal-but-uncleared
  so reserved budget is never lost in limbo.
- **Expiry vs late completion `[N4]`:** a *live* appointment's hold must **not** expire
  before completion (expiry is aligned to the appointment lifecycle). A genuinely late
  completion against an already-expired/swept hold is routed explicitly through the R4
  case-(c) reconciliation path — it must not silently hit the over-budget hard-block on
  work already performed.

## "Endless" / recurring appointments `[R12]`

Series are capped at **12 months / 365 occurrences**; each occurrence is a materialized
`appointments` row holding against **its own** period.
- Future-period allocation rows are created via **idempotent upsert** under the pot lock.
- To avoid lock contention / write-amplification, the up-to-365 occurrence holds are
  **bounded or materialized asynchronously** so a single series creation never holds the
  hot lock for a long write. `[R9][R12]`

## GoBD posture `[R8][R9][R11]`

- Immutability triggers, storno semantics and retention bind the **financial ledger
  only** (`consumed`/`reversed`). Reservations are operational and excluded from
  GoBD/financial exports. `[R8]`
- Financial transitions are **append-only** (correction = reversed + new consumed),
  the purest GoBD posture (changes are never silent / *nicht unbemerkt*). `[R9]`
- **Verfahrensdokumentation `[R11]`:** this north star is elevated into a formal process
  document an auditor can follow (data flow, reservation-vs-booking distinction,
  correction/storno, retention, immutability controls), referencing the current GoBD
  basis (BMF letters 11 Mar 2024 / 14 Jul 2025). Deliverable of Phase 0/6.

## What gets deleted (accidental complexity removed)
- Virtual §45b auto-renewal and everything it dragged in (`calculateAllocated45b`
  month-walking, anchor-flooring, auto-vs-initial / auto-vs-manual double-count guards).
- Legacy `customer_budgets` table + fallback reads (`getMonthlyBudgetAmountCents`,
  `getCustomerBudgetAmounts`). `customer_budget_type_settings` becomes the only config.
- The four read algorithms → one `readBudgetTypeSettings(mode)`.
- The four "used" definitions → the one read formula.
- The selbstzahler fast-path → the uncapped pot.
- Route-level transaction choreography & aggregation in `server/routes/budget.ts` →
  storage layer; budget DTOs hoisted into `shared/api`.

## What stays (irreducible — keep it)
- GoBD append-only + reversals (now scoped to the financial layer).
- Three statutory pots, statutory caps, §45b carryover window (Jan 1 – Jun 30).
- Temporal historization of settings (lookups by `transactionDate`).
- subtract-last rounding + `reconcileAppointmentLegFieldDrift`.
- DB-level immutability triggers, advisory-lock serialization (now extended to holds).

## Migration roadmap (phased; each phase ships behind an equality net + soak)

**Phase 0 — Decide & document the model `[R8][R9][N1][N2][N3]`.** Lock these *before* any
table is built (all hard to change later):
- reservation-vs-financial split + transition-storage model (append-only vs
  trigger-logged) `[R8][R9]`;
- **reservation history model `[N1]`** — append-only/bitemporal (replayable as-of a past
  date) vs. temporal guarantees scoped to the financial ledger only; this fixes what an
  auditor/disputed-booking review can reconstruct;
- **capture transaction boundary `[N2]`** — `hold→captured` is one local ACID transaction
  across both tables, one idempotency key, I13 cross-checks both sides (same DB → no saga);
- **two-table non-negativity guard `[N3]`** — the trigger/guard shape that re-derives
  `Available` from reservations + ledger under the advisory lock, so I14 is real.
Seed the Verfahrensdokumentation `[R11]`.

1. **Foundations + `planCascade`** — introduce the three-table model; extract
   `planCascade` (pure) used by current consumption (consume-only). Equality: bookings
   identical to legacy. Add the conservation verifier `[R1]`.
2. **Materialize §45b allocations** — backfill monthly rows (**batched, checkpointed,
   pause/resume, post-backfill reconciliation query** `[R12]`); switch §45b read to
   `SUM`; retire virtual auto-renewal. Equality at every `asOfDate`.
3. **Uncapped private pot** — replace the fast-path with the uncapped pot + `uncapped`
   flag `[R7]`; pot order from `billingType`/`acceptsPrivatePayment`. Equality
   (selbstzahler & overflow identical).
4. **Unified read SSoT + DTO hoist (moved earlier `[R10]`)** — collapse all surfaces onto
   `Available = Allocated − Holds − Consumed` and `readBudgetTypeSettings(mode)`; DTOs to
   `shared/api`. Lands **before/with** hard-holds so no surface disagrees about
   available-after-planned (kills the split-brain window F14).
5. **Hard-hold reservations** — **gated on R3/R4/R5.** Write `hold` rows on planning
   (incl. series, 12-mo horizon, async materialization); `hold→captured` on completion
   with the R4 reconciliation rules; `released` on cancel; overdraft structurally
   impossible; over-budget → uncapped pot if private else hard-block; orphan sweep `[R6]`.
6. **Kill fallback DB + cleanup** — **gated on a production shadow-read soak `[R10]`, not
   just green tests.** Run new + legacy in parallel on live reads, log per-customer drift,
   require a zero-drift soak window; legacy stays the source of truth until the gate
   passes (that is the rollback). Then drop `customer_budgets`, remove fallback reads,
   move route choreography to storage (absorbs proposed Task #108). Finalize the
   Verfahrensdokumentation `[R11]`.

**Per-phase rollback `[R10]`:** every phase keeps the legacy path callable and as the
source of truth until its soak passes; each phase documents its explicit revert.

---

## Validation & test specification (for independent verification)

Written so a separate AI/agent or reviewer can validate without re-deriving intent. Each
invariant is an assertable oracle; each phase has an acceptance gate and a runnable
checklist.

### A. Global invariants (must hold at every commit)

| ID | Invariant | How to assert |
|---|---|---|
| **I1 — SSoT identity** | `Available = Allocated − HoldsActive − ConsumedNet` for every `(pot, period)`; no read path derives or writes allocations. | Property test; grep that surfaces call the one reader. |
| **I2 — Allocations are rows** | `Allocated == SUM(budget_allocations.amountCents)`; exactly one `statutory_monthly` §45b row per month, no duplicates. | Equality vs legacy `calculateAllocated*` at many `asOfDate`s; uniqueness test. |
| **I3 — State machine (full)** `[R2]` | Reservations `∅→hold→captured\|released\|expired`; ledger `∅→consumed→reversed` + compound correction; reschedule = release+new-hold. Nothing else. | State-transition + architecture test rejecting all other transitions. |
| **I4 — Cascade conservation** | `planCascade` pure & deterministic; `Σ splits === cost` (subtract-last); priority fill; remainder only in last/uncapped pot. | fast-check property test. |
| **I5 — Hard-block vs private** | No private pot + insufficient statutory ⇒ typed refusal; else remainder lands in uncapped pot. | Property test both branches. |
| **I6 — Uncapped-pot equivalence** `[R7]` | Selbstzahler via `[private(uncapped)]` ≡ legacy fast-path; no numeric capacity ever read from an uncapped pot. | Golden test + grep/aggregate test. |
| **I7 — Hold/consume parity (equal inputs only)** `[N8]` | For **equal** actuals, the hold split and consumed split are identical (differ only by layer/state). All unequal-actuals cases are owned by I16, not I7 — tested as complementary, never overlapping. | Equality test (equal-input case only). |
| **I8 — Lifecycle conservation** | Plan→cancel ⇒ holds released, net reservation 0. Complete→cancel ⇒ consumed+reversed net 0 per service column (Task #754 invariant). | `tests/equality/storno-summe-null.test.ts` extended. |
| **I9 — Series horizon** | Holds for every materialized occurrence within 12-mo/365, none beyond; cancel releases future holds. | 12-mo series scenario test. |
| **I10 — Temporal correctness** `[R2][R8][N1]` | Holds/bookings/**reversals** at a past `transactionDate` bind to the settings, allocations and immutability rules valid then. If past `Available` must be reconstructable, the reservation audit-log is append-only/bitemporal (replayable as-of date); otherwise temporal guarantees are explicitly scoped to the financial ledger only. | Historization tests incl. reversal/correction path; as-of replay test if in scope. |
| **I11 — GoBD immutability** | No destructive mutation of the financial ledger; triggers cover `budget_ledger`; reservations excluded. | `tests/gobd-table-immutability.test.ts` extended. |
| **I12 — Money discipline** | No raw cents arithmetic outside `shared/utils/money.ts`; reconcile drift ≤ 1 cent/field. | Existing architecture test + reconcile property test. |
| **I13 — Conservation/reconciliation** `[R1][N2]` | Independently summed `Allocated − HoldsActive − ConsumedNet` equals the reader's `Available`; every consumed cent traces to an allocation draw-down; `reservations.capturedLedgerId ↔ ledger` rows cross-check (every captured hold has its ledger row and vice versa) — half-captured states are flagged. | Read-only prod verifier + CI property test. |
| **I14 — Overdraft impossibility** `[R3][N3]` | No interleaving of concurrent plan/complete can drive a capped pot below zero; the guard aggregates **both** `budget_reservations` and `budget_ledger` inside the advisory-locked transaction. | Parallel-writer stress test + cross-table trigger test. |
| **I15 — Post-or-void-once** `[R5]` | A hold transitions to captured/released at most once; replayed ops are no-ops. | Idempotency replay test (N times ⇒ single effect). |
| **I16 — Reconciliation semantics** `[R4]` | actuals ≤ hold, > hold same-pots, > hold cross-pot each match the documented rule; cross-pot over-budget raises the typed event, never silent re-potting. | Golden tests per case. |
| **I17 — Reservation/financial separation** `[R8]` | Released/expired holds never appear in GoBD/financial exports; only consumed/reversed do. | Export/audit snapshot test. |
| **I18 — No-drift soak** `[R10]` | Live shadow-read drift is zero across the soak window before any legacy deletion. | Production shadow-read dashboard + deletion gate. |
| **I19 — Reschedule atomicity** `[N5]` | A reschedule either moves the hold to the new period or leaves the original intact — never zero reservations. | Transaction test: refused new-period hold ⇒ original reservation preserved. |
| **I20 — No limbo** `[N7]` | A completed appointment is always either `consumed` or carries an open `OverBudgetCompletionError` surfaced by the sweep — never silently unbooked. | Sweep/scenario test over case-(c) non-private completion. |

### B. The equality net + shadow-read soak (migration safety oracle)
- **Equality/golden tests** before deleting any legacy path: capture legacy outputs for a
  customer matrix (selbstzahler; pflegekasse PG2–PG5 ±private consent; ±carryover;
  mid-month transition; past-dated bookings) at multiple `asOfDate`s; new must reproduce
  `Allocated`, `Available`, cascade splits, and `getBudgetSummary*` DTO fields byte-for-byte.
- **Production shadow-reads `[R10]`:** compute legacy + new for every real read, log
  per-customer diffs, alert on non-zero drift, require a clean **soak window** — not just
  a green corpus — as the deletion gate. Legacy stays source of truth until it passes.
- **Read-only verifier scripts** (prod-safe, no writes), pattern of
  `server/scripts/verify-45b-anchor-change.ts`, for I13 conservation against live data.

### C. Per-phase acceptance gates
| Phase | Done looks like | Gate |
|---|---|---|
| **0** | Reservation/financial split, transition model, reservation history (N1), capture boundary (N2) & two-table guard (N3) decided; Verfahrensdokumentation seeded. | Design doc/ADR reviewed & committed. |
| **1** | Bookings unchanged; one pure cascade fn; conservation verifier runs. | Equality vs legacy; I4 + I13 green. |
| **2** | One §45b row/month; virtual code gone; backfill batched + reconciled. | I2 equality + uniqueness; backfill reconciliation query zero-diff; grep removal. |
| **3** | Selbstzahler & overflow identical; fast-path gone; uncapped flag. | I5 + I6; grep removal. |
| **4** | One reader + one settings reader; DTOs in `shared/api`. | I1 architecture test; DTO exactness; OpenAPI drift gate. |
| **5** | Planning reserves budget; double-book impossible; over-budget blocked unless private; orphan sweep runs. | **R3/R4/R5 gated:** I7, I8, I9, I14, I15, I16; clock-injectable E2E plan→complete→cancel; parallel-writer stress. |
| **6** | `customer_budgets` dropped; no fallback reads; route choreography in storage. | **Shadow-soak gated:** I18 zero-drift window; grep zero `customer_budgets` reads; migration test. |

### D. Test taxonomy & where it lives
- **Equality/golden** — `tests/equality/`.
- **Property-based** (fast-check) for `planCascade`, conservation (I13), overdraft (I14),
  hard-block (I5) — `tests/equality/` or `tests/unit/`.
- **Concurrency/stress** (parallel writers) for I14/I15 — integration tests.
- **Scenario DSL** — reuse the budget scenario DSL for lifecycle/series.
- **E2E (clock-injectable)** — reservation lifecycle + carryover-expiry (Task #867 pattern).
- **Verifier + shadow-read scripts** (read-only, prod-safe) — `server/scripts/`.

### E. What an independent validator runs (executable checklist)
1. `npm run check` + `npm run test` — all green.
2. The phase's equality test(s) from C — zero drift vs legacy.
3. Property tests I4/I5/I13/I14/I15 — no counterexamples.
4. Concurrency stress for I14/I15 — no overdraft, no double effect.
5. Grep-assert deletion claims (no virtual §45b, no `customer_budgets`, no fast-path,
   single reader) for phases that claim removals.
6. Run the conservation verifier (I13) and the shadow-read drift report (I18) against a
   DB snapshot — `Allocated/Available` matches legacy within 0 cents.
7. GoBD: attempt a forbidden `budget_ledger` mutation ⇒ trigger refusal; confirm a
   released hold is absent from financial exports (I17).

## Open risks (residual after v2)
- **Toward true double-entry `[R1]`:** the model is a balance equation with a conservation
  verifier, not balanced debit/credit entries. Longer term, consider modeling the
  private/insurer side as real counter-accounts so writes must sum to zero structurally.
- **Async series materialization `[R12]`:** bounding vs. background-job tradeoffs for the
  365-occurrence hold write under the hot lock.
- **Backfill on live data `[R12]`:** batching/checkpoint tuning to avoid table locks/IO spikes.

## Relevant files
- `server/storage/budget/allocation-storage.ts`
- `server/storage/budget/consumption-engine.ts`
- `server/storage/budget/cap-calculator.ts`
- `server/storage/budget/summary-queries.ts`
- `server/storage/budget/import-availability.ts`
- `server/storage/budget/rebook-storage.ts`
- `server/storage/budget/transaction-storage.ts`
- `server/storage/budget/preferences-storage.ts`
- `server/storage/budget/appointment-cost-calculator.ts`
- `server/routes/budget.ts`
- `server/routes/appointments.ts`
- `server/routes/appointment-series.ts`
- `server/services/appointment-series.ts`
- `shared/domain/budgets.ts`
- `shared/domain/budget/cap-math.ts`
- `shared/schema/budget.ts`
- `shared/schema/appointments.ts`
- `server/storage/budget/types.ts`
- `docs/architecture/budget.md`
- `docs/budget-ssot-inventory.md`
