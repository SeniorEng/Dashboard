---
name: storage.getInvoice JOIN-alias trap
description: storage.getInvoice overrides invoice.customerName with customers.name — any code that re-renders from a raw invoicesTable select will drift against PDFs persisted via storage.getInvoice.
---

`server/storage/billing-storage.ts → getInvoice(id)` does a JOIN onto `customers` and **spreads `customers.name` over `invoice.customerName`** in the returned object. The raw `invoices.customer_name` column is silently shadowed.

This matters for any "render twice, compare" flow:
- The PDF/ZUGFeRD persistence path (`persistInvoicePdfInner` → `buildInvoicePdfBytes` → `buildPdfData`) reads the invoice via `storage.getInvoice`, so the persisted XML contains `customers.name` ("Nachname, Vorname").
- A verifier or backfill that selects `from(invoicesTable)` directly gets the **raw** `invoices.customer_name` field (whatever was written at /generate, e.g. "Vorname Nachname"). Same `buildPdfData`, different `invoice.customerName` → byte-different XML → false-positive integrity drift.

**Why:** the override predates the integrity verifier and exists because legacy code consumed `customerName` as the display name; switching it now would ripple through dozens of call sites.

**How to apply:**
- Anything that re-renders an invoice (PDF, ZUGFeRD XML, leistungsnachweis) MUST load the invoice via `storage.getInvoice`, not a direct Drizzle select on `invoicesTable`. Otherwise asymmetric inputs to `buildPdfData` will drift.
- If you ever do need the raw `invoices.customer_name` (e.g. for an audit/repair tool), read the column explicitly and don't reuse it with `buildPdfData`.
- Drift detector: `tests/billing/zugferd-persistence.test.ts` (ZFP.1 catches false positives, ZFP.2 catches real tampering).
