---
name: Hard-hold reservations — gated engine testing
description: How the BUDGET_HARD_HOLDS-gated reservation engine is structured for testing and why HTTP-level tests can't reach it.
---

# Hard-hold reservation engine — gating & test reachability

The reservation engine (planHold/captureHolds/releaseHolds/rescheduleHold/sweepOrphanHolds)
is wired into the appointment lifecycle behind the env flag `BUDGET_HARD_HOLDS`
(`hardHoldsEnabled()`). Off by default = byte-identical legacy; legacy
`budget_transactions` stays SSoT for ConsumedNet.

**Why HTTP/e2e tests can't exercise it:** the flag is read in the *server* process,
and the test/e2e server starts via `NODE_ENV=test tsx server/index.ts` WITHOUT the
flag. So every gated branch in routes (appointments create/PATCH/delete/reopen,
appointment-documentation) is a no-op over HTTP. Setting `process.env.BUDGET_HARD_HOLDS`
inside a vitest test does NOT affect the already-running server.

**How to integration-test the engine:** call the engine functions DIRECTLY against
`db` from a vitest integration test (engine gating is caller-side, the functions
themselves don't early-return on the flag). Seed via `setupBudgetScenario` (HTTP),
use `document: false` to keep an appointment in `scheduled`, then call `planHold`
etc. against `db`. For `captureHolds`, document the appointment over HTTP first
(creates legacy consumption rows the ledger mirrors), then run captureHolds in a
`db.transaction`. See `tests/budget/hard-holds-engine.test.ts`.

**Document payload gotcha:** the working appointment-document payload does NOT send
`signatureData` (sending a too-short PNG triggers signature validation → 400). Copy
the scenario helper's shape: `actualStart` + `travelOriginType:"home"` + km fields +
services `{serviceId, actualDurationMinutes, details}`.

**Release-on-delete relies on the orphan sweep:** `budget_reservations.appointmentId`
has NO onDelete cascade, but appointments are SOFT-deleted, so the FK never breaks.
Release wiring covers the single-appointment lifecycle; series-cancel paths (not in
clean transactions) intentionally lean on `sweepOrphanHolds` (reason
`appointment_cancelled`/`appointment_deleted`) rather than per-path release.

**idempotency_key must be revision-scoped (I19 trap):** `budget_reservations.idempotency_key`
is GLOBALLY unique. A naïve key `hold:a{id}:o{occ}:{bt}` breaks reschedule: after
releaseHolds flips old rows to `released`, the re-plan reuses the same key →
`onConflictDoNothing` swallows the insert → fallback re-read (filters `state='hold'`)
finds nothing → NO new hold ever created. Fix: append a `:r{revision}` where revision =
count of ALL existing reservation rows (any state) for that appointment+occurrence+budgetType.
True replay (no release) is short-circuited earlier by the active-hold check, so the
revision only bumps after a real release/capture.

**`.replit` dev userenv leaks `BUDGET_HARD_HOLDS=1` into the ephemeral test server (Task #945 trap):**
`.replit` sets `BUDGET_HARD_HOLDS = "1"` under `[userenv.development]` for the dev app. The
ephemeral-DB test orchestrator (`scripts/with-ephemeral-db.ts`) inherits the ambient env when
spawning its per-worker app-servers, so the flag silently turns ON in tests — but CI never sets
it. With the flag ON the gated route hooks fire (planHold at appointment create → 422
BUDGET_HARD_BLOCK; captureHolds at documentation), which breaks both the direct-engine tests
(which assume the legacy path) and any slot-creation test that fits a tight budget. The
orchestrator therefore explicitly `delete baseEnv.BUDGET_HARD_HOLDS` so every worker server +
the vitest process match CI (flag OFF). **Why:** unsetting is safe precisely because HTTP/e2e
can't reach the gated branches anyway (see top of file) — no test needs the flag ON.

**captureHolds reconciliation headroom must add back THIS appt's actual (R4/I16 trap):**
captureHolds runs AFTER legacy consumption is written in the same tx, so
`readUnifiedBudgetAvailability` already subtracts BOTH this appointment's active hold
AND the just-booked actual consumption. Feeding that raw availability as
`samePotHeadroomCents` understates headroom → a valid case-b (same_pot_extend) is
misclassified as case-c → false `OverBudgetCompletionError`. Fix: `samePotHeadroom =
Σ availableCents(statutory pots) + Σ|amountCents| of THIS appt's statutory consumption rows`.
Algebraically exact (availableCents = cap − otherCons − otherHolds − thisHold − thisCons;
adding thisCons back yields the free-beyond-hold headroom the classifier expects).
