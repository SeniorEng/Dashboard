---
name: Fresh ephemeral-DB test fragilities
description: Test patterns that pass on the old shared dev DB but break on a fresh low-id ephemeral DB, and the robust replacements.
---

# Fresh ephemeral-DB test fragilities

When the suite runs against a per-run **fresh** ephemeral DB (low, freshly-reset
id sequences) instead of the old shared dev DB (huge, divergent id ranges),
several previously-green tests fail. The failures are NOT logic regressions —
they are fragile test assertions that only held by luck on the old data.

## Cross-table id collisions

**Rule:** Never assert "entity A is/ isn't present" by comparing a raw `id` from
one table against rows from a *different* table. `prospects.id` and
`customers.id` are independent sequences; on a fresh DB both start low and a
prospect id of 10 collides with an unrelated customer id of 10.

**Why:** On the old dev DB customer ids were in the hundred-thousands and
collisions were astronomically unlikely, so the bug was invisible. Fresh DB makes
collisions routine → false positives/negatives.

**How to apply:** Match on a unique *business* field instead (the test's unique
`nachname`/email/`uniqueId()` value), e.g. EB-7.1 in `tests/erstberatung.test.ts`
checks `c.nachname === nachname`, not `c.id === prospectId`.

## Wrong endpoint masked by always-404

`GET /api/admin/customers/:id` (bare) does NOT exist — only sub-routes like
`/customers/:id/insurance`. The real single-customer detail is
`GET /api/customers/:id`. A test hitting the bare admin path always 404s; it only
*looked* order-sensitive. Verify the route actually exists before assuming a 404
means the record was deleted (cross-check via the list endpoint).

## Proportional km-split sums drift by 1 ULP

**Rule:** In budget storno-symmetry / equality tests, the fractional km columns
(`travelKilometers`, `customerKilometers`) are split *proportionally across pots*
(Cascade §45b→§45a). After storno + identical re-booking the pot proportions
differ minutely, so the summed split parts drift by ~1 ULP (IEEE754, non-
associative). Compare km column sums with `toBeCloseTo(expected, 6)`, NOT `toBe`.
Keep cents/minutes columns on exact `toBe` — they are integers.

**Why:** A forgotten/non-negated column would be off by whole km/cents, so a
6-digit tolerance still catches real regressions; exact equality only ever caught
floating-point noise. This drift surfaces in the full multi-worker run but NOT in
single-file isolation (pot state differs by context), so it looks "flaky".

## PDFH.1 / Chromium under PID pressure

`tests/billing/pdf-hash.test.ts` PDFH.1 (`pdf_hash` NULL) is a real *environment*
flake, not a DB issue: Chromium fails to spawn (`libnss3.so cannot open`, zygote
FATAL) when the agent harness runs `test`+`e2e-smoke`+`Start application`
concurrently and blows the cgroup pids ceiling. Green in CI (isolated jobs) and
in single-file isolation. Do NOT weaken the assertion — registered in
`docs/flaky-tests.md`.
