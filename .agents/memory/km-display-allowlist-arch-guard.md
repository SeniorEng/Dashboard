---
name: km-display-via-helper allowlist
description: New UI that renders raw km aggregates must be added to the km-display arch-test allowlist.
---

Any client file that renders a `${...} km` template string (e.g. a per-employee/per-month
kilometer aggregate) trips `tests/architecture/km-display-via-helper.test.ts`, which forbids
hand-formatted km outside the invoice-line-item helper.

**Why:** the guard exists so invoice line-item km always flow through the single
`renderLineItemQuantity`/`quantizeKm` helper (display==booking). Pure display aggregates that
are NOT invoice lines are legitimate but must be explicitly allowlisted.

**How to apply:** when consolidating/adding an admin page that shows km sums (not invoice
lines), add its path to `ALLOWED_PATHS` in that arch test. When DELETING such a page under the
Ersetzungs-Regel, replace its allowlist entry with the successor page — don't just remove it,
or the successor (if it displays km) fails the guard.
