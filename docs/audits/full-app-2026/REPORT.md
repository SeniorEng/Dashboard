# Full-App-Audit 2026 — Konsolidierter Hauptreport (Refresh)

**Stand:** 2026-05-29
**Geprüfter Commit:** `178b2574222197c3e0d218b176cd3af2f79d5ab5`
**Task:** #822 — Full-App-Audit Refresh + Re-Run
**Vorgänger-Audit:** Task #481 @ `3e0d3fb7029bd4f62cedd7f055abbd60bdf382e9` (2026-05-15)
**Delta seit Vorgänger:** 332 Commits; Inventar 521 → **593 Dateien**, 116 282 → **136 816 LOC**
**Audit-Plan:** `audit-plan.md` (aus #480, unverändert gültig)
**Methodik:** team-orchestration-Roster + deep-analysis-3-Phasen (Foundation-Facts → Domain-Deep → UX/Stabilität), konsolidiert vom Architect.

---

## 0. Executive Summary

Diese Refresh-Welle prüft den aktuellen Stand gegen den Vorgänger-Audit von vor
332 Commits. **Die zentrale Erkenntnis: 6 der 7 vormaligen KRITISCH-Findings und
die Mehrheit der HOCH-Findings wurden in der Zwischenzeit behoben** — verifiziert
per file:line-Code-Walk (Details §4 + Vergleichstabelle §5).

**Severity-Verteilung (nach Dedupe):**

| Schweregrad | Anzahl | Vorgänger (#481) |
|---|---:|---:|
| **KRITISCH** | **1** | 7 |
| **HOCH** | **4** | 17 |
| **MITTEL** | **12** | 30 |
| **NIEDRIG** | **10** | 20 |
| **Σ** | **27** | 74 |

> **Confidence-Einordnung:** Die KRITISCH/HOCH-Befunde sind file:line-belegt und
> durch Subagent-Code-Walk (6 parallele Deep-Audits: Budget, Billing,
> Documents/Signing, Compliance/Auth, Foundation/Schema, Import/Export) sowie —
> beim KRITISCH-Finding — durch **deterministische Test-Reproduktion in Isolation**
> verifiziert (Confidence **HIGH**). MITTEL/NIEDRIG sind teils Hypothesen mit
> Hinweis auf Folge-Verifikation.

**Das einzige KRITISCH-Finding ist neu** und betrifft die **Budget-Ledger
km-Rebook-on-Edit-Logik**: Ein Cluster aus 6 Test-Dateien (Equality + Integration,
inkl. der system-eigenen Drift-Selbstprüfung) schlägt **deterministisch** fehl —
auch isoliert reproduziert, mit test-eigener `appointmentId`, also **keine
Shared-DB-Flake**. Alte Consumption-Zeilen bleiben nach `reopen` + km-`PATCH`
mit dem Termin verknüpft, obwohl der Vertrag eine Entkopplung (`appointmentId=null`)
erwartet → Risiko doppelt gezählter Budget-Verbräuche gegen gesetzliche Caps /
GoBD-km-Drift, plus rotes CI-Gate auf dem Finanz-Pfad.

**GoBD-Compliance** bleibt das wichtigste offene HOCH-Thema: technische
Audit-Log-Immutability (DB-`REVOKE`/Trigger) fehlt weiterhin; der
serverseitige Reopen-Reason-`.min(10)` ist inzwischen **behoben**.

---

## 1. Test-Baseline-Klassifikation (T001)

CI-Stand zum Audit-Commit: `typecheck` ✅ GRÜN, `lint` ✅ GRÜN, `test`/`e2e-smoke` 🔴 ROT.

| Rotes Test-File | Klassifikation | Belegt durch |
|---|---|---|
| `tests/equality/appointment-edit-rebook.test.ts` (4) | **REAL** — Rebook-Regression/Vertrags-Drift | Cluster, siehe KRITISCH-1 |
| `tests/budget/km-rebook-on-edit.test.ts` (1) | **REAL** — isoliert reproduziert (`stillLinkedOld` = 1, erwartet 0) | Isolations-Run |
| `tests/equality/appointment-series-bulk-rebook.test.ts` (1) | **REAL** — selber Pfad | Cluster |
| `tests/equality/appointment-series-exception-rebook.test.ts` (1) | **REAL** — selber Pfad | Cluster |
| `tests/integration/audit-appointment-budget-km-drift-detects-drift.test.ts` (1) | **REAL** — Drift-Selbstprüfung feuert | Cluster |
| `tests/integration/reconcile-km-drift-leaves-audit-empty.test.ts` (1) | **REAL** — Reconcile-Audit nicht leer | Cluster |
| `tests/document-pdf-sanitization.test.ts` (1) | **FLAKY / Test-only** — Signature-Fixture Min-Bytes (8-Byte-PNG-Stub scheitert an Signatur-Validierung Task #749) | `docs/flaky-tests.md`, Memory |
| `tests/test-data-cleanup.test.ts` (1) | **FLAKY / Test-Infra** — Shared-DB-Concurrency beim Cleanup gegen den parallel laufenden Dev-Server | bekannt |

→ **6 Files = ein realer Budget-Ledger-Regressionscluster (KRITISCH-1).**
2 Files sind test-/infrastrukturseitig (kein Produkt-Bug, kein Audit-Finding;
als NIEDRIG/Test-Maintenance gelistet).

---

## 2. Top-Findings (priorisiert)

| # | Schweregrad | Phase/Skill | Fundstelle | Beschreibung | Effort | Folge-Task |
|---|---|---|---|---|---|---|
| 1 | **KRITISCH** | P3 QA + Regression-Guard + Business-Logic | `server/storage/budget/km-rebook.ts` + Appointment-`PATCH` | km-Rebook-on-Edit: alte Consumption-Zeilen bleiben mit Termin verknüpft (erwartet `appointmentId=null`); 6 Test-Files rot, Drift-Selbstprüfung feuert → Doppelzählungs-/GoBD-Drift-Risiko | M | **T-822-BUDGET-01** |
| 2 | **HOCH** | P2 Security + Compliance | `server/services/audit.ts` (audit_log) | GoBD-Immutability nur konventionell — DB-User hat weiterhin `UPDATE/DELETE` auf `audit_log` (kein `REVOKE`/Trigger) | M | **T-822-COMPLIANCE-01** |
| 3 | **HOCH** | P2 Security + Database | `shared/schema/company.ts` / `billing.ts` (`iban`, `bic`) | Bank-PII (IBAN/BIC) im Klartext at-rest, obwohl Qonto-Secret verschlüsselt ist | M | **T-822-SECRETS-01** |
| 4 | **HOCH** | P1 Database + Business-Logic | `shared/schema/users.ts:37` (`monthly_work_hours`) | `real` (Float) statt `numeric` → Rundungs-Drift in Pro-Rata-/Lohn-Berechnung; nicht von km-geo-Migration erfasst | M | **T-822-SCHEMA-01** |
| 5 | **HOCH** | P2 Error-Handling + Business-Logic | `server/services/appointment-import-reconcile.ts:405` | Bulk-Reconcile mit Transaktion **pro Zeile** in Schleife → Mid-Batch-Fehler hinterlässt teil-reconcilierten Zustand (nicht atomar) | M | **T-822-IMPORT-01** |
| 6 | MITTEL | P2 Security | `server/services/template-engine.ts:404` | Defense-in-Depth: `rawHtmlKeys` (Signaturen/Logo) ohne Re-Validierung im Template-Engine (Route validiert, interne Aufrufer evtl. nicht) | S | Backlog |
| 7 | MITTEL | P1 Database | `server/storage/billing-storage.ts:40` | `getInvoice` überschreibt GoBD-Snapshot `invoices.customer_name` mit `customers.name` (JOIN-Alias-Falle) | S | Backlog |
| 8 | MITTEL | P1 Database | `server/storage/billing-storage.ts:111` | `updateInvoiceStatus` umgeht Tx-Kontext (nutzt `db` direkt) → bricht Atomizität in Batches | S | Backlog |
| 9 | MITTEL | P1 Database | `shared/schema/{users,services,insurance,budget}.ts` | `.unique()` statt `unique("name").on()` (email/code/ikNummer/customerId) → drizzle-push Duplikat-Constraint-Risiko (replit.md-Gotcha) | S | Backlog |
| 10 | MITTEL | P3 Performance | `shared/schema/appointments.ts` / `budget.ts` | Fehlende Indizes auf `performedByEmployeeId`, `budget_transactions.import_batch_id` | S | Backlog |

(Vollständige Matrix §3; MITTEL/NIEDRIG = Backlog, keine Fix-Tasks.)

---

## 3. Risiko-Matrix nach Domänen

| Chunk / Domäne | Tiefe | KRIT | HOCH | MITTEL | NIEDRIG | Σ |
|---|---|---:|---:|---:|---:|---:|
| 7 Budget-Ledger | Deep | 1 | 0 | 1 | 1 | 3 |
| 13 Compliance/Month-Close | Deep | 0 | 1 | 0 | 1 | 2 |
| 2 Auth & Permissions | Deep | 0 | 0 | 0 | 1 | 1 |
| 8 Billing | Deep | 0 | 0 | 3 | 1 | 4 |
| 9a Documents/Signing | Deep | 0 | 0 | 1 | 2 | 3 |
| 1 Foundation/Schema | Deep | 0 | 2 | 2 | 2 | 6 |
| Import/Export | Deep | 0 | 1 | 2 | 2 | 5 |
| Cross-cutting (Perf/Refactor) | — | 0 | 0 | 2 | 0 | 2 |
| **Σ** | | **1** | **4** | **12** | **10** | **27** |

---

## 4. Vollständige Finding-Liste

### KRITISCH
- **K1** `server/storage/budget/km-rebook.ts` (+ Appointment-`PATCH`-Pfad) — km-Rebook-on-Edit-Regression. Nach `reopen`+km-`PATCH` bleiben alte Consumption-Zeilen am Termin verknüpft (Test erwartet Entkopplung `appointmentId=null`); zusätzlich fehlt am Reversal-Insert `:206` ein `onConflictDoNothing()` (Retry → 500 trotz Unique-Index). 6 Test-Files deterministisch rot, inkl. der system-eigenen km-Drift-Detektion. **Effort M.** → T-822-BUDGET-01

### HOCH
- **H1** `server/services/audit.ts` — GoBD-Audit-Log ohne technische Immutability (kein `REVOKE UPDATE/DELETE` / Trigger). *(Vorgänger T-COMPLIANCE-01, STILL OPEN.)* **M.** → T-822-COMPLIANCE-01
- **H2** `shared/schema/company.ts`/`billing.ts` — IBAN/BIC Klartext at-rest → `encryptedText`. **M.** → T-822-SECRETS-01
- **H3** `shared/schema/users.ts:37` — `monthly_work_hours` `real` → `numeric(6,2)` (+ Startup-Migration analog km-geo). **M.** → T-822-SCHEMA-01
- **H4** `server/services/appointment-import-reconcile.ts:405` — nicht-atomares Bulk-Reconcile (pro-Zeile-Tx). **M.** → T-822-IMPORT-01

### MITTEL (Backlog)
- **M1** `server/services/template-engine.ts:404` — Defense-in-Depth Signature/Logo-Re-Validierung im Engine.
- **M2** `server/storage/billing-storage.ts:40` — `getInvoice` JOIN-Alias überschreibt GoBD-Snapshot `customer_name`.
- **M3** `server/storage/billing-storage.ts:111` — `updateInvoiceStatus` ohne Tx-Kontext-Parameter.
- **M4** `shared/schema/{users,services,insurance,budget}.ts` — `.unique()`-Constraint-Naming-Falle (4 Spalten).
- **M5** `shared/schema/appointments.ts`/`budget.ts` — fehlende Indizes (`performedByEmployeeId`, `import_batch_id`).
- **M6** `server/routes/admin/lexware-export.ts` — N+1 (pro Mitarbeiter Einzel-Fetch der Monatsdatensätze).
- **M7** `server/routes/**` — 46 `console.*`-Aufrufe in 14 Route-Dateien (statt zentralem `log`); `no-console` nicht als Error erzwungen.
- **M8** `server/storage/*.ts` — viele List-Queries ohne `.limit()`/Pagination (Seq-Scan-Wachstum).
- **M9** `server/services/appointment-import.ts:146` — `ExcelJS.xlsx.load` ohne explizites Formula-Disabling (Formula-Injection-Härtung).
- **M10** `client/src/lib/query-invalidation.ts` Adoption ~20 %; `customer-detail.tsx:210` direktes `invalidateQueries`; fehlendes `customerId`-Scoping bei Budget-Invalidierung.
- **M11** `server/routes/billing.ts` (3656 LOC) — monolithische Route, Extraktion in `billing-service.ts` (Refactor, §6).
- **M12** `shared/schema/users.ts:12` — `password_hash` `text` (Defense-in-Depth `encryptedText`, Hash bereits vorhanden).

### NIEDRIG (Backlog)
- **N1** `shared/schema/customers.ts` — Legacy `aua_approval_ref`/`aua_approval_date` fehlen im Drizzle-Schema; nächster `drizzle-kit push` würde DROP versuchen (Data-Loss-Prompt). **NUR NOTIZ — laut Task-Scope nicht zu fixen; Backup vor Push sicherstellen.**
- **N2** `server/storage/budget/transaction-storage.ts:117` — `reverseBudgetTransaction` nutzt `todayISO()` statt `orig.transactionDate` (Cap-Fenster-Drift bei monatsübergreifendem Storno).
- **N3** `client/src/features/documents/document-preview.tsx` — `iframe srcDoc` ohne strikteren `sandbox`/Sanitize an diesem Eintrittspunkt.
- **N4** `server/services/appointment-import.ts:90` — duplizierte `excelDateToISO`/`dateToISO`-Helper.
- **N5** `server/services/appointment-import-reconcile.ts:459` — `__testing`-Export im Prod-Pfad (Dead-Code).
- **N6** `tests/document-pdf-sanitization.test.ts` — Signature-Fixture Min-Bytes (Test-Maintenance).
- **N7** `tests/test-data-cleanup.test.ts` — Shared-DB-Cleanup-Flake (Test-Infra).
- **N8** Business-Date-Drift via `toISOString()` an mehreren Stellen (siehe refactor-masterplan §4a, weiter offen).
- **N9** API-Responses nicht durchgängig per `ZodSchema.parse()` als SSoT gewrappt (OpenAPI-`Exact<>`-Assertions greifen, aber Runtime-Drift möglich).
- **N10** ~30 einmalige Startup-Backfills weiter im Boot-Pfad (Simplification, §6).

---

## 5. Status der Vorgänger-Findings (T003)

| Vorgänger-Finding (#481) | Status @178b2574 | Beleg |
|---|---|---|
| K1 `setUserRoles` Hierarchie-Bypass | ✅ **FIXED** | `employee-users.ts:342` `denyIfPrivilegedTarget` |
| K2 CSRF-Token-Fixation (Cookie auf 403) | ✅ **FIXED** | `csrf.ts:48` kein Cookie-Set bei Fehler |
| K3 Signature-HTML-Injection (PDF) | ⚠️ **PARTIAL** | Route-Validierung `public-signing.ts:81` (Regex), Engine-Defense-in-Depth offen (M1) |
| K4 Path-Traversal Object-Storage | ✅ **FIXED** | `document-pdf.ts:312` normalize + `..`-Check |
| K5 Public-Signing Token-Race | ✅ **FIXED** | `public-signing.ts` atomar `markSigningTokenUsed WHERE usedAt IS NULL` |
| K6 Cascade-Consumption ohne Lock | ✅ **FIXED** | `consumption-engine.ts` `pg_advisory_xact_lock` durchgängig |
| K7 Login ohne CSRF-Rotation/Session-Fixation | ✅ **FIXED** | `auth.ts:64-68` Logout-Vorsession + `setCsrfCookie` |
| H (Compliance) audit_log-Immutability | 🔴 **OPEN** | siehe H1 |
| H (Compliance) reopen-Reason `.min(10)` | ✅ **FIXED** | `shared/schema/system.ts:66` |
| H (Auth) Letzter-Admin-Schutz | ✅ **FIXED** | `employee-users.ts:281` Self-Demote-Block |
| Diverse Object-ACL/IDOR | ✅ **FIXED** | `object-storage-auth.ts` record-level `requireObjectAccess` |
| Double-Signature | ✅ **FIXED** | `documents.ts:689` `WHERE signingStatus='pending'` → 409 |
| Rate-Limiting Public | ✅ **FIXED** | `public-signing.ts:18` `publicSigningLimiter` |

**Bilanz:** 6/7 KRITISCH behoben (K3 PARTIAL→als MITTEL fortgeführt), Großteil HOCH
behoben. **Einzig GoBD-Immutability** bleibt aus den Vorgänger-HOCHs offen.

---

## 6. Simplification / Refactoring / Performance (T005)

Querschnittsbefunde, abgeglichen mit `docs/refactor-masterplan.md`,
`docs/dead-code-report.md`, `docs/schema-audit-report.md`,
`docs/dependency-audit-report.md`, `docs/quality-sweep-2026-05-27.md`.
„NEU" = nach dem 2026-05-27-Sweep entstanden/eskaliert; „Masterplan" = bereits gelistet.

### 6.1 Page-/Route-Size-Hotspots (>800 LOC Hard-Limit, vgl. `docs/page-size-guideline.md`)
| Datei | LOC | Status | Effort |
|---|---:|---|---|
| `server/routes/billing.ts` | 3656 | **NEU** (war 2131) — Top-Monolith; PDF/Qonto/Storno → `billing-service.ts` | L |
| `server/routes/appointments.ts` | 1632 | Masterplan | L |
| `server/routes/budget.ts` | 1278 | Masterplan | M |
| `server/storage/budget/allocation-storage.ts` | 1274 | NEU | M |
| `server/services/appointment-import.ts` | 1201 | Masterplan | M |
| `client/src/pages/admin/billing.tsx` | 1772 | **NEU** (war ~1445) | L |
| `client/src/pages/edit-appointment.tsx` | 1428 | Masterplan | L |
| `client/src/components/budget/BudgetTypeSettings.tsx` | 1169 | NEU | M |

(36 Client- + 25 Server-Dateien >500 LOC; vollständige Liste im Anhang von `chunks/01-foundation.md`.)

### 6.2 Performance
- N+1: Lexware-Export (M6), Geocoding-Lookups in Import-Loops (Masterplan).
- Fehlende `.limit()`/Pagination auf Großteil der List-Queries in `server/storage/` (M8).
- Fehlende Indizes (M5).

### 6.3 Simplification / Dead-Code
- **~30 einmalige Startup-Backfills** weiter im Boot-Pfad retire-bar (Liste in `chunks/16-devops-startup.md`). **KEEP:** Seeds, `sync-budget-allocations`, `migrate-km-geo-to-numeric`, `prospect-customer-matching`, `audit-*`-Integritätsläufe, `encrypt-company-secrets`.
- Dead-Code: `__testing`-Export im Prod-Pfad (N5); duplizierte Date-Helper (N4).
- `invalidateRelated`-Disziplin nur ~20 % adoptiert (M10).

### 6.4 Cross-Link refactor-masterplan
Dieser Refresh ergänzt `docs/refactor-masterplan.md` um: (a) `billing.ts`-Eskalation
auf 3656 LOC (neuer Top-Posten), (b) `allocation-storage.ts`/`BudgetTypeSettings.tsx`
als neue >1000-LOC-Posten, (c) Startup-Migrations-Retirement als eigenes
Simplification-Arbeitspaket. Querverweis dort unter „Audit-2026-Refresh (#822)".

---

## 7. Empfohlene Fix-Reihenfolge

1. **T-822-BUDGET-01** (KRITISCH) — rotes Finanz-Gate + GoBD-Drift, zuerst.
2. **T-822-COMPLIANCE-01** (HOCH) — GoBD-Audit-Log-Immutability.
3. **T-822-SECRETS-01** (HOCH) — IBAN/BIC-Verschlüsselung (DSGVO/Bank-PII).
4. **T-822-SCHEMA-01** (HOCH) — `monthly_work_hours` `numeric` (Lohn-Präzision).
5. **T-822-IMPORT-01** (HOCH) — Bulk-Reconcile-Atomizität.

MITTEL/NIEDRIG → Backlog (kein eigener Fix-Task, in §4 dokumentiert).

---

## 8. Methodik & Scope

- **Roster:** team-orchestration (Code-Quality, Database, Business-Logic,
  Error-Handling, Security, Performance, UI/UX, QA, Regression-Guard) + Architect-Konsolidierung.
- **Phasen:** deep-analysis 3-Phasen — P1 Struktur-Fakten (Code-Quality + DB),
  P2 Domänen-Deep mit P1-Kontext (Business-Logic + Error-Handling + Security + Performance),
  P3 UX/Stabilität mit Vollkontext (UI/UX + QA + Regression-Guard).
- **Out-of-Scope (eingehalten):** Fix-Implementierung; Dev/Test-Code als Audit-Target;
  Skill-Rewrites; das bekannte `customers.aua_approval_*` drizzle-push-Item (nur Notiz N1).
- **Git:** ausschließlich read-only.
