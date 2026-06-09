---
name: Invoice cumulative line aggregation render-gate
description: How invoice PDF/ZUGFeRD line cumulation is gated per-invoice for GoBD byte-stability
---

Invoice (Rechnung) PDF + embedded ZUGFeRD/EN-16931 XML render line items CUMULATED
(one line per service type = serviceCode+unitPrice+unit; ONE merged "Fahrtkosten"
line for travel_km+customer_km; no_show_charge stays per-appointment; Datum/Uhrzeit
columns dropped). Leistungsnachweis (LN) stays per-appointment. Persisted
invoice_line_items are UNCHANGED (still per-appointment, keep appointmentId) —
aggregation happens ONLY at render/XML layer.

The one source is the pure `aggregateInvoiceLineItems()` in
`shared/domain/invoice-line-aggregation.ts`, consumed by BOTH `generateInvoiceHtml`
(server/lib/pdf-generator.ts) and `buildZugferdData` (server/lib/zugferd.ts). Any
new invoice render/XML path MUST go through it, or PDF and XML drift apart.

**Why the per-invoice gate:** `invoice-integrity-verifier.ts` re-renders sealed
invoices and compares XML/pdf_hash byte-for-byte. So the mode is frozen per invoice
in `InvoiceRenderSnapshot.lineAggregation` (same sealing pattern as `profile` /
`pdfCreationDate`): undefined ⇒ default `"per_appointment"` (legacy invoices stay
byte-identical), `"cumulative"` ⇒ sealed on all NEW invoices. The verifier/self-heal
pass the snapshot, so existing invoices reproduce their original bytes.

**How to apply:** new render path → set `pdfData.lineAggregation` from
`snapshot?.lineAggregation ?? "per_appointment"` when a snapshot exists, else
`"cumulative"`; seal `lineAggregation: "cumulative"` whenever you write a fresh
`renderSnapshot`. Σ(totalCents) is bit-exact (additive grouping only, never
recompute qty×price), so ZUGFeRD reconciliation (LineTotalSum==net) + BR-CO-10/13
hold. EN-16931 schematron does NOT validate qty×price per line, so the aggregated
Menge×Satz≈Betrag rounding cosmetic is acceptable.
