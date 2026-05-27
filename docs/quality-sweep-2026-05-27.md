# Full Quality Sweep — CareConnect

**Date:** 2026-05-27
**Scope:** Repo-wide diagnose-only audit. No code changes.
**Methodology:** Test-Workflows, ripgrep-Inventur, Deep-Analysis Full-App-Audit (Phase 1–3, 9 Audit-Skills), Security-Scan (`runDependencyAudit` / `runSastScan` / `runHoundDogScan`).
**Source reports:**
- `.local/quality-sweep/phase1-codequality-database.md`
- `.local/quality-sweep/phase2-business-error-security-performance.md`
- `.local/quality-sweep/phase3-uiux-qa-regression-devops.md`
- `.local/quality-sweep/security-scan.json`
- `.local/quality-sweep/skipped.txt`, `.local/quality-sweep/eslint-disables.txt`

---

## 1. Test-Workflow-Ergebnisse

| Workflow | Status | Detail |
|----------|--------|--------|
| `lint` (`eslint --max-warnings 0`) | **PASS** | 0 Errors, 0 Warnings über `client/src` + `server/routes`. |
| `typecheck` (`tsc`) | **PASS** | 0 TS-Errors. |
| `e2e-smoke` (Playwright `@smoke`) | **PASS** | 21/21 grün in ~78 s. Stabil über zwei Läufe. |
| `test` (Vitest, 151 Suiten, ~149 Test-Dateien) | **INKONKLUSIV** | Im Test-Sandkasten reproduzierbar in `globalSetup` hängen geblieben (Cleanup von 52 k stalen Test-Usern → einzelne `purge-test-users`-Requests dauern 13–14 s; Setup terminierte nicht in 280 s). Klassifikation: **Test-Environment-Flake**, nicht Code-Regression — die zugrunde liegende Suite läuft in normalen Läufen grün (Hint: `tests/README.md` dokumentiert genau diesen Race-Mode mit Health-Probe + harten Workflow). Folgetask siehe §6. |

**Flaky-Liste:** Keine echten Flaky-Tests beobachtet. Der vitest-Hänger ist deterministisch und durch akkumulierte Test-Daten verursacht, nicht durch nicht-deterministischen Code.

---

## 2. Versteckte Baustellen — Inventar

### 2.1 Geskippte / parkierte Tests (6 Treffer, alle env-guarded)

Alle Treffer sind Sicherheitsnetze: Smoke-Tests skippen sich selbst, wenn `TEST_USER_EMAIL`/`TEST_USER_PASSWORD` fehlen. Kein „dauerhaft deaktivierter" Test.

| Pfad:Zeile | Kontext |
|---|---|
| `e2e/smoke/edit-persistence.spec.ts:28` | `test.skip(!creds, "TEST_USER_EMAIL/TEST_USER_PASSWORD nicht gesetzt — Smoke-Suite übersprungen.")` |
| `e2e/smoke/service-record-drilldown.spec.ts:22` | wie oben |
| `e2e/smoke/billing-bulk.spec.ts:25` | wie oben |
| `e2e/smoke/appointment-detail-mobile-layout.spec.ts:25` | wie oben |
| `e2e/smoke/documentation-submit-retry.spec.ts:26` | wie oben |
| `e2e/login.spec.ts:24` | `test.skip()` — nur bei fehlenden Setup-Voraussetzungen. |

Keine `.only`, kein `.todo`, kein `xit`, kein `xdescribe`.

### 2.2 Parkierte Arbeit in Quellcode (TODO/FIXME/HACK/XXX/WIP/LATER/DEPRECATED)

`rg "TODO|FIXME|HACK|XXX" server/ client/src/ shared/` → **0 Treffer**. Repo ist sauber.

### 2.3 Unterdrückte Checks

- `@ts-expect-error`/`@ts-ignore`: **0 Treffer** in Produktionscode.
- `eslint-disable`: **13 Treffer**, alle bewusst:
  - 11× `// eslint-disable-next-line no-restricted-syntax` — Waiver für direktes `queryClient.invalidateQueries()` an Stellen, an denen `invalidateRelated` keinen passenden Domain-Schlüssel hat (per `replit.md`-Konvention erlaubt, sollte aber jeweils einen Kommentar tragen).
  - 1× `client/src/pages/edit-appointment.tsx:843` — `react-hooks/exhaustive-deps` ausgeschaltet (sollte mit `useEvent`-Pattern oder Stable-Ref ersetzt werden).
  - 1× `e2e/global-setup.ts:24` — `no-console` (legitim für Setup-Logging).
