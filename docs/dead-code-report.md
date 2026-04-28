# Dead-Code-Bericht

**Erstellt:** 2026-04-28 · **Werkzeuge:** `knip@6.7`, `ts-prune@0.10`, gezielte ripgrep-Checks · **Codebasis:** ~104.800 Zeilen TS/TSX

> **Wichtig:** Dieser Bericht ist **rein analytisch**. Es wurde **kein Code gelöscht**, **keine Datei verschoben**, **kein Schema geändert**. Die eigentliche Bereinigung erfolgt erst nach expliziter Freigabe in einer Folge-Aufgabe — und **zwingend erst, nachdem die Refactoring-Sprints #107/#108/#109 gemerged sind**, weil dort viele dieser Symbole ggf. wieder reaktiviert oder umgebaut werden.

## Coverage / Blind Spots

Damit klar ist, was dieser Bericht **nicht** abdeckt:

| Bereich | Status | Begründung |
|---------|--------|------------|
| `client/src/components/ui/**` (shadcn-Komponenten) | **nicht analysiert** | In `knip.json` per `ignore` ausgenommen — Shadcn-Bibliothek wird bewusst komplett ausgeliefert. |
| `server/replit_integrations/**` | **nicht analysiert** | In `knip.json` per `ignore` ausgenommen — von Replit-Plattform vorgegeben, kein Cleanup-Kandidat. |
| `tests/**/*.test.ts` | **nicht prüfbar** | In `knip.json` als `entry` eingetragen → jede Testdatei gilt als Wurzelpunkt; tote Tests können so nicht erkannt werden. Eigene Untersuchung nötig. |
| `package.json` Dependencies | **statisch analysiert** | Direkter String-Treffer pro Paket gegen alle Source- + Config-Dateien. Siehe Abschnitt 6a. Transitive-Dependency-Auflösung und CI-Pipeline-Cross-Check bleibt Folge-Task #220. |
| Schema-Spalten (`shared/schema/**`) auf Spaltenebene | **statisch analysiert** | Property-Zugriff-Suche pro Spalte gegen `server/` + `client/src/`. Siehe Abschnitt 5.2. Drizzle-Spread-Inserts und Produktions-DB-Befüllung können statisch nicht abschließend bewertet werden — daher alle Verdachtskandidaten als `bitte prüfen`, definitive Klärung im Folge-Task #219. |
| Drizzle-Migrations (`migrations/`) | **nicht analysiert** | Migrations-Historie darf nie rückwirkend geändert werden. |
| `client/src/features/*/hooks/index.ts` | **als entry markiert** | In `knip.json` als `entry` eingetragen → Re-Exports darin werden nicht als „tot" erkannt. ts-prune fängt sie auf, daher trotzdem im Bericht. |

## Risiko-Skala

| Kategorie | Bedeutung |
|-----------|-----------|
| `sicher löschbar` | Nur lokal verwendet oder gar nicht; keine externen Konsumenten; keine Tests; keine dynamischen Aufrufe; kein Public-API-Vertrag. Risiko praktisch null. |
| `wahrscheinlich löschbar` | Export ohne erkennbaren internen Konsumenten. Restrisiko: könnte von externen Skripten / Cronjobs / Migrations genutzt werden. |
| `bitte prüfen` | Wirkt ungenutzt, aber Hinweise auf dynamischen Zugriff (Reflection, String-basierte Routes, Drizzle-Migrations-Historie, externe API-Verträge), oder Kollision mit laufendem Refactoring-Sprint. |
| `nicht anfassen` | Schema-Felder mit Produktionsdaten, öffentliche API-Routes, Felder in Migrations-Historie, Funktionen mit Test-Coverage. |

## Aufwand-Skala

| Symbol | Bedeutung |
|--------|-----------|
| `XS` | < 5 min — `export` entfernen, Re-Export-Zeile löschen, etc. |
| `S` | 5–15 min — kleine Funktion oder Typ entfernen, ggf. Imports nachziehen. |
| `M` | 15–60 min — Klassen-Wrapper oder Helper-Modul entfernen, Cross-Modul-Imports prüfen. |
| `L` | 1–3 h — Bereich umbauen, Tests anpassen. |
| `?` | Nicht abschätzbar bevor Sprint-Kollision geklärt ist. |

---

## 0. Schnell-Überblick

| Bereich | sicher löschbar | wahrscheinl. löschbar | bitte prüfen | nicht anfassen |
|---------|:-:|:-:|:-:|:-:|
| Frontend-Code | 12 | 4 | 6 | – |
| Backend-Services | 7 | 5 | 4 | – |
| Backend-Storage | 8 | 3 | 5 | – |
| Routes-Layer | 4 | 0 | 1 | – |
| API-Routes (Datei-Ebene) | 0 | 0 | 0 | 29 (alle aktiv) |
| Schema-Tabellen (Tabellen-Ebene) | 0 | 0 | 0 | 21 (alle benötigt) |
| Schema-Spalten (Spalten-Ebene) | 0 | 0 | 47 | ~553 |
| Dependencies (`package.json`) | 0 | 0 | 2 | 14 (Build/Types implizit) |
| Shared-Utils & Types | 11 | 2 | 4 | – |
| **Summe** | **42** | **14** | **69** | **617** |

Geschätzter Code-Reduktions-Spielraum bei Komplettausführung: **ca. 1.500–2.200 Zeilen** (≈1,5–2 % der Codebase). Größter Effekt liegt bei toten Re-Exports und ungenutzten Helper-Funktionen.

---

## 1. Frontend-Code (`client/src/`)

### 1.1 Tote Re-Export-Index-Dateien

Mehrere `index.ts`-Dateien sind **vollständig redundant**: Konsumenten importieren direkt aus den Modulen, der zentrale Re-Export wird nirgends genutzt.

