---
name: customer-detail page route split
description: Two distinct customer-detail pages/routes; which one carries which widgets (e.g. §45b FIFO bar)
---
There are TWO separate customer detail pages, each its own file and route:
- `/customer/:id` → `client/src/pages/customer-detail.tsx` (employee-facing detail; carries the §45b FIFO breakdown bar `data-testid="fifo-breakdown"`)
- `/admin/customers/:id` → `client/src/pages/admin/customer-detail.tsx` (admin detail; does NOT render the FIFO bar)

**Why:** an e2e smoke test for the §45b FIFO bar initially navigated to `/admin/customers/:id` and the bar never appeared — it only lives on `/customer/:id`.

**How to apply:** before asserting (or wiring) a customer-detail widget, confirm WHICH of the two pages renders it; don't assume `/admin/customers/:id` mirrors `/customer/:id`.
