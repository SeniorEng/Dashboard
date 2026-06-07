---
name: Leistungsnachweis customerAddress binding
description: Why the LN "Leistungsempfänger/in" address must come from the customer master, not invoice.recipientAddress
---

# Leistungsnachweis „Leistungsempfänger/in" = Kunden-Stammadresse, NICHT recipientAddress

The Leistungsnachweis (LN) PDF renders `pdfData.customerAddress` as the
"Leistungsempfänger/in" (the cared-for patient). The orchestrator
(`invoice-pdf-orchestrator.buildInvoicePdfData`) historically seeded
`customerAddress` from `invoice.recipientAddress`.

**Why that is wrong:** for a gesetzliche Pflegekasse WITHOUT Kostenerstattung the
invoice recipient is the *insurance*, so `recipientAddress` is the Kassen-
Anschrift — the LN then showed the insurer's address as the patient's address.
Fix: derive `customerAddress` from the customer master snapshot via
`formatCustomerMasterAddress` (`server/lib/customer-address-format.ts`), which is
byte-identical to the orchestrator's inline Kostenerstattungs-Override format.

**How to apply:**
- `customerAddress` flows ONLY into the LN PDF (pdf-generator LN generator), NEVER
  into the Rechnung PDF or ZUGFeRD XML → the GoBD byte-hash verifier is unaffected
  by changing this binding. Don't assume customerAddress touches invoice integrity.
- The master-address derivation works for both draft (live customer row) and
  snapshot/verifier paths (frozen `renderSnapshot.customer`) — same source, so
  re-render of sent/storniert invoices reproduces identical bytes (GoBD-safe).
- Recipient-vs-customer predicate: an invoice is CUSTOMER-addressed unless
  `billingType==='pflegekasse_gesetzlich' && !rechnungAnKunde`
  (`isCustomerAddressedInvoice` in `server/services/invoice-address-refresh.ts`).
- Draft (`status='entwurf'`) invoice UPDATEs are GoBD-trigger-allowed (trigger only
  blocks DELETE of finalized invoices + TRUNCATE) → no `app.allow_gobd_mutation`
  bypass needed to refresh draft recipient/cache on a customer address change.