| Pfad:Zeile | Symbol | Kategorie | Aufwand | Begründung |
|-----------|--------|-----------|:-------:|------------|
| `client/src/lib/api/index.ts:1-15` | komplette Datei | `sicher löschbar` | XS | 0 Importe von `@/lib/api`. Alle Konsumenten importieren `@/lib/api/client` oder `@/lib/api/types` direkt. |
| `client/src/components/charts/index.ts:1-5` | StatCard, BarSimple, BarStacked, DonutChart, CockpitKPI Re-Exports | `sicher löschbar` | XS | Komponenten selbst aktiv (22, 9, 9, 6, 6 Treffer), aber Konsumenten importieren aus `@/components/charts/<file>`. |
| `client/src/components/patterns/index.ts:9-11` | DataList, DataListItem, EmptyState, StatusBadge Re-Exports | `sicher löschbar` | XS | Gleiches Muster: Komponenten leben weiter, Index-Re-Export ist tot. `SectionCard`/`PageHeader` werden ebenfalls direkt importiert. |
| `client/src/features/appointments/components/index.ts:1` | AppointmentCard Re-Export | `sicher löschbar` | XS | `AppointmentCard` selbst aktiv, der Index nicht konsumiert. |

### 1.2 Tote Hook-Re-Exports in Feature-Indizes

| Pfad:Zeile | Symbol | Kategorie | Aufwand | Begründung |
|-----------|--------|-----------|:-------:|------------|
| `client/src/features/prospects/index.ts:1` | `useProspectAppointmentData` | `sicher löschbar` | XS | Hook in `hooks/use-prospects.ts:34` — kein Konsument im Frontend. |
| `client/src/features/time-tracking/hooks/use-month-closing.ts:59,71` | `useMonthClosingReadiness`, `useMonthClosingPreview` | `wahrscheinlich löschbar` | S | Vor #128 ersetzt; Admin-Variante (`useAdminMonthClosingReadiness`) wird genutzt. ⚠️ Kollidiert mit Sprint #108. |
| `client/src/features/time-tracking/hooks/use-time-entries.ts:20` | `timeEntryKeys` | `bitte prüfen` | ? | React-Query-Key-Factory — wirkt ungenutzt, aber Cache-Invalidierungen könnten sich darauf stützen. |

### 1.3 Lokale Helper, die exportiert sind aber nur intern genutzt

ts-prune meldet **150 Exports mit Marker `(used in module)`** — alle Kandidaten zum Unexportieren. Beispiele (vollständige Liste in `/tmp/ts-prune.log`):

| Pfad:Zeile | Symbol | Kategorie | Aufwand | Begründung |
|-----------|--------|-----------|:-------:|------------|
| `client/src/components/error-boundary.tsx:65` | `resetChunkReloadCount` | `sicher löschbar` | XS | Nur intern verwendet — `export`-Schlüsselwort entfernen. |
| `client/src/hooks/use-toast.ts:74,191` | `reducer`, `toast` | `sicher löschbar` | XS | Nur intern. |
| `client/src/hooks/use-auth.tsx:14,32,187` | `User`, `AuthState`, `canCreateHauswirtschaft` | `bitte prüfen` | S | Typ-Re-Use im Test denkbar — vor Unexportieren `tests/`-Imports prüfen. |
| `client/src/lib/public-branding.ts:4` | `PublicBranding` | `sicher löschbar` | XS | |
| `client/src/features/appointments/hooks/use-appointment-series.ts:68,77` | `SeriesPreviewResponse`, `SeriesCreateResponse` | `sicher löschbar` | XS | |

> **Empfehlung:** Diese Klasse von Funden ist systematisch — ein einmaliger Lint-Lauf mit `eslint-plugin-import` Regel `no-internal-modules` oder ein TS-Codemod könnte das in einem Rutsch erledigen, sobald die Refactoring-Sprints durch sind.

### 1.4 Hauswirtschaft-/Statistik-Pages

| Pfad:Zeile | Symbole | Kategorie | Aufwand | Begründung |
|-----------|---------|-----------|:-------:|------------|
| `client/src/pages/admin/statistics/helpers.ts:55-279` | `MarginData`, `UtilizationData`, `BudgetData`, `BudgetPrevData`, `CockpitData`, `CustomerStats`, `BudgetUtilization`, `ServicePrice`, `ProfitabilityTotals`, `GrowthSummary`, `PlanningTotals` | `bitte prüfen` | M | Statistik-Typen — ggf. Vorbereitung für noch nicht fertig integrierte Charts. |
| `client/src/pages/admin/components/customer-pricing-section.tsx:80` | `PricingSectionProps` | `sicher löschbar` | XS | |
| `client/src/pages/admin/components/customer-types.ts:71` | `StepConfig` | `sicher löschbar` | XS | |

### 1.5 Vollständig referenzierte Pages

Alle 23 Pages in `client/src/pages/*.tsx` werden geroutet (App.tsx) bzw. von einer Page importiert (`setup.tsx` ← `login.tsx`). **Keine verwaisten Pages.**

---

## 2. Backend-Services (`server/services/`)

### 2.1 Service-Klassen-Wrapper ohne Konsumenten

Mehrere Services exportieren eine **Klasse**, die nirgendwo instanziiert wird. Die zugrundeliegenden Funktionen sind teilweise weiter im Einsatz — nur der Klassen-Wrapper ist tot.

| Pfad:Zeile | Symbol | Kategorie | Aufwand | Begründung |
|-----------|--------|-----------|:-------:|------------|
| `server/services/auth.ts:85` | `AuthService` (Klasse) | `sicher löschbar` | M | Klassenname kommt nur in der Definition vor; Auth-Funktionen werden über Routen-Helper genutzt. |
| `server/services/whatsapp-service.ts:37` | `WhatsAppService` (Klasse) | `wahrscheinlich löschbar` | M | Klassenname nur in der Definition. ⚠️ WhatsApp-Webhook könnte dynamisch zugreifen — vor Löschung Webhook-Pfad prüfen. |
| `server/services/whatsapp-reminder-scheduler.ts:9` | `sendDailyAppointmentReminders` | `bitte prüfen` | ? | Klingt wie Cron-Endpoint — ggf. via Replit-Scheduler aufgerufen. **Vor Löschung Scheduler-Konfig prüfen.** |
| `server/services/call-scheduler.ts:53` | `calculateNextCallTime` | `wahrscheinlich löschbar` | S | Helper, der nirgends importiert wird. |

