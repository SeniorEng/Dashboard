---
name: Loaded invoices return the frozen snapshot customer name
description: getInvoice/getInvoices resolve customerName from the render snapshot, not live customers.name — GoBD byte-stability.
---

When loading invoices, the customer name comes from the **frozen render snapshot** (`snapshot?.customer?.name`) and only falls back to the live `customers.name` JOIN when the snapshot lacks one. The verifier and any re-render must build from the snapshot too.

**Why:** GoBD integrity — a sealed invoice's PDF/hash was generated against the customer name as it was at issue time. Reading the live name later would drift the re-rendered/verified document away from the sealed bytes. (Note this is the OPPOSITE pull from `storage.getInvoice`'s historical JOIN-alias that OVERRODE invoice.customerName with the live name — see storage-get-invoice-customername.md.)

**How to apply:** `server/storage/billing-storage.ts` (getInvoice/getInvoices) returns `snapshot?.customer?.name ?? live`. The orchestrator's snapshot branch (`buildInvoicePdfData`) only sets `pdfData.customerName` from the snapshot when it's non-empty. Don't "fix" these to read live names — it will re-introduce hash drift on re-render.
