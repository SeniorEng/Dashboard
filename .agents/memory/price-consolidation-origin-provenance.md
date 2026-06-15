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