### 2.2 Tote Helper-Funktionen

| Pfad:Zeile | Symbol | Kategorie | Aufwand | Begründung |
|-----------|--------|-----------|:-------:|------------|
| `server/services/template-engine.ts:200` | `buildPlaceholdersFromFormData` | `wahrscheinlich löschbar` | S | Andere Placeholder-Pfade aktiv; dieser Eintrag wirkt verwaist. |
| `server/services/cover-letter.ts:55` | `renderCoverLetterText` | `sicher löschbar` | S | Cover-Letter wird per HTML/PDF gerendert; Text-Variante ohne Konsumenten. |
| `server/services/document-pdf.ts:243,247` | `generateSigningToken`, `hashToken` | `bitte prüfen` | ? | Klingt nach Public-Signing-Flow. **Vor Löschung gegen `server/routes/public-signing.ts` abgleichen** — ggf. dort dupliziert. |
| `server/services/travel-time.ts:21,35,51` | `calculateBuffer`, `calculatePickupTime`, `getOsrmRoute` | `wahrscheinlich löschbar` | M | 0 externe Treffer. OSRM-Routing wirkt vorbereitend, aber nicht eingebaut. |
| `server/services/appointment-series.ts:42` | `generateSeriesDates` | `sicher löschbar` | XS | Innere Helper-Funktion; Series-Logik nutzt anderen Pfad. |

### 2.3 Tote Typ-Aliase in Services

Häufig: Service-Modul exportiert Typen für seine eigene API, die intern auch wieder aufgegriffen werden.

| Pfad:Zeile | Typ | Kategorie | Aufwand | Begründung |
|-----------|-----|-----------|:-------:|------------|
| `server/services/appointments.ts:21,27,33,40,52,63,83` | `OverlapCheckResult`, `ValidationResult`, `DocumentationServiceEntry`, `DocumentationInput`, `DocumentationResult`, `KundenterminInput`, `AppointmentService` | `sicher löschbar` | XS | Alle nur intern verwendet — `export` entfernen. |
| `server/services/appointment-import.ts:11,31,49,55` | `ImportRow`, `BudgetTrimInfo`, `ImportAction`, `ImportResult` | `sicher löschbar` | XS | Alle nur intern. |
| `server/services/auto-breaks.ts:16` | `AutoBreakResult` | `sicher löschbar` | XS | Nur intern. |
| `server/services/avis-parser.ts:1,15,26` | `ParsedAvisHeader`, `ParsedAvisItem`, `ParsedAvis` | `sicher löschbar` | XS | |
| `server/services/qonto-csv-parser.ts:54` | `QontoCsvImportResult` | `sicher löschbar` | XS | |
| `server/services/email-parser.ts:3` | `ParsedLead` | `sicher löschbar` | XS | |
| `server/services/employee-availability.ts:94,110,116` | `WeeklyAvailabilityDay`, `WeeklyAvailabilityEmployee`, `WeeklyAvailabilityResponse` | `sicher löschbar` | XS | |
| `server/services/document-trigger-engine.ts:7` | `DocumentRequirement` | `sicher löschbar` | XS | |
| `server/services/time-entry-validation.ts:19` | `CheckTimeConflictsArgs` | `sicher löschbar` | XS | |
| `server/services/template-engine.ts:7,135` | `TemplatePlaceholders`, `InputField` | `sicher löschbar` | XS | Nur intern. |

### 2.4 ZUGFeRD

| Pfad:Zeile | Symbol | Kategorie | Aufwand | Begründung |
|-----------|--------|-----------|:-------:|------------|
| `server/lib/zugferd.ts:369` | `generateZugferdXml` | `bitte prüfen` | ? | Compliance-Funktion, die ggf. erst bei aktiviertem ZUGFeRD-Modus genutzt wird. **Nicht löschen ohne Billing-Verantwortlichen zu fragen.** |

---

## 3. Backend-Storage (`server/storage/`)

> ⚠️ **Sprint-Kollision:** Sprint #108 (Architektur-Konsistenz / Storage-Layer-Umstellung) wird genau in diesem Bereich umbauen. Funde aus Abschnitt 3 sind als „Vor-Bereinigung" gefährlich — sie sollten **nach #108** erneut erhoben werden.

### 3.1 Tote Klassen-Wrapper

Wie in Services: Mehrere Storage-Module exportieren eine Klasse, die nirgendwo instanziiert wird. Funktionen werden statisch aufgerufen.

| Pfad:Zeile | Symbol | Kategorie | Aufwand | Begründung |
|-----------|--------|-----------|:-------:|------------|
| `server/storage.ts:200` | `DatabaseStorage` (Klasse) | `bitte prüfen` | ? | ⚠️ Sprint #108 — die Klasse wird derzeit aktiv refaktoriert und ggf. behalten. |
| `server/storage/service-catalog.ts:65,77` | `IServiceCatalogStorage` (Interface), `ServiceCatalogStorage` (Klasse) | `bitte prüfen` | ? | ⚠️ Sprint #108 |
| `server/storage/documents.ts:74,82,88,116` | `DocumentBatch`, `GroupedDocumentsByType`, `IDocumentStorage`, `DocumentStorage` | `bitte prüfen` | ? | ⚠️ Sprint #108 |
| `server/storage/customer-management.ts:46,58,64,66,89` | `CustomerListFilters`, `PaginationOptions`, `PaginatedResult`, `CustomerListItem`, `CustomerManagementStorage` | `bitte prüfen` | ? | ⚠️ Sprint #108 |

### 3.2 Tote Tasks-Funktionen

