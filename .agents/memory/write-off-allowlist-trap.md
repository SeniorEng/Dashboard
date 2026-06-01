---
name: write_off classification allowlist trap
description: Why moving budget code that touches write_off+transactionType into server/ or shared/ breaks an architecture test, and how to satisfy it.
---

Any `.ts` file under `server/` or `shared/` that contains BOTH a `'write_off'`
string literal AND `transactionType` is scanned by
`tests/architecture/budget-write-off-classification.test.ts` and MUST be listed
in that test's `ALLOWLIST` with a view classification, AND get a matching row in
the audit table in `docs/budget-ssot-inventory.md` (§1.4). Only `tests/` and
`server/scripts/` are excluded from the scan.

**Why:** `write_off` is asymmetric — it counts as Used in the topf/allocation
view but NOT in the window-cap view. The allowlist forces each new call-site to
declare which view it uses so the two are never accidentally conflated.

**How to apply:** When extracting/moving budget aggregation logic OUT of an
excluded dir (e.g. `server/scripts/` → `server/lib/`), the move alone trips the
test. Add the file to `ALLOWLIST` (`allocation-view` for no-overdraw / pot
sums, `window-view` for fenster-cap, `both`, or `schema-only`) and append the
audit-table row. A no-overdraw conservation check is `allocation-view`.
