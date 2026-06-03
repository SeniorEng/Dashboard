---
name: Budget hard-block production cutover
description: How the BUDGET_HARD_HOLDS overdraft hard-block is enabled in production and guarded against silent regression.
---

# Budget hard-block (BUDGET_HARD_HOLDS) production enablement

The overdraft hard-block (422 BUDGET_HARD_BLOCK on booking that overdraws a
non-private-paying customer) is gated by `hardHoldsEnabled()` (env
`BUDGET_HARD_HOLDS` === "1"/"true"). It is enabled in BOTH the `development` and
`production` Replit env scopes (mirrored into `.replit` `[userenv.*]`).

**Why production-scoped (not gate removal):** removing the gate would break the
test contract — the ephemeral-DB orchestrator strips `BUDGET_HARD_HOLDS` so the
HTTP test server stays legacy while `tests/budget/hard-holds-engine.test.ts`
drives the engine directly against the DB. So enable the flag in prod, keep the
gate.

**How to apply / set env:** you cannot edit `.replit` directly (blocked). Use the
environment-secrets tooling (`setEnvVars({values:{BUDGET_HARD_HOLDS:"1"}, environment:"production"})`)
— it writes the `[userenv.production]` section for you.

**Regression guard:** `tests/architecture/budget-hard-holds-production-enabled.test.ts`
(pure `.replit` read, unit project) fails if neither production nor shared scope
sets the flag truthy. Runtime visibility: `/api/health → budgetHardHolds.enabled`;
prod startup logs loudly if the flag is missing.

**Publish caveat:** the env change only takes effect after a re-publish of the
deployment from the main version (task agents cannot publish).
