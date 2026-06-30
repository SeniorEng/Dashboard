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
would regress the decoupled semantics. Confirm pre-existing-ness via `git diff HEAD` on
the gating lines.

**Resolved:** `tests/lexware-export-signed-gate.test.ts` was updated to documented-only
expectations — completed-but-unsigned appts DO count toward wage hours/km AND still
surface as the `completedButUnsignedSqlRaw` warning (count + minutes); only `documenting`
(non-completed) is excluded. The `unsigned-only employee` case now expects counted hours
(2.0h) PLUS the warning, not 0h. Don't revert these to signature-gated assertions.
