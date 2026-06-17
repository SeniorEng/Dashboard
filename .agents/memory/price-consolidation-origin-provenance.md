---
name: Price consolidation needs origin provenance
description: Why the additive unified `prices` table must carry an origin column, not just scope, during the multi-list consolidation.
---

When consolidating multiple legacy price lists into one additive `prices` table,
`scope` alone is NOT enough to disambiguate rows. Two different legacy sources can
land at the same scope: customer-service-prices and customer-contract-rates BOTH map
to `scope='customer'`. Without a provenance marker, a reader/writer scoped only by
`scope='customer'` will mix them — the contract-rate reader can surface a
service-price row as a contract rate, and the contract-rate close-previous UPDATE can
wrongly close service-price rows.

**Rule:** the unified table carries a NOT-NULL `origin` provenance column (allowed
values enumerated app-side, no DB default) and every per-source reader/writer filters
on BOTH `scope` AND `origin`. The idempotency natural key of any backfill/populate
script MUST include `origin`, so identical values from different sources coexist
instead of colliding.

**Why:** during the additive phase the new table is a superset of several old tables;
losing the source identity is irreversible distortion of GoBD-relevant pricing data.

**How to apply:** any new per-source consumer of the unified price table must add its
`origin` filter; at the eventual cutover, harden with a DB-level CHECK coupling
scope/customerId and the allowed origin set.

## Populate-before-drop ordering (startup)

The startup step that POPULATES `prices` from the three legacy tables MUST run BEFORE
the step that DROPs those legacy tables — the drop step otherwise removes the data
source and prod ends up with an empty `prices` table (the original bug: the drop
migration was merged but nothing populated `prices`). The populate step is
**ledger-gated** (one-shot via `budget_migrations`) but **NOT flag-gated** — it is a
pure additive data transport, not a behaviour cutover needing sign-off.

It self-verifies with a hard Gate-2 parity check immediately after populating:
resolve `priceFor` over full coverage (recent appointments + every customer/service
pair + every standard service) twice — once from an INDEPENDENT legacy resolve, once
from the live `prices` rows — and throw on any ≠0-cent diff so a bad migration rolls
back (no ledger row → retries next boot) instead of serving wrong prices.

**Why:** prices feed GoBD invoices; a silent empty/incorrect `prices` table in prod is
irreversible financial distortion. Sequencing + a transactional self-check is the
guard.

**How to apply:** missing legacy tables (e.g. dev after the drop already ran) ⇒ clean
no-op, not an error. Rows without `validFrom` or without a catalog service mapping are
LOGGED, never silently dropped. Respect the partial unique index
`prices_active_validfrom_uniq` (soft-delete-before-insert per index key; in-batch
index-key collisions with differing values throw + roll back).
