---
name: Lexware hours/export gated on documented-only (not signed)
description: Why tests/lexware-export-signed-gate.test.ts fails on HEAD and must NOT be "fixed" by re-adding signature gating.
---

The Lohn-/Lexware-Stundenübersicht (`server/routes/admin/lexware-export.ts` hours +
travel + km queries) gates on `documentedSqlRaw('a')` = `status='completed'`, NOT on
documented-AND-signed. This is intentional product semantics from the month-close
rework: for Lohn/Export/Statistik, "dokumentiert" == completed and is **decoupled
from the signature** (signature only gates Kunden-/Pflegekassen-Abrechnung).

**Why:** the older payroll test `tests/lexware-export-signed-gate.test.ts` asserts the
pre-rework signed-gating (completed-but-unsigned must NOT count). After the month-close
8th-only rework switched the gate to documented-only, that test became stale and now
fails on a clean checkout (completed-unsigned appts now DO count toward wage hours).

**How to apply:** if you see this test red while touching wage/export code, do NOT
re-introduce `documentedAndSignedSqlRaw` into the hours queries to make it green — that
would regress the decoupled semantics. The test itself is stale and should be updated
to the documented-only expectation (or removed) under a payroll-semantics task, not a
wage-rate task. Confirm pre-existing-ness via `git diff HEAD` on the gating lines.
