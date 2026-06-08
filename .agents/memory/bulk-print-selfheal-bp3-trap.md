---
name: Bulk-print error-isolation tests vs persistInvoicePdf self-heal
description: Why "unrenderable invoice" tests (bogus pdfPath pointing at a missing object) no longer fail the bulk-print/per-payer print loop.
---

persistInvoicePdf gained a self-heal: when an invoice's stored PDF object is
MISSING (storedObjectIsMissing(invoice.pdfPath)), it transparently RE-RENDERS
the invoice instead of erroring.

**Consequence:** any test that fabricates an "unrenderable" invoice by setting a
bogus `pdfPath` to a non-existent object no longer triggers an error in the
bulk-print (`POST /bulk-print`) or per-payer (`GET /bundle-by-payer`) loops — the
invoice self-heals, prints fine, and the per-invoice error count is 0. A
record-less invoice also does NOT throw: renderLeistungsnachweisOnTheFly emits an
empty LN. And getInvoices/getInvoice INNER JOIN customers, so deleting the
customer drops the invoice out of the drafts list entirely (test breaks
differently) rather than making it fail to render.

**How to apply:** to deterministically exercise the per-invoice error-isolation
path (one invoice fails, run continues, classified reason lands in the
`x-bulk-print-summary` header), you must inject a real render fault keyed to a
specific invoice — the global per-request `x-test-inject-fault` seam
(server/lib/test-fault-injector.ts, maybeFail) is NOT invoice-targeted and is not
wired into the bulk-print render loop. Adding an invoice-targeted seam is the
clean route but is production-code scope.

**Why:** the message-only classification change (classifyPdfRenderError applied to
both print routes) is correct and orthogonal to this; bulk-print.test.ts BP-3
fails identically on baseline with that change reverted — it's pre-existing
breakage from the self-heal, not a regression.
