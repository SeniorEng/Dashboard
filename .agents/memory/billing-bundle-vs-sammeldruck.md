---
name: Billing Bündel-Druck vs Sammeldruck
description: Two intentionally-separate bundled-PDF features in /admin/billing — do not consolidate them.
---

# Two distinct bundled-PDF features in billing

There are TWO separate "bundle the PDFs" features in `/admin/billing`. They look
similar by name but serve different scopes — keep them separate.

- **Bündel-Druck** (`GET /api/billing/:id/bundle`): per *single* invoice. Combines
  that one invoice's PDF + its Leistungsnachweis into one PDF. UI = per-row link
  (`<a target="_blank">`, testid `button-bundle-<id>`) inside the row overflow menu.
- **Sammeldruck** (`POST /api/billing/bulk-print`): *all* draft invoices of the
  selected month at once. Returns one merged PDF, or a ZIP with one PDF per
  Krankenkasse when `groupByPayer` is set. Also marks every bundled invoice
  "versendet" (same path as `/send-bulk`, audit source `bulk_print`). UI = action-bar
  button `button-bulk-print` + `BulkPrintDialog`.

**Why:** A future "let's deduplicate the bundle code" pass could wrongly merge these.
They share PDF helpers (combinePdfBuffers, loadInvoicePdfFromStorage,
renderLeistungsnachweisOnTheFly) but differ in scope (single vs month-wide) and
side effects (bulk-print mutates status, /bundle is read-only).
