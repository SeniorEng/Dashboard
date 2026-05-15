# Chunk 16 — DevOps & Startup-Migrationen

**Tiefenstufe:** Pattern-Scan
**Commit:** `3e0d3fb`
**Risiko:** MITTEL
**LOC / Files:** 4 062 / 54

## Befunde

- ✅ Migrations-Idempotenz-Muster ist sichtbar (z. B.
  `backfill-budget-historization.ts`, `migrate-erstberatung-customers.ts` —
  letzteres hat ein Idempotenz-Finding in Chunk 13).
- ✅ ESBuild-Bundling-Constraint („drizzle-orm NICHT bundeln") als Gotcha in
  `replit.md` verankert.
- ⚠️ **HOCH:** Pre-Publish-Backup-Runbook (`docs/pre-publish-backup-runbook.md`)
  existiert, aber nicht in einer automatisierten Pre-Deploy-Check eingehängt.
- ⚠️ **MITTEL:** Auf dem geprüften Commit zeigt der Application-Workflow-Log
  zu Audit-Beginn DB-Startup-Race-500s in `auth/login` (Neon-Serverless
  „database system is starting up"). **Folge-Task:** Retry-Wrapper im
  Auth-Pfad oder beim Pool-Warmup.

## Empfohlener Folge-Task

`[MITTEL] DevOps: Pre-Publish-Backup CI-Hook + Neon-Cold-Start-Retry-
Wrapper`.
