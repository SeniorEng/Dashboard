---
name: billing-flow Selbstzahler-create flake under workspace-overload loop
description: Why BF-9.1/10.3/10.4/10.7/10.9 fail together in the agent env but are green in isolated CI
---

When the agent workspace falls into the multi-workflow restart loop (Start application
+ billing-cov + e2e-smoke + lint + test + typecheck all relaunching together every ~60s,
the documented workspace-overload / legacy-`Project`-boot scenario), the orchestrated
`test` workflow shows a cluster of billing-flow failures that are NOT logic regressions.

**Canary:** `BF-9.1 — Selbstzahler-Rechnung wird als entwurf erzeugt` is a pre-existing
test whose whole job is just "create a Selbstzahler invoice as draft". When it fails,
every test that calls the `createDraftSzInvoice` helper fails with it (BF-10.3, BF-10.4,
BF-10.7, BF-10.9, …). Root cause = Selbstzahler-invoice creation does a PDF render +
object-storage write + DB-pool work, which times out / 500s under the overload contention
(see ci-background-pdf-pool-stampede, invoice-pdf-pool-stress-test).

**Distinguishing flake from real bug:** a test that shares the SAME route/SSoT gate but
does NOT need a freshly-created invoice to succeed stays green. Concretely BF-10.8
(bezahlt→entwurf rejected 400) passed while BF-10.7 (versendet→entwurf success path)
failed in the same run — same `PATCH /:id/status` + `isAllowedInvoiceStatusTransition`
gate. If the gate/route were broken BOTH would fail. So a green sibling on the same code
path + a red BF-9.1 canary == environmental, not a defect.

**Why:** the agent env cannot reproduce isolated CI; the platform keeps relaunching the
6-workflow boot so no orchestrated `test` run survives the ~3min billing-flow needs.

**How to apply:** don't chase these as code bugs and don't add your own orchestrator run
(it just worsens the loop and gets killed mid-run). Verify reset-to-draft (and any
billing-flow) correctness via: typecheck+lint green, the green same-route sibling test,
e2e-smoke billing checks, and ultimately the isolated GitHub Actions pipeline — not the
agent-env harness aggregate.
