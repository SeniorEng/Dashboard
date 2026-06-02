---
name: Ephemeral test DB seeding contract
description: What a fresh per-run integration test DB actually contains, and how to write tests against it without assuming pre-seeded data.
---

# Ephemeral test DB seeding contract

Integration/e2e workflows spin up brand-new throwaway Postgres DBs per run
(orchestrator `scripts/with-ephemeral-db.ts`), and integration test files run in
parallel across multiple workers, each pinned to its OWN isolated DB + app server.
A test DB is NOT a copy of the dev DB — it only contains what the seeders create
plus whatever the test itself inserts.

**What a fresh run actually has at `beforeAll` time:**
- ONE seeded superadmin user — no second employee, no regular admins.
- Base reference data only: a small set of services (hauswirtschaft /
  alltagsbegleitung with their pots + lohnart) and a minimal `company_settings`
  row. Nothing else.
- Full schema, minus the dev/prod CHECK constraint
  `budget_transactions_appointment_required_check` (the orchestrator drops it to
  mirror the real dev/prod DB).

**How to write tests against it:**
- Need a second employee / extra users? Create them in `beforeAll`. Never assume
  they exist or throw when only the superadmin is present.
- Need lohnart categories / company-settings fields / ZUGFeRD identity? Seed or
  update them in setup — they are not pre-populated.
- Files on the same worker share one DB sequentially; files on different workers
  get separate DBs. So a test may NOT rely on data created by another test file,
  and a "count all rows" assertion only sees its own worker's data.
- **Date-relative budget/appointment fixtures must derive ALL anchors (allocation
  year/month/validFrom AND appointment date) from the SAME computed anchor, never
  from `today` independently.** On a month boundary (e.g. June 1) a May-consumption
  test that reads a June allocation silently yields fulfilled=0. Compute one anchor
  (e.g. `today-3`, weekday-shifted) and base both allocation and appointment on it.
- jsdom component tests read `year`/`month` from `window.location.search`, which is
  empty in jsdom → they get the CURRENT month, NOT a mocked wouter `useSearch`.
  Pass current-month values or the records query cache-misses into an infinite
  loader.

**Why:** Per-run + per-worker isolation means tests can no longer lean on leftover
dev-DB rows or on each other's data. Any test that assumed pre-existing data must
seed it itself.

**How to apply:** When a test breaks only on a fresh DB (missing row, FK
violation, off-by-a-month budget result), fix the TEST/SEED setup — not the domain
logic or the assertions.