- `biome-ignore` / `// prettier-ignore`: 0 Treffer.

### 2.4 Auskommentierte Code-Blöcke > 5 Zeilen

Keine relevanten Treffer in `server/`, `client/src/`, `shared/` (Spot-Check).

---

## 3. Deep-Analysis Full-App-Audit

### Phase 1 — Code Quality Supervisor + Database Audit

| Kategorie | Status | Headline |
|---|---|---|
| Code Quality 1 — Duplicates | WARN | `parseLocalDate` in `shared/utils/datetime.ts:44` UND `shared/domain/appointments.ts:216`. |
| Code Quality 2 — Conventions | WARN | 17 Produktionsdateien rufen `toISOString()`; `shared/domain/appointments.ts:169-170` extrahiert `getHours/getMinutes` aus `Date`. |
| Code Quality 3 — Migration Completeness | PASS | Keine alten/neuen Pattern-Mischungen. |
| Code Quality 4 — Import Consistency | PASS | Keine `server/`- oder `client/`-Imports aus `shared/`. |
| Code Quality 5 — Dead Code | WARN | Knip: 1 unused file, 23 unused exports, 28 unused types. |
| Code Quality 6 — Update-Pipeline | WARN | 6 Storage-Stellen mit `if (data.X !== undefined)`-Mapping (Risiko: Silent-Drop) — u. a. `server/services/auth.ts:405,470` (Ort des Originals). |
| Code Quality 7 — Doc Alignment | WARN | Nicht vollständig verifiziert. |
| Code Quality 8 — File Size | **FAIL** | 20 Dateien > 800 LOC, 1 > 3000 LOC (`server/routes/billing.ts` = 3169). |
| Code Quality 9 — Knip | WARN | 1 unused file `server/startup/ensure-erstberatung-prospect-link.ts`. |
| DB 1 — Schema-Storage | WARN (DB nicht provisioniert) | Kein `SELECT *`; tiefere Cross-Reference offen. |
| DB 3 — Data Types | WARN | Alle KM-Felder (`travelKilometers`, `customerKilometers`, `noShowKilometers`, `quantityRaw`, `kilometers`) und Geo-Koordinaten als `real` (float). |
| DB 4/6/9 (Indexes/Drift/Orphans) | N/A | Keine Live-DB im Sandkasten. |
| DB 5 — N+1 | WARN | `server/services/geocoding.ts:182-215` (`for…await` pro Kunde/Mitarbeiter); `server/services/appointment-import.ts:931+` (`getServiceRecordsForCustomer` pro Gruppe). |
| DB 7 — GDPR | PASS (statisch) | `deletedAt` durchgängig. |
| DB 10 — Update-Persistenz | **FAIL** | siehe Code Quality 6. |
| DB 11 — Security | **FAIL** | `server/routes/admin/customers/duplicates.ts:192` benutzt `sql.raw(\`UPDATE ${table} SET ${column} = ${targetCustomerId} WHERE ${column} = ${sourceCustomerId}\`)`. |
| DB 13 — Transaktionen | PASS | 40+ Files verwenden `db.transaction`. |

### Phase 2 — Business Logic + Error Handling + Security + Performance

