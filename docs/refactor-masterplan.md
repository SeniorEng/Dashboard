# Refactor-Masterplan

Stand: 2026-05-27. Quelle der Symptom-Zahlen: Repo-Scan zum Stichtag.

## Scan-Methodik (für Reproduzierbarkeit)

Alle Zahlen unten sind aus folgenden Greps gegen den Repo-Stand vom
2026-05-27 erzeugt. Zählregel: **Occurrences** (einzelne Treffer-Zeilen),
nicht Dateien, sofern nicht anders vermerkt.

- Page-Größen: `find client/src -name "*.tsx" -o -name "*.ts" | xargs wc -l | sort -rn | awk '$1>500'`
- `toISOString()`-Hotspots: `rg -n "toISOString\(\)" server/ shared/ -g '!*.test.ts'` — gezählt werden Production-Pfade (ohne `server/replit_integrations/**`, das ist 3rd-party).
- Silent-Drop-Pfade: `rg -n "\.\w+ !== undefined" server/ -g '!*.test.ts'` — gezählt werden NUR Production-Pfade (ohne `server/scripts/**`). Skripte (Reconciliation, Audits) sind interaktiv und außerhalb des Mutation-Flusses.
- ESLint-Disables: `rg -c "eslint-disable" -g "*.ts" -g "*.tsx" client/ server/ shared/`
- Knip-Treffer: Reports unter `docs/dead-code-report.md`.

Dieses Dokument friert die Ziel-Architektur für die nächste Refactor-Welle ein.
Es ersetzt KEINE Implementierungs-Tasks — es definiert nur die Konventionen und
die Reihenfolge, damit die Folge-PRs nicht jeweils eigene Lösungen erfinden.

## 0. Leitprinzipien

1. **Keine Riesen-PR.** Jeder Punkt unten ist ein eigener PR mit eigenem
   Test-Lauf. Reviewbarkeit > Geschwindigkeit.
2. **Tests zuerst.** Vor jedem Split werden die bestehenden Routen/Pfade durch
   Integrationstests „eingefroren" — sonst maskiert das Refactoring Bugs.
3. **Page = Thin-Wrapper.** Pages in `client/src/pages/` halten nur Routing,
   Data-Fetching und Layout. Echter Code lebt in
   `client/src/features/<domain>/components|hooks/`.
4. **Server-Routes = Thin-Controller.** Routen validieren (Zod) und delegieren
   an `server/storage/*` oder `server/services/*`. Kein Domain-Code in
   Route-Handlern.
5. **Domain-Berechnungen liegen in `shared/domain/`** — geprüft durch
   `tests/architecture/calculations-in-shared.test.ts`.

## 1. Page-Size-Hotspots (Frontend)

Aktuelle Größen-Verteilung der Frontend-Dateien > 500 LOC (Soft-Limit lt.
`docs/page-size-guideline.md`; Hard-Limit 800 LOC):

### 1a. Pages (Soll: ≤500 LOC, Wrapper-only)

| Datei | LOC | Ziel-Verteilung |
| --- | --- | --- |
| `pages/admin/billing.tsx` | 1445 | Split nach Tabs: `features/billing/components/{invoices-list,split-invoices,zugferd-export,credit-notes}-tab.tsx` + Page-Wrapper |
| `pages/edit-appointment.tsx` | 1428 | Bereits `features/appointments/hooks/use-new-appointment-form.ts` (893 LOC) — Page muss die verbliebene Form-Render-Logik in `features/appointments/components/edit-appointment-form.tsx` auslagern |
| `pages/admin/document-types.tsx` | 890 | `features/documents/components/{type-list,type-editor,placeholder-picker}.tsx` |
| `pages/admin/qonto.tsx` | 883 | `features/qonto/components/{transactions-table,matching-panel,settings-form}.tsx` |
| `pages/dashboard.tsx` | 879 | `features/dashboard/components/{day-view,blockers-strip,kpi-cards}.tsx` |
| `pages/admin/services.tsx` | 843 | `features/services/components/{service-table,price-editor,history-dialog}.tsx` |
| `pages/admin/settings.tsx` | 833 | Pro Settings-Section ein Komponentenmodul unter `features/settings/components/` |
| `pages/admin/document-templates.tsx` | 739 | `features/documents/components/{template-list,template-editor,placeholder-help}.tsx` |
| `pages/admin/customer-detail.tsx` | 734 | Tabs in `features/customers/components/admin/*` ziehen (Großteil existiert schon) |
| `pages/admin/insurance-providers.tsx` | 731 | `features/insurance/components/{provider-list,provider-form}.tsx` |
| `pages/admin/customers.tsx` | 686 | `features/customers/components/admin/customer-list-{filters,table,bulk-actions}.tsx` |
| `pages/customer-detail.tsx` | 682 | Read-only Pendant zur Admin-Variante; gleiche Tab-Aufteilung |
| `pages/admin/import-appointments.tsx` | 641 | `features/import/components/{file-uploader,preview-table,conflict-resolver}.tsx` |
| `pages/service-records.tsx` | 591 | `features/service-records/components/{records-list,record-detail}.tsx` |
| `pages/admin/whatsapp.tsx` | 591 | `features/whatsapp/components/{rules-table,rule-editor,test-sender}.tsx` |
| `pages/admin/users.tsx` | 586 | `features/team/components/admin/{users-table,user-detail-sheet}.tsx` |
| `pages/document-appointment.tsx` | 561 | `features/appointments/components/document-{form,signature-flow}.tsx` |
| `pages/admin/time-entries.tsx` | 543 | `features/time-entries/components/admin/{filter-bar,entries-table}.tsx` |
| `pages/admin/month-closing.tsx` | 510 | `features/month-close/components/{employees-grid,reopen-dialog,reminder-status}.tsx` |