| Pfad:Zeile | Symbol | Kategorie | Aufwand | Begründung |
|-----------|--------|-----------|:-------:|------------|
| `server/storage/tasks.ts:231,342` | `findMonthClosingTask`, `findBirthdayTask` | `sicher löschbar` | S | Nur in eigener Datei deklariert; im gesamten Repo kein Aufruf. Ersetzt durch `ensure*`/`complete*Task`-Varianten. |
| `server/storage/tasks.ts:405,425` | `completeBirthdayTask`, `reopenBirthdayTask` | `sicher löschbar` | S | Keine Aufrufer. Aufruferseite nutzt die `*All*`-Varianten. |
| `server/storage/tasks.ts:10` | `TaskWithRelations` | `sicher löschbar` | XS | Nur intern verwendet. |

### 3.3 Tote Storage-Helper

| Pfad:Zeile | Symbol | Kategorie | Aufwand | Begründung |
|-----------|--------|-----------|:-------:|------------|
| `server/storage/whatsapp.ts:22` | `upsertWhatsAppNotificationRule` | `wahrscheinlich löschbar` | S | Kein Konsument; vorher Notification-Regelwerk-Refactor prüfen. |
| `server/storage/appointment-helpers.ts:41,125` | `assignedEmployee`, `AppointmentQueryRow` | `sicher löschbar` | XS | |
| `server/storage/budget/cap-calculator.ts:17,29,44` | `getMonthRange`, `getYearRange`, `netConsumedInRange` | `sicher löschbar` | XS | 0 externe Treffer; rein intern. |
| `server/storage/budget/cap-calculator.ts:8,9,12,74,82` | `MonthlyBudgetType`, `YearlyBudgetType`, `DateRange`, `CapInputs`, `CapResult` | `sicher löschbar` | XS | Alle nur intern. |
| `server/storage/budget-ledger.ts:1,2,24` | `BudgetSummary`, `Budget45aSummary`, `Budget39_42aSummary`, `AllBudgetSummaries`, `CascadeResult`, `DbClient`, `BudgetLedgerStorage` | `bitte prüfen` | ? | ⚠️ Sprint #108 |
| `server/storage/qonto.ts:15` | `PaymentAdviceWithItems` | `sicher löschbar` | XS | |
| `server/storage/time-tracking/appointments.ts:78` | `AppointmentServiceDetail` | `sicher löschbar` | XS | |
| `server/storage/budget/import-availability.ts:9` | `DateAwareAvailability` | `sicher löschbar` | XS | |
| `server/storage/appointment-series-storage.ts:24` | `SeriesWithCustomerName` | `sicher löschbar` | XS | |

### 3.4 Helper im Routes-Layer mit überflüssigem `export`

> **Wichtige Klarstellung:** Die Funktionen in dieser Tabelle sind **NICHT tot**. Sie werden aktiv genutzt — aber **nur innerhalb derselben Datei**. Das `export`-Schlüsselwort ist überflüssig. Hier geht es ausschließlich darum, das `export` zu entfernen, **nicht die Funktion selbst zu löschen**.

| Pfad:Zeile | Symbol | Kategorie | Aufwand | Begründung |
|-----------|--------|-----------|:-------:|------------|
| `server/routes/appointments.ts:84` | `checkCustomerAccess` | `sicher löschbar` (nur `export`) | XS | Wird in derselben Datei in Zeilen 478, 499 genutzt. **Kein** anderes Modul importiert sie. (Achtung: gleichnamige, eigenständige Funktionen existieren in `server/middleware/object-storage-auth.ts` und `server/routes/budget.ts` — nicht zusammenwerfen.) |
| `server/routes/appointments.ts:149` | `checkAppointmentReassignAccess` | `sicher löschbar` (nur `export`) | XS | Wird in derselben Datei in Zeile 812 genutzt. Kein Cross-Modul-Import. |
| `server/lib/conversion-schemas.ts:66` | `convertCustomerSchema` | `sicher löschbar` | S | Tatsächlich kein Konsument vorhanden. |
| `server/lib/duplicate-check.ts:5` | `DuplicateCustomer` | `sicher löschbar` (nur `export`) | XS | Typ wird in derselben Datei verwendet. |
| `server/lib/errors.ts:11` | `ErrorCodes` | `bitte prüfen` | S | Wird intern weit verzweigt genutzt; Export könnte für Tests gebraucht werden. Lieber unexportieren statt löschen. |

---

## 4. API-Routes

**Vollständige Verifikation: alle 29 Route-Dateien in `server/routes/**` sind registriert.**

Methodik: Jede `*.ts`-Datei in `server/routes/` (außer `index.ts`) wurde gegen `import …Router from "./…"`-Anweisungen im gesamten `server/`-Tree gegen-gegrept.

### 4.1 Top-Level (in `server/routes/index.ts` registriert) — 24 Module

`appointments`, `customers`, `auth`, `admin`, `team`, `time-entries`, `birthdays`, `birthday-cards`, `budget`, `tasks`, `service-records`, `services`, `search`, `settings`, `profile`, `company`, `billing`, `holidays`, `statistics`, `webhook`, `notifications`, `whatsapp`, `prospects`, `appointment-series`.

### 4.2 Nested (von einem anderen Route-Modul registriert) — 5 Module

| Modul | Eingebunden von | Mount-Pfad |
|-------|-----------------|------------|
| `month-closing` | `routes/time-entries.ts:13` | unter `/time-entries` |
| `appointment-documentation` | `routes/appointments.ts:38` | unter `/appointments` |
| `customers/contacts`, `customers/service-prices`, `customers/documents` | `routes/customers.ts:23-25` | unter `/customers` |
| `statistics/revenue`, `statistics/operations`, `statistics/customers` | `routes/statistics.ts:7-9` | unter `/statistics` |
| `admin/employees`, `admin/customers`, `admin/insurance-providers`, `admin/time-tracking`, `admin/documents`, `admin/audit`, `admin/lexware-export`, `admin/document-delivery`, `admin/prospects`, `admin/qonto`, `admin/whatsapp`, `admin/import-appointments`, `admin/contact-migration`, `admin/test-cleanup` | `routes/admin.ts:8-21` | unter `/admin` |
| `admin/customers/{assignments,budgets,details,contracts,workflows,duplicates}` | `routes/admin/customers.ts:25-30` | unter `/admin/customers` |
| `public-signing`, `webhook-twilio` | `server/index.ts` | separate Mount-Stellen |

