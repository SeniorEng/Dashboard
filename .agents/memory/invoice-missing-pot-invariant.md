---
name: Kasse "missing pot" invariant firing condition
description: How to actually trigger the generateInvoiceCore missing-budget-pot safeguard (it's narrower than it looks)
---

The erstellungs-zeit invariant in `generateInvoiceCore` fires when
`isKasseInvoice && !singlePotBudgetType`. Reaching it for a real kasse customer
is narrower than the name suggests:

- In the single-invoice path (after the `needsBudgetSplit` branch) `potItems`
  has size ≤ 1. A single **private** pot sets `singlePotIsPrivate` → the invoice
  is **reclassified to selbstzahler**, so it is no longer a kasse invoice and the
  invariant does NOT fire.
- Therefore the only way to fire it in the single path is **empty `potItems`**,
  i.e. **empty line items**.

**How to produce empty line items for a kasse customer:** set the appointment to
`status='customer_no_show'`. For kasse customers no `cancellationPolicy` is loaded
(it's selbstzahler-only), so `buildLineItemsFromAppointments` hits
`if (cancellationPolicy && …)` = false → `continue` → no line item at all
(`noShowChargeSuppressed` isn't even needed).

**Why:** without this, the renderer would silently stamp the §45b wording onto an
invoice that bills a different/no pot. The §45a-only case does NOT hit the
invariant — it resolves to `umwandlung_45a` and is correctly stamped; the
invariant is purely the defensive guard for the truly-unresolvable (empty) case.

**Obsolete contract:** before this change a single-pot kasse invoice carried
`budgetType=null` (the "Legacy"/render-time-fallback path). That contract is dead
for NEW invoices — single-pot §45b/§45a kasse invoices are now stamped with their
real pot. Any test asserting a single-pot kasse invoice has no pot marker is
stale (the render-time §45b fallback now only applies to already-sealed legacy
invoices whose snapshot budgetType is null).

**How to apply:** integration test pattern — create+document a kasse appointment
(so it links into the signed Leistungsnachweis at SR creation), sign the SR, then
`db.update(appointments).set({status:'customer_no_show'})` and call
`generateInvoiceCore` directly. Asserts 400/AppError + an
`invoice_creation_pot_unresolved` audit row (entityType `customer`,
entityId=customerId, metadata.billingType=the kasse type).