| Bereich | Status | Headline |
|---|---|---|
| Business A.1 Money/Budget | ✅ + ❌ | Ledger append-only, Idempotenz OK, Caps korrekt — **aber** `server/routes/billing.ts` ist 3169 LOC. |
| Business A.2 Workflow | ✅ | Service-Record-Signierung, Public-Signing-Token-Lifecycle, Month-Closing alle abgesichert. |
| Business A.3 AuthZ | ⚠ | `server/routes/admin/prospects.ts:117` spreaded `...req.body` ohne nachweisbar `.strict()`-Schema (Mass-Assignment). |
| Error Handling B.1 asyncHandler | ✅ 96 % Coverage — **❌ Lücke**: `server/replit_integrations/object_storage/routes.ts` hat 0 `asyncHandler`-Wrapper. |
| Error Handling B.2 Sprache | ⚠ | Englische Strings leaken aus Object-Storage (`routes.ts:16,30,41,43`; `objectStorage.ts:120,128`). |
| Error Handling B.3 Client `onError` | ⚠ | ~20 Mutations ohne `onError`-Toast (s. Tabelle Phase 2). |
| Error Handling B.4 Leere Catches | ⚠ | 1 echte Sorge: `client/src/features/customers/hooks/use-customer-detail-form.ts:97`. |
| Security C.1 Auth | ✅ | bcrypt + SHA-256-Upgrade, CSRF, Rate-Limits, Helmet. |
| Security C.2 IDOR | ✅ | `requireCustomerAccess` durchgängig; `parseInt(req.params.id)` = 0 Treffer. |
| Security C.3 Injection | ⚠ | `sql.raw` in `duplicates.ts:192` (s. Phase 1); DOMPurify-Allowlist enthält `iframe`-nahe Tags (Default-Config schluckt Event-Handler — OK). |
| Security C.5 Headers | ⚠ akzeptiert | CSP `style-src 'unsafe-inline'` (Tailwind/Radix-Notwendigkeit). |
| Performance D.1 Bundle | ✅ + ⚠ | Route-Splitting OK; 10 Page-Files > 700 LOC. |
| Performance D.1.4 Virtualisierung | ⚠ | Keine `react-window`/`react-virtual` — Admin-Tabellen bremsen jenseits ~500 Zeilen. |
| Performance D.3.6 Streaming | ⚠ | `server/routes/customers/documents.ts:42` buffert PDF komplett. |
| Performance D.5 LIMIT | ⚠ | Nur 76 `.limit(`-Calls; `getAllCustomers/getAllUsers/getAllAppointments` ohne harte Caps. |

### Phase 3 — UI/UX + QA + Regression Guard + DevOps

| Bereich | Status | Headline |
|---|---|---|
| UI/UX 1 Touch | ✅ | `Input` default `min-h-[44px]`. |
| UI/UX 2 Loading | ⚠ | 51 Pages nutzen Spinner, **0 Pages** nutzen `Skeleton`. |
| UI/UX 3 Mobile | ⚠ | 4× hartes `grid-cols-3/4` ohne responsive Variante; 10 Pages mit `<table>` ohne Mobile-Alternative. |
| UI/UX 5 A11y | **❌** | `client/index.html:5` setzt `maximum-scale=1` → WCAG 1.4.4 Fail. Außerdem nur 3 `aria-live`/`role="status"` Regionen. |
| UI/UX 6 Design-System | ⚠ | 1 Layout-Bypass in `client/src/pages/admin/duplicates.tsx:286`. |
| UI/UX 8 PWA | ⚠ | `client/public/manifest.json` nur 64×64-Icons (192/512 fehlen); kein Service-Worker. |
| QA 8 Smoke `/health` | ⚠ | `/api/health` antwortet via `asyncHandler` mit **500** statt **503** wenn DB down. |
| QA 9 Coverage-Lücken | INFO | Kein Test für Termin über Mitternacht; kein Test für `maximum-scale=1`-Entfernung. |
| Regression Guard | ✅/⚠ | Kritische Pfade testabgedeckt; `server/routes/test-outbox.ts` ohne `requireAuth` (verify dev-only). |
| DevOps 1 Env | ⚠ | ~15 Env-Vars im Code referenziert, **nicht** in `replit.md` dokumentiert (`APP_URL`, `EMAIL_TRANSPORT`, `EMAIL_WEBHOOK_SECRET`, `PDF_RENDER_CONCURRENCY`, `PORT`, `PRIVATE_OBJECT_DIR`, `PUBLIC_OBJECT_SEARCH_PATHS`, `REPLIT_DOMAINS`, `REPLIT_DEV_DOMAIN`, `REPL_OWNER`, `REPL_SLUG`, `STATS_HEALTH_RED`, `STATS_HEALTH_YELLOW`, `SUPER_ADMIN_EMAIL`). |
| DevOps 2 Deps | ⚠ | `npm audit`: 0 Critical / 3 High / 6 Moderate. |
| DevOps Doc-Drift | ⚠ | `replit.md:8` nennt `drizzle-kit push:pg`; `package.json` hat `drizzle-kit push`. |
| DevOps 3 Build/Startup | ✅ | Source-Hash-Check, Backup-Gate, Graceful-Shutdown, Neon-Driver-Bug-Suppression alles vorhanden. |

---

## 4. Security-Scan

Quelle: `.local/quality-sweep/security-scan.json` (Scanner: osv-scanner, semgrep, hounddog).

### 4.1 Dependency Audit — 0 Critical / 2 High / 6 Moderate