→ **Alle Route-Dateien sind aktiv. Risiko-Einstufung: alle `nicht anfassen` (öffentliche API-Verträge). Keine Funde, kein Handlungsbedarf.**

---

## 5. Schema-Felder (`shared/schema/`)

### 5.1 Tabellen-Übersicht (Datei-Ebene)

Alle 21 Schema-Dateien werden aktiv verwendet. **Risiko-Einstufung auf Datei-Ebene: durchgehend `nicht anfassen`** — Drizzle-Tabellen sind Public-DB-Vertrag, mit Produktionsdaten belegt und in der Migrations-Historie verankert.

| Pfad | LOC | Kategorie | Aufwand | Begründung |
|------|----:|-----------|:-------:|------------|
| `shared/schema/documents.ts` | 337 | `nicht anfassen` | – | Größte Tabelle; Dokumenten-Workflow inkl. Signing aktiv. |
| `shared/schema/customers.ts` | 294 | `nicht anfassen` | – | Stammdaten — Produktionsdaten. |
| `shared/schema/appointments.ts` | 287 | `nicht anfassen` | – | Kerngeschäft. |
| `shared/schema/users.ts` | 269 | `nicht anfassen` | – | Auth-relevant. |
| `shared/schema/budget.ts` | 240 | `nicht anfassen` | – | Pflegekassen-Budgets — komplexer Domänen-State. |
| `shared/schema/prospects.ts` | 207 | `nicht anfassen` | – | Lead-Workflow aktiv. |
| `shared/schema/common.ts` | 173 | `nicht anfassen` | – | Geteilte Helpers (Phone, Timestamp). |
| `shared/schema/company.ts` | 156 | `nicht anfassen` | – | Mandanten-Settings. |
| `shared/schema/insurance.ts` | 124 | `nicht anfassen` | – | Pflegekassen-Verzeichnis. |
| `shared/schema/billing.ts` | – | `nicht anfassen` | – | Rechnungslauf — Compliance. |
| `shared/schema/contracts.ts` | – | `nicht anfassen` | – | Kunden-Verträge. |
| `shared/schema/qualifications.ts` | – | `nicht anfassen` | – | Pflegegrad-Qualifikationen. |
| `shared/schema/service-records.ts` | – | `nicht anfassen` | – | Monats-Leistungsnachweise. |
| `shared/schema/services.ts` | – | `nicht anfassen` | – | Leistungskatalog. |
| `shared/schema/system.ts` | – | `nicht anfassen` | – | System-Settings. |
| `shared/schema/notifications.ts` | – | `nicht anfassen` | – | Benachrichtigungen. |
| `shared/schema/audit.ts` | – | `nicht anfassen` | – | Audit-Log. |
| `shared/schema/time-tracking.ts` | – | `nicht anfassen` | – | Zeiterfassung. |
| `shared/schema/birthday-cards.ts` | – | `nicht anfassen` | – | Geburtstagskarten-Workflow. |
| `shared/schema/tasks.ts` | – | `nicht anfassen` | – | Aufgaben-Tabelle. |
| `shared/schema/qonto.ts` | – | `nicht anfassen` | – | Qonto-Integration. |
| `shared/schema/whatsapp.ts` | – | `nicht anfassen` | – | WhatsApp-Integration. |
| `shared/schema/customer-full.ts` | – | `nicht anfassen` | – | Kunden-Aggregat-Typ. |

### 5.2 Spalten-Ebene — statische Erst-Analyse

**Methodik:** Für jede Spalte (außer `id`) in den 21 Schema-Dateien wurde per ripgrep geprüft, ob sie in `server/` oder `client/src/` als Property-Zugriff (`.colName`) referenziert wird. Spalten ohne Treffer sind **Verdachtskandidaten**, **nicht** garantiert tot — siehe Vorbehalte unter der Tabelle.

**Ergebnis:** Von ~600 Spalten haben **47 keinen statischen Property-Treffer** in `server/` oder `client/src/`. Verteilung:

| Tabelle | Spalten ohne Treffer | Kategorie | Aufwand | Konkrete Spalten |
|---------|:--:|-----------|:-------:|------------------|
| `billing.ts` | 4 | `bitte prüfen` | ? | `pdfPath`, `pdfHash`, `leistungsnachweisPath`, `leistungsnachweisHash` — vermutlich dynamisch über `returning()`/Drizzle-Inserts; PDF-Workflow aktiv |
| `birthday-cards.ts` | 1 | `bitte prüfen` | ? | `sentByUserId` — Audit-Spalte, ggf. nur in Insert |
| `budget.ts` | 1 | `bitte prüfen` | ? | `initialBalanceCents` — Sprint #108 Kollision wahrscheinlich |
| `company.ts` | 8 | `bitte prüfen` | ? | `lohnartHauswirtschaft/Alltagsbegleitung/Urlaub/Krankheit`, `epostLetterId`, `generatedDocumentId`, `deliveredAt`, `updatedByUserId` — Lohnart-Felder evtl. via Lexware-Export-Job genutzt |
| `customers.ts` | 11 | `bitte prüfen` | ? | `serviceKreativ`, `serviceGrundpflege`, `serviceFreizeitgestaltung`, `pflegedienstBeauftragt`, `pflegegradBeantragt`, `sonstigeLeistungen`, `householdSize`, `anamnese`, `anonymizedAt`, `changedByUserId`, `changedByRole` — Anamnese-/Service-Flags evtl. veralt., Audit-Felder evtl. dynamisch |
| `documents.ts` | 2 | `bitte prüfen` | ? | `uploadedByUserId`, `signedByEmployeeId` — Audit-Spalten |
| `prospects.ts` | 3 | `bitte prüfen` | ? | `createdBy`, `lastError`, `executedAt` — Workflow-Felder, Sprint-Kollision möglich |
| `qonto.ts` | 1 | `bitte prüfen` | ? | `uploadedByUserId` |
| `qualifications.ts` | 3 | `bitte prüfen` | ? | `assignedAt`, `assignedByUserId`, `isRequired` |
| `service-records.ts` | 4 | `bitte prüfen` | ? | `employeeSigningIp/Location`, `customerSigningIp/Location` — Compliance-/Audit-Felder, evtl. nur per `INSERT … VALUES` geschrieben |
| `system.ts` | 4 | `bitte prüfen` | ? | `closedAt`, `closedByUserId`, `reopenedByUserId`, `updatedByUserId` |
| `users.ts` | 4 | `bitte prüfen` | ? | `deactivatedAt`, `anonymizedAt`, `monthlyTravelAllowanceCents`, `travelCostType` |
| `whatsapp.ts` | 1 | `bitte prüfen` | ? | `metaMessageId` |