### 1b. Bereits ausgelagerte Feature-Dateien > 800 LOC

Diese liegen schon unter `client/src/features/` oder `client/src/components/`,
aber sind selbst Monolithen geworden und müssen weiter zerlegt werden:

| Datei | LOC | Maßnahme |
| --- | --- | --- |
| `components/budget/BudgetTypeSettings.tsx` | 1106 | Pro Budgettopf eine Section-Komponente (`budget-type-section-{45a,45b,verhinderungspflege}.tsx`) |
| `features/customers/hooks/use-customer-wizard.ts` | 908 | Step-Reducer in `wizard/state/` + pro Step ein eigener Hook |
| `features/appointments/hooks/use-new-appointment-form.ts` | 893 | Trennen in `use-appointment-form-state` (Felder) + `use-appointment-form-submit` (Mutation/Konflikt-Auflösung) |
| `features/customers/components/admin/customer-pricing-section.tsx` | 871 | `pricing-history-table` + `pricing-editor-dialog` + Section-Wrapper |
| `components/budget/BudgetLedgerSection.tsx` | 855 | Filter-Bar, Ledger-Table, Carryover-Card als eigene Komponenten |
| `features/customers/components/admin/customer-contract-tab.tsx` | 818 | Pro Vertrags-Block (Stammdaten / Pflegegrad / Vollmacht) eine Sub-Komponente |

## 2. Server-Router-Split-Plan

### 2a. `server/routes/billing.ts` (3169 LOC) — Split-Mapping

Mount-Punkt bleibt `/api/billing` in `server/routes/index.ts`. Sub-Module
werden in ein neues Verzeichnis `server/routes/billing/` gezogen und per
Express-Router komponiert.