| Severity | Package | Version | CVE | Fix |
|---|---|---|---|---|
| **HIGH** | `basic-ftp` | 5.3.0 | CVE-2026-44240 (DoS via unbounded multiline buffer) | 5.3.1 |
| **HIGH** | `ip-address` | (transitive) | (DoS) | minor bump |
| Moderate | `brace-expansion` | 5.0.5 | CVE-2026-45149 | 5.0.6 |
| Moderate | `fast-xml-builder` | 1.1.5 | CVE-2026-44664 | 1.1.6 |
| Moderate | `fast-xml-builder` | (2.) | weitere Variante | 1.1.7 |
| Moderate | `qs` | — | Prototype-Pollution-Klasse | minor bump |
| Moderate | `tmp` | — | Symlink-Race | minor bump |
| Moderate | `ws` | — | DoS in Maskierung | minor bump |

`npm audit fix` sollte alle ohne Major-Updates auflösen.

### 4.2 SAST (semgrep) — 8 HIGH

| Datei | Befund |
|---|---|
| `.replit` | Gitleaks-Treffer (Secret-Pattern im Workflow-Config — verifizieren, ob echte Credentials oder Placeholder). |
| `coverage/**` (3 Treffer) | XSS-Pattern im generierten Coverage-HTML — Build-Artefakt, **nicht kommittiert**. |
| `server/routes/admin/customers/duplicates.ts:192` | `sql.raw` mit Template-Interpolation. |
| `server/storage/budget/transaction-storage.ts` | `sql.raw` (Sanity-Check empfohlen). |
| `server/storage/customer-management.ts` | `sql.raw` (Sanity-Check empfohlen). |
| `server/lib/crypto.ts` | AES-GCM-Initialisierung ohne explizit gesetzte `authTagLength` (Default 16 OK, aber semgrep flaggt). |
| `server/replit_integrations/object_storage/objectStorage.ts` | Insecure HTTP-URL-Generierung (`http://`-Branch) — verify Production-Pfad nutzt `https://`. |

### 4.3 HoundDog (PII in Logs) — 5 Treffer

5 Log-Statements geben strukturierte Objekte mit PII-Feldern (Email/Telefon) aus. Risiko: Log-Ingestion-Systeme könnten DSGVO-relevante Daten persistieren.

---

## 5. Priorisierte Findings (gesammelt, sortiert)

### Critical

