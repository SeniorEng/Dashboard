# Full-App-Audit 2026 — Konsolidierter Hauptreport (Refresh + Gap-Fill)

**Stand:** 2026-05-29
**Geprüfter Commit:** `178b2574222197c3e0d218b176cd3af2f79d5ab5`
**Task:** #822 — Full-App-Audit Refresh + Re-Run, danach **Gap-Fill-Welle** (alle 21 Chunks deep)
**Vorgänger-Audit:** Task #481 @ `3e0d3fb7029bd4f62cedd7f055abbd60bdf382e9` (2026-05-15)
**Delta seit Vorgänger:** 332 Commits; Inventar 521 → **593 Dateien**, 116 282 → **136 816 LOC**
**Audit-Plan:** `audit-plan.md` (aus #480, unverändert gültig)
**Methodik:** team-orchestration-Roster + deep-analysis-3-Phasen, konsolidiert vom Architect.

---

## 0. Coverage-Korrektur (WICHTIG)

Die **erste** Refresh-Welle dieses Tasks hat nur **7 von 21 Chunks** wirklich am
aktuellen Commit tief geprüft (01 Foundation, 02 Auth, 05a Appointments-BE,
07 Budget, 08 Billing, 09a Documents-BE, 13 Compliance). Die übrigen **14 Chunks
bekamen lediglich ein „Refresh-Banner"** über recyceltem #481-Inhalt vom alten
Commit `3e0d3fb` — also **keinen echten Re-Audit**. Die damaligen Counts
(1 KRIT / 4 HOCH) spiegelten daher nur die halbe Codebase.

Eine **Gap-Fill-Welle** (6 parallele Deep-Dive-Subagenten) hat die 14 fehlenden
Chunks am Commit `178b2574` nachgeholt. Ergebnis: **6 zusätzliche, verifizierte
HOCH-Findings** (Audit-Trail-Lücken, ArbZG-Pausen-Bug, DSGVO-Klartext im Browser,
Startup-Chain-Abbruch) plus zahlreiche MITTEL/NIEDRIG. **Alle 21 Chunks sind
jetzt Deep.** Zwei Chunks (10 Prospects, 12a Settings-BE) wurden nach echtem
Code-Walk **entlastet** (von MITTEL auf NIEDRIG) — die Verdachtspunkte des
Pattern-Scans ließen sich widerlegen.

---

## 1. Executive Summary

6 der 7 vormaligen KRITISCH-Findings und die Mehrheit der HOCH-Findings aus #481
sind inzwischen behoben (verifiziert per file:line-Code-Walk, §5). Das **einzige
neue KRITISCH** betrifft die Budget-Ledger km-Rebook-on-Edit-Logik (6 Test-Files
deterministisch rot, isoliert reproduziert). Nach der Gap-Fill-Welle stehen
**10 HOCH-Findings** offen — die Hälfte davon erst durch die nachgeholten
Deep-Dives sichtbar geworden.

**Severity-Verteilung (nach Dedupe, alle 21 Chunks deep):**

| Schweregrad | Anzahl | davon NEU aus Gap-Fill | Vorgänger (#481) |
|---|---:|---:|---:|
| **KRITISCH** | **1** | 0 | 7 |
| **HOCH** | **10** | **6** | 17 |
| **MITTEL** | **29** | 17 | 30 |
| **NIEDRIG** | **18** | 8 | 20 |
| **Σ** | **58** | 31 | 74 |

> **Confidence:** KRITISCH/HOCH sind file:line-belegt per Code-Walk; das KRITISCH
> zusätzlich durch deterministische Test-Reproduktion in Isolation (HIGH).
> MITTEL/NIEDRIG teils Hypothesen mit Hinweis auf Folge-Verifikation.

---

## 2. Test-Baseline-Klassifikation

CI-Stand zum Audit-Commit: `typecheck` ✅ GRÜN, `lint` ✅ GRÜN, `test`/`e2e-smoke` 🔴 ROT.

| Rotes Test-File | Klassifikation |
|---|---|
| `tests/equality/appointment-edit-rebook.test.ts` (4) | **REAL** — Rebook-Regression → KRITISCH-1 |
| `tests/budget/km-rebook-on-edit.test.ts` (1) | **REAL** — isoliert reproduziert |
| `tests/equality/appointment-series-bulk-rebook.test.ts` (1) | **REAL** — selber Pfad |
| `tests/equality/appointment-series-exception-rebook.test.ts` (1) | **REAL** — selber Pfad |
| `tests/integration/audit-appointment-budget-km-drift-detects-drift.test.ts` (1) | **REAL** — Drift-Selbstprüfung feuert |
| `tests/integration/reconcile-km-drift-leaves-audit-empty.test.ts` (1) | **REAL** — Reconcile-Audit nicht leer |
| `tests/document-pdf-sanitization.test.ts` (1) | **FLAKY / Test-only** (`docs/flaky-tests.md`) |
| `tests/test-data-cleanup.test.ts` (1) | **FLAKY / Test-Infra** — Shared-DB-Concurrency |

→ 6 Files = ein realer Budget-Ledger-Regressionscluster (KRITISCH-1). 2 Files test-/infra-seitig.

---

## 3. Top-Findings (priorisiert)

| # | Schweregrad | Quelle | Fundstelle | Beschreibung | Effort | Fix-Task |
|---|---|---|---|---|---|---|
| K1 | **KRITISCH** | Budget (07, deep) | `server/storage/budget/km-rebook.ts` + Appointment-`PATCH` | km-Rebook-on-Edit: alte Consumption-Zeilen bleiben am Termin verknüpft (erwartet `appointmentId=null`); 6 Tests rot, Drift-Detektion feuert → Doppelzählung/GoBD-Drift | M | T-822-BUDGET-01 (#823) |
| H1 | **HOCH** | Compliance (13, deep) | `server/services/audit.ts` | GoBD-Audit-Log nur konventionell immutabel — DB-User hat weiter `UPDATE/DELETE` (kein `REVOKE`/Trigger) | M | T-822-COMPLIANCE-01 (#824) |
| H2 | **HOCH** | Foundation (01, deep) | `shared/schema/company.ts`/`billing.ts` (`iban`,`bic`) | Bank-PII Klartext at-rest trotz verschlüsseltem Qonto-Secret | M | T-822-SECRETS-01 (#825) |
| H3 | **HOCH** | Foundation (01, deep) | `shared/schema/users.ts:37` | `monthly_work_hours` `real` statt `numeric` → Lohn-/Pro-Rata-Rundungsdrift | M | T-822-SCHEMA-01 |
| H4 | **HOCH** | Import (deep) | `server/services/appointment-import-reconcile.ts:405` | Bulk-Reconcile mit Tx **pro Zeile** → Mid-Batch-Fehler = teil-reconcilierter Zustand | M | T-822-IMPORT-01 |
| **H5** | **HOCH** 🆕 | Customer-BE (03, gap-fill) | `server/routes/admin/customers/details.ts:23,53,66,89,110`, `contracts.ts:54,92,144` | Admin-Mask schreibt für Pflegegrad/Verträge/Versicherung/Kontakte **KEIN Audit-Log** (Employee-Pfad tut es) — GoBD-Forensik-Lücke auf dem Primär-Pfad | M | **T-822-AUDIT-ADMIN-01** |
| **H6** | **HOCH** 🆕 | Customer-BE (03, gap-fill) | `server/routes/customers/service-prices.ts:326,347,451,565` | Sonderpreis-Mutationen werden **nur bei Rechnungs-Impact** geloggt; rein zukünftige Preisanlage/-änderung/-löschung ohne Invoice bleibt unprotokolliert | M | **T-822-AUDIT-PRICE-01** |
| **H7** | **HOCH** 🆕 | Time-Tracking (06, gap-fill) | `server/services/auto-breaks.ts:54-61,127-135` | Queries filtern `deletedAt` NICHT → soft-gelöschte Pausen mitgezählt; bei Reopen→Reclose werden ArbZG-Pflichtpausen **nicht neu eingetragen** | M | **T-822-AUTOBREAK-01** |
| **H8** | **HOCH** 🆕 | Time-Tracking (06, gap-fill) | `server/storage/time-tracking/overview.ts:385-394` | Admin-Übersicht gruppiert nur nach `assignedEmployeeId` (verwirft NULL); Employee-Sicht nutzt `performedByEmployeeId` → **Admin-/MA-Totale divergieren** (offener #481-Verdacht bestätigt) | M | **T-822-HOURS-PARITY-01** |
| **H9** | **HOCH** 🆕 | Customer-FE (4b1, gap-fill) | `client/src/features/customers/hooks/use-customer-wizard.ts:16-17,164-185` | DSGVO Art. 9 Gesundheits-/Versicherten-Daten **unverschlüsselt in localStorage** (`careconnect_customer_draft`, 24h) — bleibt auf Shared-Stationen liegen | M | **T-822-DRAFT-PII-01** |
| **H10** | **HOCH** 🆕 | DevOps (16, gap-fill) | `server/index.ts:201,204,209,219` (in `runStartupTasks`) | 4 Startup-Schritte nicht einzeln gewrappt → wirft einer, fängt der äußere Catch und **alle Folgemigrationen werden still übersprungen**; Server bootet halb-migriert | M | **T-822-STARTUP-GUARD-01** |

(MITTEL/NIEDRIG: §4. Page-Size-HOCH: §6 Refactor.)

---

## 4. Vollständige Finding-Liste

### KRITISCH
- **K1** `server/storage/budget/km-rebook.ts` (+ Appointment-`PATCH`) — Rebook-on-Edit-Regression; zusätzlich fehlt am Reversal-Insert `:206` `onConflictDoNothing()`. 6 Test-Files deterministisch rot. → T-822-BUDGET-01

### HOCH
- **H1** `server/services/audit.ts` — Audit-Log ohne DB-Immutability. *(Vorgänger, STILL OPEN.)* → #824
- **H2** `shared/schema/company.ts`/`billing.ts` — IBAN/BIC Klartext → `encryptedText`. → #825
- **H3** `shared/schema/users.ts:37` — `monthly_work_hours` `real`→`numeric(6,2)` (+ Migration). → T-822-SCHEMA-01
- **H4** `server/services/appointment-import-reconcile.ts:405` — nicht-atomares Bulk-Reconcile. → T-822-IMPORT-01
- **H5** 🆕 Admin-Stammdaten-Mutationen ohne Audit-Log (Kontakte/Pflegegrad/Verträge/Versicherung) — `details.ts`/`contracts.ts`, Storage `customer-mgmt/*`. → T-822-AUDIT-ADMIN-01
- **H6** 🆕 Sonderpreis-Mutationen nur bei Invoice-Impact geloggt — `customers/service-prices.ts`. → T-822-AUDIT-PRICE-01
- **H7** 🆕 Auto-Pausen ignorieren Soft-Deletes → ArbZG-Pausen-Verlust bei Reclose — `auto-breaks.ts`. → T-822-AUTOBREAK-01
- **H8** 🆕 Admin- vs. MA-Stunden-Totale divergieren — `time-tracking/overview.ts`. → T-822-HOURS-PARITY-01
- **H9** 🆕 DSGVO-Art.9-Daten unverschlüsselt im Browser-localStorage — `use-customer-wizard.ts`. → T-822-DRAFT-PII-01
- **H10** 🆕 Ungewrappte Startup-Schritte brechen Migrationskette ab — `server/index.ts`. → T-822-STARTUP-GUARD-01

### MITTEL (Backlog — keine eigenen Fix-Tasks)
- **M1** `template-engine.ts:404` — Defense-in-Depth Signature/Logo-Re-Validierung.
- **M2** `billing-storage.ts:40` — `getInvoice` JOIN überschreibt GoBD-Snapshot `customer_name`.
- **M3** `billing-storage.ts:111` — `updateInvoiceStatus` ohne Tx-Kontext.
- **M4** `schema/{users,services,insurance,budget}.ts` — `.unique()`-Constraint-Naming-Falle.
- **M5** `schema/appointments.ts`/`budget.ts` — fehlende Indizes (`performedByEmployeeId`, `import_batch_id`).
- **M6** `admin/lexware-export.ts` — N+1 pro Mitarbeiter.
- **M7** `server/routes/**` + Scheduler (`index.ts:658,672,684,696,730`) — `console.*` statt zentralem `log`.
- **M8** `server/storage/*.ts` — List-Queries ohne `.limit()`/Pagination.
- **M9** `appointment-import.ts:146` — `ExcelJS.xlsx.load` ohne Formula-Disabling.
- **M10** `query-invalidation` Adoption ~20 %; `customer-detail.tsx:210` direktes `invalidateQueries`.
- **M11** `billing.ts` (3656 LOC) — Monolith (Refactor §6).
- **M12** `schema/users.ts:12` — `password_hash` `text` (Defense-in-Depth `encryptedText`).
- **M13** 🆕 `service-records.tsx:324,340,558` — N+1 Customer-Fetches.
- **M14** 🆕 `use-new-appointment-form.ts:416-464` — Client-`seriesPreview` dupliziert Server-Serien-Logik → Anzeige-vs-Buchung-Count-Drift.
- **M15** 🆕 Customer-Anlage: `budgets` doppelt geschrieben (Payload `:410` + `POST /budget/:id/initial-budget`) — Hypothese, mit K1-Domäne verifizieren.
- **M16** 🆕 Nicht-atomare Post-Create-Orchestrierung; Idempotenz-Key deckt nur `createCustomer`.
- **M17** 🆕 `admin/customer-detail.tsx:162-170` — Hard-Delete via raw `fetch` umgeht api-client/CSRF-Helper.
- **M18** 🆕 `admin/customers/details.ts:66,89` — Kontakt-PATCH/DELETE ohne `contactId→customerId`-Binding.
- **M19** 🆕 `customer-mgmt/workflows.ts:32` — irreversible Anonymisierung nur admin-gated (vs. Hard-Delete superadmin `:481`).
- **M20** 🆕 `admin/duplicates.ts:251-266` — Merge kann überlappende Preis-Gültigkeitsfenster erzeugen.
- **M21** 🆕 `admin/duplicates.ts:313-329` — Merge-Audit best-effort nach Commit.
- **M22** 🆕 `shared/domain/vacation.ts:18` (ceil) vs `:130` (round) — Pro-Rata-Rundungs-Inkonsistenz.
- **M23** 🆕 `time-tracking/overview.ts:115` — nutzt `travelKilometers` statt `noShowKilometers` (Hypothese).
- **M24** 🆕 `birthday-notification-checker.ts:35,60` — Exakt-`=7`-Horizont ohne Catch-up (Downtime = Reminder verloren).
- **M25** 🆕 `shared/utils/datetime.ts:53-65` — `todayISO`/`formatDateISO` server-lokal statt Europe/Berlin → Tagesgrenzen-Off-by-one (kein erzwungenes `TZ`).
- **M26** 🆕 `server/lib/statistics/process-health.ts:133-135` — Snapshot-KPIs in YoY-/Prev-Deltas (sinnlose Trends).
- **M27** 🆕 `server/lib/statistics/revenue.ts`/`performance.ts` — korrelierte Preis-Subquery pro Termin-Service-Zeile, kein Covering-Index (Cross-Ref M5).
- **M28** 🆕 `server/routes/tasks.ts:63-72` — `GET /tasks/badge-count` 5-Query-Fan-out pro Poll.
- **M29** 🆕 `admin/settings.tsx:27-131` — destruktive Wartungsjobs (`repair-orphaned-transactions?execute=true`) ohne Client-Confirm-Gate.

### NIEDRIG (Backlog)
- **N1** `schema/customers.ts` — Legacy `aua_approval_*` fehlen im Schema; `drizzle-kit push` würde DROP versuchen. **NUR NOTIZ — nicht fixen, Backup vor Push.**
- **N2** `budget/transaction-storage.ts:117` — `reverseBudgetTransaction` nutzt `todayISO()` statt `orig.transactionDate`.
- **N3** `document-preview.tsx` — `iframe srcDoc` ohne strikteres `sandbox` (Render läuft aber bereits über DOMPurify).
- **N4** `appointment-import.ts:90` — duplizierte Date-Helper.
- **N5** `appointment-import-reconcile.ts:459` — `__testing`-Export im Prod-Pfad.
- **N6/N7** `document-pdf-sanitization.test.ts` / `test-data-cleanup.test.ts` — Test-Maintenance/Infra.
- **N8** `toISOString()`-Business-Date-Drift (refactor-masterplan §4a).
- **N9** API-Responses nicht durchgängig per `ZodSchema.parse()` gewrappt.
- **N10** ~30 einmalige Startup-Backfills weiter im Boot-Pfad (§6).
- **N11** 🆕 5b/9b — verstreute `new Date(string)`-Datetime-Konventionsverstöße.
- **N12** 🆕 `company.ts:14` — manuelle `SENSITIVE_FIELDS`-Maskingliste entkoppelt von Encryption-Registry (Drift-Risiko; Parity-Test empfohlen).
- **N13** 🆕 `storage/prospects.ts:24-55` — kein Per-Mitarbeiter-Scoping; alle `erstberatung`-Rollen sehen alle Leads inkl. PII (Design).
- **N14** 🆕 `vacation.ts:35-40` — `calculateCarryOverDays` toter Zweig / keine Cap.
- **N15** 🆕 `travel-time.ts:71` — km-Rundung.
- **N16** 🆕 `time-tracking/overview.ts:146-151` — Float-Drift.
- **N17** 🆕 `admin/users.tsx` — Self-Demote-Button nicht vorab disabled (Server erzwingt korrekt, nur UI-Residue).
- **N18** 🆕 Kein CI-Bundle-Size-Baseline (Chunk 15).

---

## 5. Status der Vorgänger-Findings

| Vorgänger-Finding (#481) | Status @178b2574 | Beleg |
|---|---|---|
| K1 `setUserRoles` Hierarchie-Bypass | ✅ FIXED | `employee-users.ts:342` |
| K2 CSRF-Token-Fixation | ✅ FIXED | `csrf.ts:48` |
| K3 Signature-HTML-Injection (PDF) | ⚠️ PARTIAL | Route-Validierung; Engine-Defense offen (M1) |
| K4 Path-Traversal Object-Storage | ✅ FIXED | `document-pdf.ts:312` |
| K5 Public-Signing Token-Race | ✅ FIXED | atomar `markSigningTokenUsed` |
| K6 Cascade-Consumption ohne Lock | ✅ FIXED | `pg_advisory_xact_lock` |
| K7 Login Session-Fixation | ✅ FIXED | `auth.ts:64-68` |
| H audit_log-Immutability | 🔴 OPEN | H1 |
| H reopen-Reason `.min(10)` | ✅ FIXED | `system.ts:66` |
| H Letzter-Admin-Schutz | ✅ FIXED | `employee-users.ts:281` |
| H Stored-XSS `dangerouslySetInnerHTML` (Docs-FE) | ✅ **FIXED** (Gap-Fill) | DOMPurify: `document-templates.tsx:694`, `document-preview.tsx:35`, `public-signing.tsx:163` |
| Diverse Object-ACL/IDOR | ✅ FIXED | `object-storage-auth.ts` |
| Double-Signature | ✅ FIXED | `documents.ts:689` |
| Rate-Limiting Public | ✅ FIXED | `public-signing.ts:18` |

---

## 6. Simplification / Refactoring / Performance

### 6.1 Page-/Route-Size-Hotspots (>800 LOC Hard-Limit)
| Datei | LOC | Status |
|---|---:|---|
| `server/routes/billing.ts` | 3656 | NEU (war 2131) — Top-Monolith |
| `server/routes/appointments.ts` | 1632 | Masterplan |
| `client/src/pages/admin/billing.tsx` | 1772 | NEU |
| `client/src/pages/edit-appointment.tsx` | 1428 | Masterplan (🆕 Gap-Fill HOCH-Refactor) |
| `server/routes/budget.ts` | 1278 | Masterplan |
| `server/storage/budget/allocation-storage.ts` | 1274 | NEU |
| `client/src/components/budget/BudgetTypeSettings.tsx` | 1169 | NEU |
| `server/services/appointment-import.ts` | 1201 | Masterplan |
| `client/src/features/customers/hooks/use-customer-wizard.ts` | 908 | 🆕 |
| `use-new-appointment-form.ts` | 893 | 🆕 |
| `customer-pricing-section.tsx` | 871 | 🆕 |
| `customer-contract-tab.tsx` | 818 | 🆕 |

### 6.2 Performance
N+1 (M6, M13, M27, Geocoding-Loops), fehlende `.limit()`/Pagination (M8), fehlende Indizes (M5/M27), Badge-Count-Fan-out (M28).

### 6.3 Simplification / Dead-Code
~30 einmalige Startup-Backfills retire-bar (N10; **KEEP** Seeds/Integritätsläufe), `__testing`-Export im Prod (N5), duplizierte Date-Helper (N4), `invalidateRelated` nur ~20 % adoptiert (M10).

### 6.4 Cross-Link
`docs/refactor-masterplan.md` → Abschnitt „Audit-2026-Refresh (#822)".

---

## 7. Empfohlene Fix-Reihenfolge

1. **T-822-BUDGET-01** (KRITISCH) — rotes Finanz-Gate + GoBD-Drift. → #823
2. **T-822-COMPLIANCE-01** (HOCH) — Audit-Log-Immutability. → #824
3. **T-822-AUDIT-ADMIN-01** (HOCH 🆕) — Admin-Stammdaten-Audit-Log (GoBD).
4. **T-822-AUTOBREAK-01** (HOCH 🆕) — ArbZG-Pausen-Verlust bei Reclose.
5. **T-822-DRAFT-PII-01** (HOCH 🆕) — DSGVO-Klartext im Browser entfernen.
6. **T-822-SECRETS-01** (HOCH) — IBAN/BIC-Verschlüsselung. → #825
7. **T-822-HOURS-PARITY-01** (HOCH 🆕) — Admin/MA-Stunden-Parität.
8. **T-822-SCHEMA-01** (HOCH) — `monthly_work_hours` `numeric`.
9. **T-822-STARTUP-GUARD-01** (HOCH 🆕) — Startup-Schritte einzeln wrappen.
10. **T-822-AUDIT-PRICE-01** (HOCH 🆕) — Sonderpreis-Audit-Lücke.
11. **T-822-IMPORT-01** (HOCH) — Bulk-Reconcile-Atomizität.

MITTEL/NIEDRIG → Backlog (§4).

---

## 8. Methodik & Scope

- **Roster:** team-orchestration (Code-Quality, Database, Business-Logic, Error-Handling, Security, Performance, UI/UX, QA, Regression-Guard) + Architect.
- **Phasen:** deep-analysis 3-Phasen (P1 Struktur, P2 Domäne, P3 UX/Stabilität).
- **Coverage:** Welle 1 = 7 Chunks deep; Gap-Fill = übrige 14 Chunks deep → **alle 21 deep**.
- **Out-of-Scope (eingehalten):** Fix-Implementierung; Dev/Test-Code als Target; Skill-Rewrites; `customers.aua_approval_*` (nur Notiz N1).
- **Git:** ausschließlich read-only.
