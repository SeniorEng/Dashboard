---
name: Net-zero re-bill re-books consumption
description: Why/when re-billed fully-reversed appointments re-book budget consumption, and the preview-vs-generate boundary.
---
Re-billing an appointment whose budget consumption was fully reversed (net-zero,
e.g. after an invoice storno) RE-BOOKS fresh GoBD-append-only cascade consumption
— but ONLY at invoice generation, never in the read-only preview.

**Why:** Before this, the invoice pot split for net-zero appts was re-derived
read-only from current allocation but nothing was booked → invoice charged a pot
the ledger still showed as available → a later appt could double-spend the same
pot across two active invoices.

**How to apply:** generation flow builds the draft, detects net-zero appts, books
fresh consumption, then REBUILDS the draft so the split reads live ledger rows
(invoice == ledger, single source of truth). Idempotent: a re-booked appt is no
longer net-zero. Preview MUST stay read-only (a preview must never mutate the
ledger). Accepted caveat: preview re-derivation uses readUnifiedBudgetAvailability
+ planCascade while generation uses createCascadeConsumption (FIFO + cap-slot), so
the previewed split can rarely differ from the generated one — the generated
invoice's live rows are authoritative. Detail: docs/architecture/budget.md
"Re-Buchung netto-null-belegter Termine".

**Arch-test trap hit while doing this:** any new `db.select().from(<soft-deletable
table>)` (e.g. appointments) in server/services/** fails
tests/architecture/soft-delete-coverage.test.ts — must use the repos
(appointmentsRepo.selectColumnsFrom(...).where(and(..., repo.activeOnly()))).
