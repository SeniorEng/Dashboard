---
name: reconcile import-drift stornoedInvoiceIds semantics
description: What RepairSummary.stornoedInvoiceIds does and does not contain for a multi-pot split
---

`reconcile()` in the import-drift repair script reports in
`RepairSummary.stornoedInvoiceIds` ONLY the invoice it directly resolved/targeted
per appointment (one per appointment). For a multi-pot split, the pot-sibling
invoice(s) that share the same `billing_run_id` are cancelled via the storno
**cascade** (`stornoInvoiceCascade`) but are NOT pushed into
`stornoedInvoiceIds`.

**Why:** the summary counts the targeted repair actions; the cascade is an internal
consequence of stornoing the target. So `stornoedInvoiceIds` on a 2-pot split is
`[targetId]` (length 1), not both original ids.

**How to apply:** to assert "both pots cancelled", read invoice `status='storniert'`
from the DB for all original ids; to assert "only intended", check every id in
`stornoedInvoiceIds` is a subset of the drift customer's originals. Don't expect the
array to equal the full set of pot originals. The per-pot `stornorechnung` count
(invoiceType='stornorechnung') equals the number of pots — assert that separately.
The cascade DOES propagate `auditMetadataExtra` (reason/batchId/task="#1651") into
the `invoice_cancelled` audit of BOTH the main and cascade-stornoed siblings.
