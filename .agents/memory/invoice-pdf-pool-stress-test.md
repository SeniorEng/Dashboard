---
name: Invoice-PDF pool-stress negative test
description: Why the persistInvoicePdf pool-stress test must stagger its surge, and how it detects the render-in-held-tx regression.
---

# Invoice-PDF pool-stress negative test

Guards that an extreme invoice-render surge keeps the DB pool responsive, and FAILS if Phase 2 (render + object-storage upload) is moved back inside a held `db.transaction`.

## Two DISTINCT failure modes — don't conflate them
- **Phase-1 self-deadlock (NOT the regression):** `planInvoicePdfPersist` (Phase 1) opens a short `db.transaction` (connection A) and inside it does a nested read over the global `db` handle (`storage.getInvoice` ⇒ connection B). Firing >pool-size (max 20) persists in the *same tick* makes POOL_MAX plan-txns grab every slot, then each waits forever for a 2nd connection ⇒ pool deadlock — even with correct (non-regressed) code. This is a latent fragility, not the thing under test.
  - **Fix in the test:** STAGGER the surge (small per-call delay) so the short plan/commit phases don't all overlap, while the long renders still overlap far beyond pool size (`STAGGER_MS * SURGE_SIZE < renderDelayMs`).
- **Phase-2-in-held-tx (the regression):** if the render is wrapped in a held tx, each in-flight render holds a pooled connection for the whole render. The pool then *throttles* concurrent renders to ≤ POOL_MAX, AND unrelated `SELECT 1` reads block on connection acquire.

## How the regression is detected (deterministically)
Two independent signals fire:
1. **Headline:** an unrelated `SELECT 1` latency / `pool.waitingCount` blows its budget (sampler captures `renderActive`/`waiting` BEFORE the `await`, so the blocked sample is not filtered out of the deep window).
2. **Backstop sanity:** `maxActive` (peak concurrent renders) drops below POOL_MAX, because the pool can't run more renders than it has slots. In the correct code renders hold no connection, so `maxActive ≈ SURGE_SIZE > POOL_MAX`.

Assertion order matters for the *message*: check latency/waiting before the maxActive sanity so a regression is reported as "pool starvation / slow foreign reads," not the misleading "surge too small."

**Why:** in prod `PDF_RENDER_CONCURRENCY=2`, so this never bites live; the test deliberately bypasses the limiter (mocks the renderer) to exceed the pool.

## Verifying it in the agent harness
The validation harness re-triggers a fresh ~16-min `test` cycle within seconds of the previous one ending, so clean local `vitest` windows are nearly uncatchable (vitest worker count jumps 0→2 before a separate command can run). Don't burn turns racing it: confirm a single suspect file by checking it is ABSENT from the canonical `test`-workflow log's failure list, and run good-path/regression checks inside ONE command during a drain (no turn boundary mid-command). Known unrelated harness flakes: `tests/billing/bulk-print.test.ts` BP-2/BP-3 (60s Puppeteer timeouts under concurrent test+e2e+app load).
