---
name: generateInvoiceCore opens its own tx + renders PDF — cannot nest
description: Structural constraint that forces invoice storno+reissue correction flows into multiple transaction stages.
---

`generateInvoiceCore` (server/services/invoice-calc.ts) does its DB inserts via
`withAudit`, which opens its OWN `db.transaction`; it ALSO schedules PDF rendering
(schedulePdfPersistInBackground) which must never run inside a transaction (pool
starvation). It additionally auto-detects net-zero appointments and re-books their
consumption with DEFAULT cascade priority at GENERATE time.

**Why:** rendering-inside-tx starves the pool, and a nested `db.transaction`
inside another tx does not give you atomic rollback of the outer work.

**How to apply:** Any "correct an issued invoice" flow (storno + rebook + reissue
+ payment rebind) MUST be decomposed into stages, NOT one big tx:
  - tx#1: reset/lock + storno (stornoInvoiceCascade already net-zeros every budget
    tx via reverseBudgetTransaction) + explicit re-book to the intended pots +
    invariant assertion (throw ⇒ rollback). Do the re-book YOURSELF here; if you
    leave the appointments net-zero, generateInvoiceCore's auto-rebook lands them
    on the DEFAULT pot (wrong, unassertable, uncommittable-back).
  - post-commit: schedule storno PDFs, then call generateInvoiceCore to reissue.
  - tx#2: rebind payments (qonto updateTransactionMatch + resolveInvoicePaymentStatus);
    make it idempotent/retryable (a crash between reissue and rebind otherwise
    leaves the payment stranded on the storniert invoice).