**Vorbehalte (warum keine dieser Spalten als „sicher löschbar" gilt):**

1. **Drizzle-Insert-Builder** verwendet die Property häufig nur einmal (im Schema selbst); der eigentliche Wert kommt über das Insert-Objekt rein, ohne Property-Zugriff (`db.insert(table).values({ colName: x })` — die Property `colName` lebt im Schlüssel des Object-Literals, nicht als Member-Access).
2. **Spread-Inserts** (`db.insert(table).values(payload)` mit `payload: typeof table.$inferInsert`) verstecken jeden Spaltennutzen vollständig vor statischer Analyse.
3. **`returning()`** kann ganze Tabellen-Rows zurückgeben, die dann via `result[0]` weitergereicht werden — auch das versteckt Spaltennutzen.
4. **Migrations-Historie:** Selbst wenn eine Spalte heute tot ist, kann sie Produktionsdaten enthalten, die für Audit/Compliance/Backups erhalten bleiben müssen (Pflege-Branche: 10 Jahre Aufbewahrungspflicht).

**Konsequenz:** Alle 47 Verdachtskandidaten werden mit `bitte prüfen` markiert, **keine einzige mit `sicher löschbar`**. Die definitive Entscheidung pro Spalte erfordert pro Verdacht:
- `SELECT count(*) WHERE col IS NOT NULL` auf der Produktions-DB,
- gezielte Suche nach Insert-Payloads (`*: \w+,` statt nur `\.col`),
- Cross-Check mit Lexware-Export-, ePost- und Compliance-Workflows.

→ Dafür ist die Folge-Aufgabe **#219 (Schema-Audit)** angedacht.

---

## 6. Shared-Utils & Types (`shared/`)

### 6.1 Domain-Hilfsfunktionen ohne Konsumenten

| Pfad:Zeile | Symbol | Kategorie | Aufwand | Begründung |
|-----------|--------|-----------|:-------:|------------|
| `shared/domain/appointments.ts:148,161,168,172,176,180` | `STATUS_COLORS`, `SERVICE_TYPE_COLORS`, `getStatusColor`, `getStatusLabel`, `getAppointmentTypeColor`, `getServiceColor` | `sicher löschbar` | S | 0 externe Treffer. Color-Logik vermutlich auf Tailwind-Klassen umgestellt. |
| `shared/domain/appointments.ts:109` | `ServiceInfo` (Typ) | `sicher löschbar` | XS | Nur intern. |
| `shared/domain/customers.ts:48,85` | `DEACTIVATION_REASONS`, `PFLEGEGRAD_VALUES` | `bitte prüfen` | S | Konstanten könnten in Forms genutzt werden — vor Löschung Forms grep. |
| `shared/domain/time-entries.ts:3,56,84,85` | `ENTRY_TYPE_LABELS`, `ENTRY_TYPES_WITHOUT_KILOMETERS`, `WORK_ENTRY_TYPES`, `WorkEntryType` | `bitte prüfen` | S | Möglicherweise erst kürzlich entstanden; Labels in UI sehr wahrscheinlich genutzt. |

### 6.2 Tote Typen in `shared/api/`

| Pfad:Zeile | Typ | Kategorie | Aufwand | Begründung |
|-----------|-----|-----------|:-------:|------------|
| `shared/api/customers.ts:38,49,61,67,95,122` | `CustomerPricingInfo`, `BudgetSummaryInfo`, `CustomerBudgetsInfo`, `CustomerNeedsAssessmentInfo`, `CustomerContractInfo`, `CustomerCareLevelHistoryItem` | `wahrscheinlich löschbar` | M | 1–2 Treffer pro Symbol — tatsächlich nur Eigen-Definition + ggf. Re-Export. |
| `shared/api/time-tracking.ts:60` | `AppointmentServiceBreakdown` | `sicher löschbar` | XS | |
| `shared/api/billing.ts:23` | `InvoiceLineItem` | `bitte prüfen` | S | Name-Kollision mit Drizzle-Typ; vorsichtig prüfen. |
| `shared/api/index.ts` (Sammeldatei mit ~50 Typ-Re-Exports) | mehrere | `bitte prüfen` | M | Re-Export-Index — wenn der Index konsumentenlos ist, in einem Rutsch entfernen. **Vor Löschung explizit per ripgrep gegenchecken.** |

### 6.3 Tote Helper

| Pfad:Zeile | Symbol | Kategorie | Aufwand | Begründung |
|-----------|--------|-----------|:-------:|------------|
| `shared/utils/datetime.ts:29` | `ParsedTime` | `sicher löschbar` | XS | |
| `shared/utils/phone.ts:9,15` | `DACH_COUNTRIES`, `PhoneValidationResult` | `sicher löschbar` | XS | |

---

## 6a. Dependencies (`package.json`)

**Methodik:** Für jede der 76 Dependencies (51 prod + 25 dev) wurde per ripgrep gegen alle Source- und Config-Dateien (`vite.config.ts`, `drizzle.config.ts`, `tailwind.config.ts`, `postcss.config.js`, `components.json`) geprüft, ob der Paketname als String-Literal vorkommt.

**Ergebnis:** **60 von 76 Dependencies** haben mindestens einen direkten String-Treffer. Die übrigen **16** sind erwartbar implizit:

| Paket | Kategorie | Aufwand | Begründung |
|-------|-----------|:-------:|------------|
| `typescript`, `tsx`, `vite`, `vitest`, `esbuild` | `nicht anfassen` | – | Build-/Runtime-Tools, werden über CLI-Skripte in `package.json` aufgerufen, nicht importiert. |
| `postcss`, `autoprefixer`, `tailwindcss` | `nicht anfassen` | – | CSS-Toolchain — werden von Vite/PostCSS implizit geladen via `postcss.config.js`. |
| `@types/bcrypt`, `@types/compression`, `@types/cookie-parser`, `@types/express`, `@types/multer`, `@types/node`, `@types/nodemailer`, `@types/react`, `@types/react-dom`, `@types/ws` | `nicht anfassen` | – | TypeScript-Type-Pakete, werden vom TS-Compiler via `tsconfig.json#types`/`compilerOptions.types` automatisch eingezogen. |
| `@playwright/test` | `bitte prüfen` | S | E2E-Test-Framework. Aktuell **kein** `playwright.config.*` und **keine** `*.spec.ts`-Dateien gefunden. → **Verdacht: ungenutzt.** Vor Löschung CI-Pipeline / GitHub-Actions prüfen, ob dort `npx playwright test` aufgerufen wird. |
| `libphonenumber-js` | `bitte prüfen` | S | Wird **nicht direkt importiert** in der App-Codebase. Eventueller transitive Verwendung durch ein anderes Paket. → vor Löschung `npm ls libphonenumber-js` prüfen. |

**Konkrete Funde zur Aktion:**

- **`@playwright/test`** ist mit hoher Wahrscheinlichkeit obsolet (kein Playwright-Setup vorhanden). Bei einem Dependency-Cleanup-Sprint Top-Kandidat zum Entfernen.
- **`libphonenumber-js`** könnte transitive Dep einer anderen Library sein — vor dem Löschen mit `npm ls` verifizieren.

→ Detaillierte Untersuchung inkl. transitiver Dependencies, Bundle-Size-Effekt und CI-Pipeline-Cross-Check ist dem **Folge-Task #220 (Dependency-Audit)** vorbehalten.

---

## 7. Übersichts-Tabellen (Quick-Wins & Diskussionspunkte)

### 7.1 Empfohlene Quick-Wins — `sicher löschbar`

> ⚠️ **Trotz „sicher löschbar": Erst nach Merge der Refactoring-Sprints #107/#108/#109 anfassen.** Auch isolierte Symbole können zwischenzeitlich von Sprint-Branches re-aktiviert werden — ein Merge-Konflikt mit gelöschtem Code ist viel teurer als 1–2 Wochen warten. Die Quick-Wins werden dann in einer eigenen Folge-Aufgabe (Task #218) gebündelt umgesetzt.

| # | Bereich | Konkretes Symbol / Datei | Aufwand | Geschätzte LOC |
|---|---------|---------------------------|:-------:|---------------:|
| 1 | Frontend (Re-Export-Indizes) | `client/src/lib/api/index.ts`, `components/charts/index.ts`, `components/patterns/index.ts`, `features/appointments/components/index.ts` | 4 × XS | ~40 |
| 2 | Frontend (Hook-Re-Export) | `features/prospects/index.ts:1` (`useProspectAppointmentData`) | XS | ~3 |
| 3 | Frontend (interne Helper) | error-boundary `resetChunkReloadCount`, use-toast `reducer`/`toast`, public-branding, use-appointment-series Typen | 5 × XS | ~10 |
| 4 | Frontend (Pages-Helper) | `customer-pricing-section.tsx:80`, `customer-types.ts:71` | 2 × XS | ~5 |
| 5 | Backend-Service (Klasse) | `server/services/auth.ts:85` `AuthService` | M | ~80 |
| 6 | Backend-Service (Helper) | `cover-letter.ts:55` `renderCoverLetterText`, `appointment-series.ts:42` `generateSeriesDates` | 2 × S | ~30 |
| 7 | Backend-Service (Typen) | 30+ interne Typen aus `appointments.ts`, `appointment-import.ts`, `auto-breaks.ts`, `avis-parser.ts`, `qonto-csv-parser.ts`, `email-parser.ts`, `employee-availability.ts`, `document-trigger-engine.ts`, `time-entry-validation.ts`, `template-engine.ts` | 30 × XS | ~80 |
| 8 | Backend-Storage (Tasks) | `server/storage/tasks.ts:231,342,405,425,10` | 5 × S | ~120 |
| 9 | Backend-Storage (cap-calculator) | 8 interne Symbole in `cap-calculator.ts` | 8 × XS | ~25 |
| 10 | Backend-Storage (Helper) | appointment-helpers, appointment-series-storage, qonto, time-tracking/appointments, budget/import-availability | 6 × XS | ~20 |
| 11 | Routes-Layer (`export` entfernen) | `appointments.ts:84,149`, `lib/duplicate-check.ts:5`, `lib/conversion-schemas.ts:66` | 4 × XS | ~5 (nur Keywords) |
| 12 | Shared-Domain (Color-Utils) | `shared/domain/appointments.ts:148–180` (6 Symbole) | S | ~50 |
| 13 | Shared-API (kleine Typen) | `time-tracking.ts:60` `AppointmentServiceBreakdown` | XS | ~5 |
| 14 | Shared-Utils | `datetime.ts:29` `ParsedTime`, `phone.ts:9,15` | 3 × XS | ~10 |
| **Σ** | | **42 Funde** | **~3-4 h** | **~480 LOC** |

### 7.2 Diskussionspunkte — `wahrscheinlich löschbar` und `bitte prüfen`

> Diese **34 Funde** brauchen vor jeder Aktion eine kurze Klärung mit einem Verantwortlichen. Reihenfolge: zuerst Sprint-Kollisionen abwarten, dann Cron/Webhook-Pfade prüfen, dann externe API-Verträge.

| # | Bereich | Symbol | Kategorie | Aufwand | Klärungsbedarf |
|---|---------|--------|-----------|:-------:|----------------|
| 1 | Frontend (Hooks) | `time-tracking/use-month-closing.ts:59,71` (2 Hooks) | `wahrscheinlich löschbar` | S | Sprint #108 abwarten |
| 2 | Frontend (Hooks) | `time-tracking/use-time-entries.ts:20` `timeEntryKeys` | `bitte prüfen` | ? | React-Query-Cache-Invalidierungen prüfen |
| 3 | Frontend (Auth) | `use-auth.tsx:14,32,187` (3 Symbole) | `bitte prüfen` | S | Test-Imports prüfen |
| 4 | Frontend (Statistik) | `pages/admin/statistics/helpers.ts:55-279` (11 Typen) | `bitte prüfen` | M | Sind Vorbereitung für noch nicht gebaute Charts? |
| 5 | Backend-Service | `whatsapp-service.ts:37` `WhatsAppService` Klasse | `wahrscheinlich löschbar` | M | Webhook-Pfad prüfen |
| 6 | Backend-Service | `whatsapp-reminder-scheduler.ts:9` `sendDailyAppointmentReminders` | `bitte prüfen` | ? | Replit-Scheduler-Konfig prüfen |
| 7 | Backend-Service | `call-scheduler.ts:53` `calculateNextCallTime` | `wahrscheinlich löschbar` | S | Niemand nutzt ihn — kann weg, sobald Verantwortlicher zustimmt |
| 8 | Backend-Service | `template-engine.ts:200` `buildPlaceholdersFromFormData` | `wahrscheinlich löschbar` | S | Doppelter Pfad? |
| 9 | Backend-Service | `document-pdf.ts:243,247` `generateSigningToken`, `hashToken` | `bitte prüfen` | ? | Public-Signing-Flow gegen-checken |
| 10 | Backend-Service | `travel-time.ts:21,35,51` (3 Helper) | `wahrscheinlich löschbar` | M | OSRM-Routing geplant? |
| 11 | Backend-Lib | `zugferd.ts:369` `generateZugferdXml` | `bitte prüfen` | ? | Billing-Verantwortlichen fragen |
| 12 | Backend-Storage | `storage.ts:200` `DatabaseStorage` | `bitte prüfen` | ? | ⚠️ Sprint #108 |
| 13 | Backend-Storage | `service-catalog.ts:65,77` (Interface + Klasse) | `bitte prüfen` | ? | ⚠️ Sprint #108 |
| 14 | Backend-Storage | `documents.ts:74,82,88,116` (4 Symbole) | `bitte prüfen` | ? | ⚠️ Sprint #108 |
| 15 | Backend-Storage | `customer-management.ts:46,58,64,66,89` (5 Symbole) | `bitte prüfen` | ? | ⚠️ Sprint #108 |
| 16 | Backend-Storage | `whatsapp.ts:22` `upsertWhatsAppNotificationRule` | `wahrscheinlich löschbar` | S | Notification-Regelwerk-Refactor prüfen |
| 17 | Backend-Storage | `budget-ledger.ts` (7 Symbole) | `bitte prüfen` | ? | ⚠️ Sprint #108 |
| 18 | Lib (Errors) | `lib/errors.ts:11` `ErrorCodes` | `bitte prüfen` | S | Test-Imports prüfen, lieber unexportieren |
| 19 | Shared-Domain | `customers.ts:48,85` (2 Konstanten) | `bitte prüfen` | S | Forms-Verwendung prüfen |
| 20 | Shared-Domain | `time-entries.ts:3,56,84,85` (4 Symbole) | `bitte prüfen` | S | UI-Verwendung prüfen |
| 21 | Shared-API | `customers.ts:38–122` (6 Typen) | `wahrscheinlich löschbar` | M | Frontend-Nutzung doppelt prüfen |
| 22 | Shared-API | `billing.ts:23` `InvoiceLineItem` | `bitte prüfen` | S | Name-Kollision mit Drizzle-Typ |
| 23 | Shared-API | `index.ts` (Sammel-Re-Export) | `bitte prüfen` | M | Konsumenten-Check vor Löschen |
| **Σ** | | **34 Funde** | gemischt | **~6-10 h zzgl. Klärungszeit** | – |

### 7.3 Was **nicht** in diesem Bericht steht

- **Keine Schema-Spalten-Vorschläge** — eigene Untersuchung mit Produktionsdaten-Check (Task #219).
- **Kein Dependency-Audit** — knip-Konfig hat 8 Dependencies bewusst ignoriert (Task #220).
- **Keine Bewertung von Tests-only-Code** — Tests gelten als Konsumenten.
- **Keine Performance- oder Architektur-Bewertung** — Out of Scope.
- **Keine Aufräumung der PDF-Testartefakte im Projekt-Root** — Out of Scope laut Aufgabe.

### 7.4 Empfohlene Folge-Aufgaben (bereits eingereicht)

1. **Task #218 — „Toten Code aus Quick-Win-Liste entfernen (nach Sprint #107/#108/#109)"** — die 42 sicheren Funde aus 7.1 löschen, eine PR pro Bereich.
2. **Task #219 — „Schema-Audit: ungenutzte Datenbankspalten finden"** — separate Untersuchung mit Produktionsdaten-Check (siehe Abschnitt 5.2).
3. **Task #220 — „Dependency-Audit: ungenutzte npm-Pakete identifizieren"** — Bericht über `package.json`-Dependencies (siehe Coverage/Blind Spots).
