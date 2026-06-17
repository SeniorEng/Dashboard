---
name: billing coverage-gate floor & hard-holds leak
description: Why the billing targeted coverage-gate floor is low (single-file scope) and why its spawned dev server must strip BUDGET_HARD_HOLDS.
---

## The gate spawns its own dev server — strip BUDGET_HARD_HOLDS
The "server"-mode targeted coverage gate launches its OWN development-mode app
server and drives it over HTTP. `BUDGET_HARD_HOLDS` is set in `.replit`
`[userenv.development]`, so it leaks into every dev-mode process the gate spawns.
The test orchestrator deliberately deletes that var before starting its servers;
the gate must do the same.

**Why:** with hard-holds ON, low-budget appointment fixtures get hard-blocked at
appointment CREATION, so slot-finding test helpers spin until a timeout — the
documented gate command appears to "hang" for reasons that have nothing to do
with coverage. **How to apply:** any new self-spawned-dev-server tooling that
seeds budget/appointment fixtures must strip `BUDGET_HARD_HOLDS` to match the
orchestrator, or expect false timeouts.

## The billing floor is honestly low because it measures one file
The billing gate reports far below an aspirational 55/45 floor (~Lines 25 /
Branch 44) and that is CORRECT, not a regression.

**Why:** the gate instruments the whole billing route module but exercises it
with only the single front-half read/generate flow test. The heavy
bulk/send/batch routes are covered by their own dedicated sibling test files, not
by the one file the gate measures, so they read as "uncovered" here. On top of
that, this gate auto-skips in GitHub-Actions CI (no object-storage sidecar), so
the floor never actually enforced anything there and the aspirational number was
unreachable by the measured file anyway.

**How to apply:** recalibrating such a floor DOWN to (measured − ~5%) is honest
when the uncovered code is provably tested elsewhere — confirm that before
lowering, and never lower merely to mask a real coverage drop. To legitimately
RAISE the floor instead, add the HTTP-driven (TEST_BASE_URL) sibling tests to the
gate's test list — direct-import tests run in the worker and do NOT contribute to
the spawned-server coverage. Before blaming a low number on
starvation/pollution/object-storage, prove it: a quiet run with object storage
present and hard-holds stripped yields the same figure.
