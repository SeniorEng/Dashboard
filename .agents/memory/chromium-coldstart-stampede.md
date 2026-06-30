---
name: Chromium cold-start stampede mitigation
description: Why prod PDF launches time out on Autoscale and which boot-time levers de-stagger them without touching render/GoBD determinism.
---

# Chromium cold-start stampede (prod PDF launch timeouts)

In production (Autoscale) PDF launches reliably hit the 60s launch timeout, with
`network_service_instance_impl.cc … Network service crashed, restarting service`
in the logs. That log line is a **symptom**, not the cause.

**Root cause:** Autoscale scales from 0 and boots several instances at once. Each
instance prewarms Chromium and reads the binary + its shared libs **cold** from
the same `/nix/store` image layer simultaneously → disk-I/O contention makes
every single `puppeteer.launch` slow enough to breach the (intentionally NOT
lowered) 60s timeout. Classic cold-start stampede.

**Built levers** (all non-blocking, best-effort; prod defaults only, dev/test=0):
- (a) Jitter before boot pre-warm — `CHROMIUM_PREWARM_JITTER_MS` (prod ~8s).
- (b) DB advisory lock to coordinate across instances (the DB is the only shared
  resource) — `pg_try_advisory_lock` (never blocks boot); losers wait a bounded
  `CHROMIUM_PREWARM_LOCK_WAIT_MS` then warm anyway. Both in `server/index.ts`.
- (c) Page-cache warming of binary + `ldd` libs before the first launch —
  `warmChromiumBinaryCache()` in `pdf-generator.ts` (1-MiB window, idempotent).
- (d) Bounded retry w/ jittered backoff inside `prewarmBrowser()` —
  `CHROMIUM_PREWARM_MAX_ATTEMPTS`/`CHROMIUM_PREWARM_RETRY_DELAY_MS`.

**Why these and not others:** must NOT lower the 60s timeout and must NOT touch
render path / `pdf_hash` / ZUGFeRD byte-stability / `pipe=true` / getBrowser
singleton / withFreshPage / render semaphore / background-retry / stderr
ring-buffer. `--single-process` stays a pure env-override (prod default OFF) — it
only masks the network-service restart and is itself a crash source under memory
pressure.

**How to apply / next time:** if prod PDFs time out again after these levers are
already live, first confirm it's a fresh stampede vs a stale build (re-publish),
and check `/api/health → chromium`. The structural root-fix (out of scope, only
documented in `docs/pdf-chromium.md`) is moving PDF off Autoscale to a **Reserved
VM** (permanently warm ⇒ no boot stampede) — a cost/ops decision, not code.

**Verified live (post-publish):** after the levers shipped, boot prewarm
succeeds (de-stagger boot lines present), `/api/health → chromium` flips to `ok`,
the startup PDF backfill renders stuck invoices, and live invoice generation runs
fine (steady `ZUGFeRD PDF eingebettet … PDF/A=true | XML=true`). 60s LAUNCH
timeouts collapsed from ~every-launch to ~1/hr (mid-life re-launches, not boot
stampede) — do NOT tune the boot jitter/lock for those.

**New bottleneck once launches are fixed:** the nightly integrity sweep
(`verifyRecentInvoiceIntegrity` → `verifyInvoiceIntegrity`) re-renders EVERY
invoice of the last 30 days serially through Chromium *only to extract the
ZUGFeRD XML for comparison* (the PDF-hash check uses stored bytes, not the
re-render). Under contention with live generation these re-renders hit the 15s
navigation / 30s render timeout en masse. It's a background-job design cost, not
a launch-stampede regression and not data corruption (timed-out invoices are
just skipped, no false drift). Fix = reconstruct the XML without a full Chromium
render, or throttle/serialize the sweep off the live render path.
