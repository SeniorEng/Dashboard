---
name: Atomic customer create (single wizard, one tx)
description: Customer creation is one wizard submit + one DB transaction; PDF/object-storage writes are inside the tx but intentionally not rolled back.
---

# Atomic customer create

POST /api/admin/customers takes the FULL wizard payload (stammdaten, contacts,
budgets, signatures, documents, initial-budget) and persists every DB record in
ONE transaction. The frontend wizard submits exactly once — there are no
secondary POSTs (no separate assign / signatures / documents / delivery /
initial-budget / setup-pending calls, no early-create draft).

**Why:** previously a "Schnellanlage" quick-create produced an orphan customer
that follow-up POSTs then enriched; a mid-sequence failure left a broken
half-customer. The atomic tx guarantees no orphan customer on any failure.

**How to apply:**
- Keep create single-submit. Do NOT re-introduce a post-create budget call or a
  draft/early-create path; extend the payload + `createCustomerRelatedData`
  (server/lib/customer-creation-helpers.ts) instead.
- Signature/document PDF generation runs INSIDE the tx (tx-threaded
  generateAndStorePdf / createGeneratedDocument / uploadCustomerDocument;
  buildPlaceholdersFromCustomer avoids uncommitted reads). New create-time
  artifacts must thread the tx too.
- Object-storage writes (PDFs/uploads) are NOT transactional and are NOT rolled
  back on tx abort — accepted leak (cleanup is a separate follow-up).
- Carryover (syncCarryoverAndExpiry) is a HARD step (failure aborts the create);
  the route's `warnings` response channel serves ONLY the pre-existing
  soft-fail contacts path, nothing else.
- SetupPendingBanner + setup-pending endpoints/columns are KEPT; the old intake
  checklist / in-intake concept / dashboard counter were removed.