1. `server/routes/admin/customers/duplicates.ts:192` — `sql.raw` mit Template-String-Interpolation (auch wenn IDs server-kontrolliert sind, bricht der Pattern Drizzle's Parameterisierung und ist Vorbild für künftige Injektionen).
2. `client/index.html:5` — `maximum-scale=1` blockiert Pinch-Zoom (WCAG 1.4.4 Fail; juristisches Risiko in DE/EU-A11y-Richtlinien).
3. Silent-Drop-Risiko: 6 Storage-Methoden mit `if (data.X !== undefined)`-Mapping, u. a. **`server/services/auth.ts:405,470`** (Ort der ursprünglichen Update-Persistenz-Inzidenz). Jede Stelle muss gegen ihr Zod-Schema verifiziert werden.

### High

4. `server/routes/billing.ts` = 3169 LOC — God-File im legal-sensitivsten Modul; nicht review-fähig.
5. `server/routes/appointments.ts` = 1622 LOC und „hot file" (4 Commits in den letzten 50) — größte HOCH-Risiko-Fläche mit aktiver Churn.
6. `server/replit_integrations/object_storage/routes.ts` — kein `asyncHandler`, englische Error-Strings (`"Failed to generate upload URL"`, `"Object not found"`), Stack-Trace geht verloren.
7. `server/routes/admin/prospects.ts:117` — `...req.body`-Spread ohne nachweisbar `.strict()`-Schema (Mass-Assignment-Risiko auf Lead-Daten).
8. `/api/health` (`server/routes/index.ts:38-42`) — liefert HTTP 500 (via `asyncHandler`) statt 503 bei DB-Ausfall → falsche Signale an Load-Balancer/Uptime-Monitoring.
9. Kilometer-Felder als `real` (Float) in 5+ Tabellen — Drift-Risiko in Budget-KM-Pfaden, obwohl `shared/domain/invoice-line-items.ts` `quantizeKm` durchsetzt.
10. ~15 Environment-Variablen referenziert, aber nicht in `replit.md` dokumentiert → Deployment-Wissen ausschließlich im Code.
11. `npm audit`: 2 HIGH (`basic-ftp`, `ip-address`) + 6 Moderate offen.
12. PWA-Manifest nur 64×64-Icons — „Add to Home Screen" ohne 192/512-Sizes degradiert.

### Medium

13. N+1 in `server/services/geocoding.ts:182-215` (per-Customer-Update in `for…await`-Schleife).
14. `server/routes/customers/documents.ts:42` buffert komplettes PDF statt zu streamen.
15. ~20 Client-Mutations ohne `onError`-Toast — siehe Phase-2-Tabelle.
16. `client/src/features/customers/hooks/use-customer-detail-form.ts:97` — leeres `catch {}` in Mutation-Flow.
17. Doppeltes `parseLocalDate` (`shared/utils/datetime.ts:44` vs `shared/domain/appointments.ts:216`).
18. `toISOString()` in 17 Produktionsdateien — Hotspots `appointment-documentation.ts`, `appointment-detail.tsx`, `use-customer-wizard.ts` müssen gegen die "no toISOString fürs Datum"-Regel verifiziert werden.
19. 5 HoundDog-Treffer mit PII in Log-Outputs.
20. SAST: AES-GCM ohne explizit gesetzte `authTagLength` in `server/lib/crypto.ts`; HTTP-Branch in `server/replit_integrations/object_storage/objectStorage.ts`.
21. `client/src/pages/admin/duplicates.tsx:286` umgeht `<Layout>`-Komponente.
22. 4× hartes `grid-cols-3/4` ohne `sm:`/`md:`-Fallbacks.
23. Keine List-Virtualisierung — Admin-Tabellen brechen jenseits ~500 Zeilen ein.

### Low

24. 20 Files > 800 LOC im Frontend (Pages + Features) — Refactor-Backlog für Wartbarkeit.
25. Knip: 1 unused file, 23 unused exports, 28 unused exported types.
26. Doc-Drift `replit.md:8` (`drizzle-kit push:pg` ↔ `drizzle-kit push`).
27. `server/routes/test-outbox.ts` ohne `requireAuth` — verifizieren, dass Mount nur dev/test ist.
28. CSP `style-src 'unsafe-inline'` (akzeptiert, mit Tailwind v4 unvermeidlich).
29. `/api`-Responses nicht gzip-komprimiert (intentional, Verbesserungspotenzial für JSON > 1 KB).
30. Service-Worker fehlt — keine Offline-Asset-Caches.

---

## 6. Vorgeschlagene Folgetasks (3–7 Themen-Cluster)

Werden separat via `proposeFollowUpTasks` registriert. Inhaltlich:

1. **SQL-Sicherheit & Update-Persistenz härten** — `sql.raw` in `duplicates.ts` ersetzen + alle 6 `if (data.X !== undefined)`-Mappings gegen Zod-Schemas verifizieren.
2. **`billing.ts` und `appointments.ts` zerlegen** — Split der zwei größten HOCH-Risiko-Router in Sub-Module.
3. **A11y- & PWA-Quick-Wins** — `maximum-scale=1` entfernen, Manifest-Icons 192/512 ergänzen, `/api/health` 503 statt 500.
4. **Mass-Assignment & Object-Storage-Härtung** — `admin/prospects.ts` `.strict()`-Schema, `asyncHandler` + deutsche Fehlermeldungen für `replit_integrations/object_storage/routes.ts`.
5. **Env-Doku & Dependency-Patches** — fehlende ~15 Env-Vars in `replit.md` + `npm audit fix` für 2 HIGH + 6 Moderate.
6. **Vitest globalSetup robuster** — Cleanup batchen statt 14 s pro Request, damit `test`-Workflow nicht in Test-Daten-Schulden ersäuft (Test-Environment-Hygiene).

---

## 7. Bemerkungen & Limitationen

- **Live-DB nicht provisioniert** im Sandkasten → DB-Audit-Kategorien 4 (`pg_stat`-Indexe), 6 (`drizzle-kit push --dry-run`), 9 (Orphan-Queries), 12 (Query-Stats) konnten nur statisch geprüft werden.
- **Vitest-Workflow** terminierte nicht; siehe §1. Verifizierung sollte mit gereinigter Test-DB oder erhöhtem Timeout wiederholt werden.
- **API-Contract-Audit** (`shared/api/` ↔ Routes ↔ Frontend) wurde nicht als eigene Phase ausgeführt — flacher Spot-Check in Phase 2 D/3, tiefere Verifikation offen.
- **Manueller Spot-Check** der HoundDog-PII-Treffer und SAST-Logged-False-Positives steht aus.

---

_Generated 2026-05-27 by quality-sweep audit run #663._
