---
name: Billing pipeline "signed" bucket = billability gate
description: Why the status-pipeline "unterschrieben" stage uses the invoice billing-signature gate while the Termine list keeps the LN-inclusive "nachgewiesen" definition.
---

# Pipeline pre-invoice buckets reflect real billability

The €-view status pipeline (`readBillingPipeline` → `assignAppointmentStage` in
`shared/domain/billing-pipeline.ts`) routes a completed appointment to the
"Unterschrieben" (ready-to-invoice) stage ONLY when it is billable under the
SAME gate the invoice path uses (`isServiceRecordSignedForBilling`,
`shared/domain/billing-eligibility.ts`):
- Selbstzahler: `employee_signed` OR `completed` LN suffices.
- Pflegekasse: only `completed` (customer signature) counts.
- A direct appointment signature (`signature_data IS NOT NULL`) is a real
  customer signature ⇒ billable for both payer types.

A Pflegekasse appointment with only an `employee_signed` LN goes to the side
state `wartet_auf_kundenunterschrift` ("Wartet auf Kundenunterschrift") — its €
stays visible in the funnel but is NOT in the stage total, so the pipeline's
ready-to-invoice € reconciles with the eligibility readers' "Bereit zum
Abrechnen" customers.

**Why:** Before this, the pipeline's signed bucket used the `employee_signed`-
inclusive `documentedAndSigned` predicate, so euros appeared "signed" with no
matching billable customer below (the two surfaces used two different
definitions of "signed").

**How to apply:**
- `assignAppointmentStage` input is billing-aware: `billingType`,
  `hasDirectSignature`, `hasCompletedServiceRecord`,
  `hasEmployeeSignedServiceRecord` (NOT the old single `documentedAndSigned`).
- Keep the pipeline predicate in lockstep with `billing-eligibility` — never
  hand-roll the "customer-signed for Pflegekasse" rule.
- The **Termine list** (`termine-reader.ts`, "nachgewiesen" filter) DELIBERATELY
  keeps the LN-inclusive definition (`documentedAndSignedSqlRaw`, Task #1119):
  it passes the precomputed `documented_and_signed` as `hasDirectSignature` so
  `assignAppointmentStage` gives the old billability-independent mapping and the
  side state never appears there. Only the money view applies the payer gate.
- Side states keep grand-total conservation: `grandTotal = stageTotal +
  sideTotal`; the funnel stays total + disjoint (guarded by
  `tests/architecture/billing-pipeline-stage-identity.test.ts`).
- Client `status-pipeline-card.tsx` renders `pipeline.sides` generically (label
  from server `PIPELINE_SIDE_STATE_LABELS`); new side states need no client edit
  unless they must be clickable.