| Neues Modul | Verantwortung | Mount |
| --- | --- | --- |
| `billing/invoices.ts` | CRUD: `GET /`, `POST /generate`, `GET /:id`, `DELETE /:id`, Storno | `router.use("/", invoicesRouter)` |
| `billing/pdf.ts` | `GET /:id/pdf`, `GET /:id/leistungsnachweis`, On-Demand-Render | `router.use("/", pdfRouter)` |
| `billing/split.ts` | Split-Rechnungen (privater Anteil), Verlinkung Original ↔ Split | `router.use("/split", splitRouter)` |
| `billing/zugferd.ts` | ZUGFeRD/XRechnung-Export, Mapping | `router.use("/zugferd", zugferdRouter)` |
| `billing/credit-notes.ts` | Gutschriften, Korrekturen | `router.use("/credit-notes", creditNotesRouter)` |
| `billing/line-items.ts` | Line-Item-Lesen/Audit (siehe Task #561) | `router.use("/line-items", lineItemsRouter)` |
| `billing/index.ts` | Komponiert alle Sub-Router, exportiert `billingRouter` | — |

**Test-Grenzen**: Pro Sub-Router eine eigene `tests/routes/billing/*.test.ts`;
existierende `tests/routes/billing.test.ts` wird vor dem Split auf die
neuen Datei-Namen aufgeteilt, NICHT währenddessen.

### 2b. `server/routes/appointments.ts` (1632 LOC) — Split-Mapping

| Neues Modul | Verantwortung | Mount |
| --- | --- | --- |
| `appointments/crud.ts` | `GET /`, `POST /`, `PATCH /:id`, `DELETE /:id` | `router.use("/", crudRouter)` |
| `appointments/documentation.ts` | Doku-Workflow: Start, Submit, Re-Open, Audit | `router.use("/:id/documentation", docRouter)` |
| `appointments/conflicts.ts` | Konfliktprüfung, Resolve-Suggestions, Bulk-Resolve | `router.use("/conflicts", conflictsRouter)` |
| `appointments/series.ts` | Recurring-Series-Erzeugung & Bulk-Updates | `router.use("/series", seriesRouter)` |
| `appointments/index.ts` | Komponiert alle Sub-Router | — |

Bestehendes `server/routes/appointment-documentation.ts` (separate Datei)
wird in `appointments/documentation.ts` integriert oder mit klarer Grenze
zu `documentation.ts` als reinem Re-Render-Endpoint stehen gelassen — wird
beim Split entschieden.

## 3. Dead-Code-Plan

Quelle: Knip-Scan + Repo-Greps. Behandlung pro Kategorie:

### 3a. Sofort entfernen (in DIESEM Task bereits erledigt)

- `server/startup/ensure-erstberatung-prospect-link.ts` — Funktion
  `ensureErstberatungProspectLinkConstraint()` nirgends aufgerufen
  (`server/index.ts` ruft nur `cleanupOrphanErstberatungCustomers`). Das
  CHECK-Constraint wurde nie scharfgeschaltet. **Erledigt.**

### 3b. In Folge-PR entfernen — vor Entfernung jeweils greppen

Knip meldet 23 unused exports + 28 unused types. Vor dem Löschen MUSS pro
Symbol gegen `tests/`, `e2e/` und `scripts/` gegrept werden — diese Pfade
sind im Knip-Entry-Set, aber Test-Hilfen werden trotzdem manchmal als
unused gemeldet, wenn sie nur dynamisch geladen werden.

Default-Aktion: **löschen**, sobald grep bestätigt, dass kein Konsument
existiert. Ausnahmen (bewusst öffentlich):
- `shared/api/*` — Response-Types werden vom Client per
  `import type` gezogen; wenn Knip sie als unused meldet, ist das ein
  Indikator, dass der Frontend-Import fehlt → Bug, nicht Cleanup.
- `shared/schema/*` — Drizzle-Tabellen, die nur in Migrationen referenziert
  werden, können trotz „unused"-Meldung produktiv sein.

### 3c. Bewusst öffentlich (Knip-Ignore eintragen)

Falls in 3b ein Symbol gefunden wird, das wirklich Public-API sein soll
(Beispiel: `shared/utils/datetime.ts` für externe Scripts), → in `knip.json`
unter `ignoreExportsUsedInFile` bzw. `ignore` aufnehmen, mit Kommentar
**warum**.

## 4. Convention-Drift-Liste

### 4a. `toISOString()`-Hotspots (19 Occurrences in 14 Dateien)

Vollständige Inventur per `rg -n "toISOString\(\)" server/ shared/ -g '!*.test.ts'`.
Bewusst ausgeschlossen: `server/replit_integrations/**` (3rd-party-Vendor-Code,
nicht von uns gepflegt).

| Datei | Zeile | Kontext | Klassifizierung (vorab) |
| --- | --- | --- | --- |
| `server/routes.ts` | 36 | Health-Response `timestamp` | System-Zeitstempel ✓ |
| `server/routes.ts` | 45 | Health-Response `timestamp` | System-Zeitstempel ✓ |
| `server/routes/index.ts` | 41 | Health-Response `timestamp` | System-Zeitstempel ✓ |
| `server/routes/admin/customers.ts` | 316 | Audit-Detail `createdAt` | System-Zeitstempel ✓ |
| `server/routes/admin/customers/workflows.ts` | 507 | Response-Mapping `createdAt` | System-Zeitstempel ✓ |
| `server/routes/appointment-documentation.ts` | 505 | Audit `createdAt` | System-Zeitstempel ✓ |
| `server/storage/statistics/process-health.ts` | 18 | `.toISOString().slice(0,10)` → Geschäftsdatum (Monatsende) | **Geschäftsdatum — UMSTELLEN auf `formatDateISO`** |
| `server/storage/statistics/common.ts` | 53 | `.toISOString().slice(0,10)` → Geschäftsdatum (Vorperiode-Range) | **Geschäftsdatum — UMSTELLEN** |
| `server/storage/statistics/common.ts` | 54 | dito | **Geschäftsdatum — UMSTELLEN** |
| `server/storage/budget/preferences-storage.ts` | 218 | Kommentar (warnt explizit vor `toISOString().slice(0,10)`) | Doku-only ✓ |
| `server/lib/pdf-cache-stats.ts` | 85 | `lastEventAt` für Stats-Response | System-Zeitstempel ✓ |
| `server/services/qonto.ts` | 137 | `updated_at_from` für Qonto-API-Filter (UTC ist Qonto-API-Vorgabe) | API-Vorgabe ✓ |
| `server/services/call-scheduler.ts` | 125 | Log-Message `callAt` | System-Zeitstempel ✓ |
| `server/services/call-scheduler.ts` | 130 | Log-Message `callAt` | System-Zeitstempel ✓ |
| `server/services/email-service.ts` | 100 | `sentAt` für Email-Audit | System-Zeitstempel ✓ |
| `server/startup/restore-storno-deleted-service-records.ts` | 178 | Audit `previousDeletedAt` | System-Zeitstempel ✓ |
| `server/startup/restore-storno-deleted-service-records.ts` | 183 | Audit-Fenster `windowStart` | System-Zeitstempel ✓ |
| `server/startup/restore-storno-deleted-service-records.ts` | 184 | Audit-Fenster `windowEnd` | System-Zeitstempel ✓ |
| `server/scripts/cleanup-test-data.ts` | 49 | Filename-Stempel | Skript (außerhalb Production-Flow) ✓ |

**Echte Drift-Stellen** (zu fixen): **3 Treffer** in 2 Dateien —
`server/storage/statistics/process-health.ts:18` und
`server/storage/statistics/common.ts:53/54`. Hier wird ein lokales
Geschäftsdatum (Monatsende, Vorperiode-Range) per UTC-Slice gebaut, was bei
CET-Datum-Wechseln um Mitternacht zu Off-by-One führt. Ersatz:
`formatDateISO(lastOfPrevMonth)` aus `shared/utils/datetime.ts`.

Alle anderen Treffer sind System-Zeitstempel (Audit/Logs/Health) und damit
korrekt — `toISOString()` ist hier sogar Pflicht, weil sie als
`timestamptz`-konforme UTC-Strings verarbeitet werden.

Ein Lint-Custom-Rule kommt **erst nach** der Aufräumarbeit der 3 echten
Drift-Stellen — sonst muss die Rule pro System-Zeitstempel mit
`// eslint-disable-next-line` umlaufen werden.

### 4b. `parseLocalDate`-Duplikate (Erledigt in diesem Task)

Lokale Kopie in `shared/domain/appointments.ts` entfernt — Import aus
`shared/utils/datetime.ts` ist jetzt einzige Quelle.

Verbleibende Drift-Risiken (nicht in diesem Task):
- `client/src/lib/` hat eigene Datums-Helper (z. B. wochenbasierte). Vor
  dem Split der Dashboard-Komponenten muss geklärt werden, ob die nach
  `shared/utils/datetime.ts` umziehen.

### 4c. Silent-Drop-Pfade `if (data.X !== undefined)`

Vollständige Inventur per `rg -n "\.\w+ !== undefined" server/ -g '!*.test.ts'`
(Skripte unter `server/scripts/**` ausgeschlossen, da nicht im
Mutation-Flow).

Das Pattern ist KEIN Bug — es schützt vor `undefined`-Overwrites bei
Drizzle-Updates. ABER: `null` (explizites Zurücksetzen) und `undefined`
(nicht gesendet) verhalten sich heute identisch (beides wird durchgelassen
oder verworfen, je Feld inkonsistent). Frontend-Resets werden teilweise
stillschweigend ignoriert.

#### Storage-Layer (Hauptbaustellen — bulk Pattern)

| Datei | Zeilen | Anzahl Felder | Priorität |
| --- | --- | --- | --- |
| `server/storage/service-catalog.ts` | 138–154 | 15 (zwei Branches) | hoch — meiste Felder |
| `server/storage/time-tracking/entries.ts` | 177–184 | 8 | hoch |
| `server/storage/tasks.ts` | 140–155 | 8 | hoch |
| `server/storage/customer-management.ts` | 493, 499, 510, 513, 534, 555 | 6 Branches mit Audit-Logs | mittel (komplexer wegen Audit-Pflicht) |
| `server/storage/documents.ts` | 50 | 1 (`batchLabel`) | niedrig |

#### Route-Handler-Layer (sechs Pfade gem. Acceptance, vollständige Liste)

| Datei | Zeilen | Bemerkung |
| --- | --- | --- |
| `server/routes/admin/prospects.ts` | 82 | Doppelte Prüfung `parsed.data.status && parsed.data.status !== undefined` — redundant |
| `server/routes/admin/employee-users.ts` | 289, 300, 327 | `isAdmin`/`isTeamLead`-Gating + `geburtsdatum` |
| `server/routes/admin/customers.ts` | 622, 636, 637, 642 | `geburtsdatum`-Validierung + Name-Change-Audit |
| `server/routes/admin/insurance-providers.ts` | 61, 71, 72 | Fallback-Mapping `ikNummer`/`isPrivate` |
| `server/routes/admin/customers/contracts.ts` | 123 | `contractEnd`-Ende-Prüfung |
| `server/routes/customers/service-prices.ts` | 57 | Mehrfach-`||`-Kette in `.refine` |
| `server/routes/budget.ts` | 295 | `monthlyLimitCents`-Combined-null-undefined-Check |
| `server/routes/time-entries.ts` | 460–479 | 5 Fallback-Variablen für Update-Validierung |
| `server/routes/appointments.ts` | 951, 1040, 1079–1102, 1203–1220 | Scheduling-Change-Detection (≥ 15 Treffer) |
| `server/routes/appointment-series.ts` | 427–635 | Series-Update-Mapping (≥ 12 Treffer) |

#### Service-Layer

| Datei | Zeilen | Bemerkung |
| --- | --- | --- |
| `server/services/appointments.ts` | 390–422 | Audit-Field-Tracking |
| `server/services/auth.ts` | 470 | Name-Change-Trigger |
| `server/services/email-parser.ts` | 69 | `RegExp`-Match-Index — KEIN Mutation-Pfad, falsch-positiv |

**Maßnahme** (in Folge-Task):
1. Zentrale Helper-Funktion `pickDefinedFields(data, allowedKeys)` in
   `server/lib/`.
2. Pro Storage-Funktion expliziter PATCH-Schema-Typ mit Konvention
   `null = löschen`, `undefined = nicht ändern`.
3. **Reihenfolge zwingend**: ERST Round-Trip-Tests pro Storage-Funktion
   mit `null` UND `undefined` explizit, DANN Helper einführen, sonst
   maskiert die Umstellung Verhaltensänderungen.

**Bewusst nicht behandelt**:
- `server/routes/appointments.ts` und `server/routes/appointment-series.ts`
  haben das Pattern für **Change-Detection** (Audit-Trigger), nicht für
  Field-Mapping. Das ist semantisch korrekt und gehört NICHT in den
  Helper-Sweep — wird mit dem Split aus Abschnitt 2b geklärt.
- `server/services/email-parser.ts:69` ist eine `RegExp.exec`-Index-Prüfung,
  keine Datenmutation.

### 4d. ESLint-Disable-Audit (12 Treffer in 8 Dateien)

Pro Disable klären, ob:
1. Die Regel hier wirklich nicht passt → Disable behalten + Begründung als
   Kommentar darüber (Pflicht).
2. Es ein lokaler Hack ist → Code anpassen, Disable raus.

Files mit Disables (sortiert nach Aufwand):
- `client/src/pages/admin/users.tsx`
- `client/src/pages/admin/customer-detail.tsx`
- `client/src/pages/edit-appointment.tsx`
- `client/src/features/team/components/admin-permissions-section.tsx`
- `client/src/features/customers/components/admin/customer-contract-tab.tsx`
- `client/src/features/customers/components/admin/customer-detail-sections.tsx`
- `client/src/features/customers/components/admin/customer-contacts-tab.tsx`
- `client/src/features/appointments/hooks/use-appointment-mutations.ts`

## 5. Reihenfolge & Abhängigkeiten

| # | Schritt | Vorbedingung | Risiko | Folge-Task |
| --- | --- | --- | --- | --- |
| 1 | Integrationstests für `billing.ts`-Hauptpfade einfrieren | — | niedrig | #666 (Vorarbeit) |
| 2 | Integrationstests für `appointments.ts`-Hauptpfade einfrieren | — | niedrig | #666 (Vorarbeit) |
| 3 | Storage-Layer-Migration der 6 Routen (Sprint-2-Task) | — | mittel | bestehender Task |
| 4 | Split `billing.ts` → `server/routes/billing/*` | 1, 3 | mittel | #666 |
| 5 | Split `appointments.ts` → `server/routes/appointments/*` | 2 | mittel | #666 |
| 6 | Dead-Code-Sweep (Knip-Liste durchgehen) | 4, 5 | niedrig | neu |
| 7 | `toISOString()`-Sweep (Geschäftsdatum vs. Zeitstempel klassifizieren) | — | mittel | neu |
| 8 | Silent-Drop-Pfad-Sweep + `pickDefinedFields`-Helper | — | mittel | neu |
| 9 | Frontend-Page-Splits (Tabelle 1a, von oben nach unten) | — | niedrig pro Page | je Page eigener Task |
| 10 | Feature-Datei-Splits (Tabelle 1b) | 9 (teilweise) | niedrig | je Datei eigener Task |
| 11 | ESLint-Disable-Audit | 9, 10 | niedrig | neu |

Schritte 1–2 sind **harte Vorbedingung** für 4–5. Schritte 6–8 sind
unabhängig voneinander und können parallel laufen. Schritte 9–10 hängen
NICHT vom Server-Split ab und können sofort beginnen.

## 6. Out-of-Scope (bewusst nicht in diesem Plan)

- Eigentlicher Split `billing.ts` / `appointments.ts` (= Task #666).
- KM-Float-Migration (eigener Task).
- A11y/PWA-Fixes (= Task #667).
- SQL-Injection-Fix (= Task #665).
- Schema-Migrationen jeglicher Art.
- Performance-Tuning (Bundle-Size, Query-Indexes).

## 7. Quick-Wins in diesem Task (erledigt)

1. `replit.md`: `drizzle-kit push:pg` → `drizzle-kit push` (Drizzle-Kit
   hat das `:pg`-Suffix seit Version 0.20 entfernt).
2. `parseLocalDate`-Duplikat in `shared/domain/appointments.ts` entfernt;
   nutzt jetzt den Export aus `shared/utils/datetime.ts`.
3. `server/startup/ensure-erstberatung-prospect-link.ts` gelöscht —
   `ensureErstberatungProspectLinkConstraint()` wurde nie vom Boot-Pfad
   aufgerufen, das CHECK-Constraint ist nie aktiv geworden. Application-Level
   Guard in `createCustomerDirect` bleibt bestehen; Kommentar dort
   aktualisiert.

## 8. Audit-2026-Refresh (#822, Commit 178b2574, 2026-05-29)

Querverweis aus dem Full-App-Audit-Refresh (`docs/audits/full-app-2026/REPORT.md` §6).
Neue/eskalierte Simplification-/Performance-Posten seit dem 2026-05-27-Sweep:

- **`server/routes/billing.ts` = 3656 LOC** (war 2131) — neuer Top-Monolith.
  PDF-/Qonto-/Storno-Logik nach `billing-service.ts` extrahieren (vgl. §6 Out-of-Scope
  Task #666; jetzt höchste Priorität unter den Route-Splits).
- **`server/storage/budget/allocation-storage.ts` = 1274 LOC** und
  **`client/src/components/budget/BudgetTypeSettings.tsx` = 1169 LOC** — neue >1000-LOC-Posten.
- **`client/src/pages/admin/billing.tsx` = 1772 LOC** (war ~1445) — weiter gewachsen.
- **Startup-Migrations-Retirement:** ~30 einmalige Backfills weiter im Boot-Pfad
  (Liste in `docs/audits/full-app-2026/chunks/16-devops-startup.md`). KEEP: Seeds,
  `sync-budget-allocations`, `migrate-km-geo-to-numeric`, `prospect-customer-matching`,
  `audit-*`-Integritätsläufe, `encrypt-company-secrets`.
- **`invalidateRelated`-Adoption ~20 %** (M10 im Audit) — Disziplin breiter ausrollen.
- **Performance:** Lexware-Export-N+1, fehlende Indizes (`performedByEmployeeId`,
  `import_batch_id`), fehlende `.limit()`/Pagination auf vielen Storage-List-Queries.

Schema-Migrationen aus dem Audit (real→numeric `monthly_work_hours`, IBAN/BIC-Encryption)
laufen als eigene Fix-Tasks (`.local/tasks/proposed-from-822/`), nicht über diesen Plan.
