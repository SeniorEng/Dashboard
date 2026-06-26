---
name: Billing breakdown hours SSoT (0,0h fix)
description: Why /admin/billing per-period hours must read invoice line-items for late stages, mirroring the pipeline reader's hybrid breakpoint.
---

# Billing breakdown hours (0,0h bug)

The per-period breakdown table on `/admin/billing` must show hours that DON'T drop to
0,0h once an appointment is invoiced/paid.

**Why:** appointment-based hour aggregation only counts appts in status
`completed`/`documented`. Once an appt is invoiced it leaves the appointment stages
(`assignAppointmentStage` → `excluded: invoiced`), so its hours vanish from any
appt-only sum. Late-stage hours therefore come from
`invoice_line_items.duration_minutes` via `computeMinutesByInvoiceStage`.

**How to apply:** any reader composing this table MUST mirror the pipeline reader's
hybrid breakpoint EXACTLY — early stages from appointments, late stages from
non-storno invoices — and use the SAME invoice cents field (`netAmountCents`) and the
SAME `assignAppointmentStage`/`assignInvoiceStage`. Then €-conservation holds by
construction: Σ breakdown rows === `summarizePipelineCents().stageTotalCents`, because
`aggregateBreakdownUnits` only keeps `assignment.kind === 'stage'` units (side/excluded
contribute nothing). Pure logic lives in `shared/domain/billing-breakdown.ts`; km is
carried raw and quantized once at display via `quantizeKm` (no double rounding).
