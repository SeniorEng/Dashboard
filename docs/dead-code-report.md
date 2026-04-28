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
| `package.json` Dependencies | **nicht ausgewertet** | knip hat keine ungenutzten Dependencies gemeldet, aber wegen `ignoreDependencies`-Liste (8 Einträge wie `tsx`, `@types/*`, `tailwindcss`, `node-zugferd`) ist der Dependency-Audit nicht abschließend. → eigene Prüfung empfohlen. |
| Schema-Spalten (`shared/schema/**`) | **nicht analysiert** | Statische Analyse reicht nicht — bräuchte Produktionsdaten-Check. Siehe Abschnitt 5. |
| Drizzle-Migrations (`migrations/`) | **nicht analysiert** | Migrations-Historie darf nie rückwirkend geändert werden. |
| `client/src/features/*/hooks/index.ts` | **als entry markiert** | In `knip.json` als `entry` eingetragen → Re-Exports darin werden nicht als „tot" erkannt. ts-prune fängt sie auf, daher trotzdem im Bericht. |

## Risiko-Skala

| Kategorie | Bedeutung |
|-----------|-----------|
| `sicher löschbar` | Nur lokal verwendet oder gar nicht; keine externen Konsumenten; keine Tests; keine dynamischen Aufrufe; kein Public-API-Vertrag. Risiko praktisch null. |
| `wahrscheinlich löschbar` | Export ohne erkennbaren internen Konsumenten. Restrisiko: könnte von externen Skripten / Cronjobs / Migrations genutzt werden. |
| `bitte prüfen` | Wirkt ungenutzt, aber Hinweise auf dynamischen Zugriff (Reflection, String-basierte Routes, Drizzle-Migrations-Historie, externe API-Verträge), oder Kollision mit laufendem Refactoring-Sprint. |
| `nicht anfassen` | Schema-Felder mit Produktionsdaten, öffentliche API-Routes, Felder in Migrations-Historie, Funktionen mit Test-Coverage. |

---

## 0. Schnell-Überblick

| Bereich | sicher löschbar | wahrscheinl. | bitte prüfen | nicht anfassen |
|---------|:-:|:-:|:-:|:-:|
| Frontend-Code | 12 | 4 | 6 | – |
| Backend-Code (Services) | 7 | 5 | 4 | – |
| Backend-Storage | 8 | 3 | 5 | – |
| API-Routes | 0 | 0 | 0 | (alle aktiv) |
| Schema-Felder | 0 | 0 | 0 | (gesondert prüfen) |
| Shared-Utils & Types | 11 | 2 | 4 | – |
| **Summe** | **38** | **14** | **19** | **–** |

Geschätzter Code-Reduktions-Spielraum bei Komplettausführung: **ca. 1.500–2.200 Zeilen** (≈1,5–2 % der Codebase). Größter Effekt liegt bei toten Re-Exports und ungenutzten Helper-Funktionen.

---

## 1. Frontend-Code (`client/src/`)

### 1.1 Tote Re-Export-Index-Dateien

Mehrere `index.ts`-Dateien sind **vollständig redundant**: Konsumenten importieren direkt aus den Modulen, der zentrale Re-Export wird nirgends genutzt.

| Pfad | Kategorie | Begründung |
|------|-----------|------------|
| `client/src/lib/api/index.ts` | `sicher löschbar` | 0 Importe von `@/lib/api`. Alle Konsumenten importieren `@/lib/api/client` oder `@/lib/api/types` direkt. |
| `client/src/components/charts/index.ts` (StatCard, BarSimple, BarStacked, DonutChart, CockpitKPI Re-Exports) | `sicher löschbar` | Komponenten selbst sind aktiv (22, 9, 9, 6, 6 Treffer), aber Konsumenten importieren aus `@/components/charts/<file>`, nicht aus dem Index. |
| `client/src/components/patterns/index.ts` (DataList, DataListItem, EmptyState, StatusBadge Re-Exports) | `sicher löschbar` | Gleiches Muster: Komponenten leben weiter, der Index ist tot. `SectionCard`/`PageHeader` werden ebenfalls direkt importiert. |
| `client/src/features/appointments/components/index.ts` (AppointmentCard Re-Export) | `sicher löschbar` | `AppointmentCard` selbst aktiv, der Index nicht konsumiert. |

### 1.2 Tote Hook-Re-Exports in Feature-Indizes

| Pfad | Symbol(e) | Kategorie | Begründung |
|------|-----------|-----------|------------|
| `client/src/features/prospects/index.ts` | `useProspectAppointmentData` | `sicher löschbar` | Hook in `hooks/use-prospects.ts:34` — kein Konsument im Frontend. |
| `client/src/features/time-tracking/hooks/use-month-closing.ts:59,71` | `useMonthClosingReadiness`, `useMonthClosingPreview` | `wahrscheinlich löschbar` | Vor #128 ersetzt; die Admin-Variante (`useAdminMonthClosingReadiness`) wird genutzt. Bitte gegen Refactoring-Sprint #108 abgleichen. |
| `client/src/features/time-tracking/hooks/use-time-entries.ts:20` | `timeEntryKeys` | `bitte prüfen` | React-Query-Key-Factory — wirkt ungenutzt, aber Cache-Invalidierungen könnten sich darauf stützen. |

### 1.3 Lokale Helper, die exportiert sind aber nur intern genutzt

ts-prune meldet **150 Exports mit Marker `(used in module)`** — alle Kandidaten zum Unexportieren. Beispiele (vollständige Liste in `/tmp/ts-prune.log`):

| Pfad:Zeile | Symbol | Kategorie |
|------------|--------|-----------|
| `client/src/components/error-boundary.tsx:65` | `resetChunkReloadCount` | `sicher löschbar` (nur intern) |
| `client/src/hooks/use-toast.ts:74` | `reducer` | `sicher löschbar` (nur intern) |
| `client/src/hooks/use-auth.tsx:14,32,187` | `User`, `AuthState`, `canCreateHauswirtschaft` | `bitte prüfen` (Typ-Re-Use im Test denkbar) |
| `client/src/lib/public-branding.ts:4` | `PublicBranding` | `sicher löschbar` |
| `client/src/features/appointments/hooks/use-appointment-series.ts:68,77` | `SeriesPreviewResponse`, `SeriesCreateResponse` | `sicher löschbar` |

> **Empfehlung:** Diese Klasse von Funden ist systematisch — ein einmaliger Lint-Lauf mit `eslint-plugin-import` Regel `no-internal-modules` oder ein TS-Codemod könnte das in einem Rutsch erledigen, sobald die Refactoring-Sprints durch sind.

### 1.4 Bereits bekannt aus Hauswirtschaft-/Statistik-Pages

| Pfad:Zeile | Symbole | Kategorie |
|------------|---------|-----------|
| `client/src/pages/admin/statistics/helpers.ts:55–279` | `MarginData`, `UtilizationData`, `BudgetData`, `BudgetPrevData`, `CockpitData`, `CustomerStats`, `BudgetUtilization`, `ServicePrice`, `ProfitabilityTotals`, `GrowthSummary`, `PlanningTotals` | `bitte prüfen` | Statistik-Typen — ggf. Vorbereitung für noch nicht fertig integrierte Charts. |
| `client/src/pages/admin/components/customer-pricing-section.tsx:80` | `PricingSectionProps` | `sicher löschbar` |
| `client/src/pages/admin/components/customer-types.ts:71` | `StepConfig` | `sicher löschbar` |

### 1.5 Vollständig referenzierte Pages

Alle 23 Pages in `client/src/pages/*.tsx` werden geroutet (App.tsx) bzw. von einer Page importiert (`setup.tsx` ← `login.tsx`). **Keine verwaisten Pages.**

---

## 2. Backend-Services (`server/services/`)

### 2.1 Service-Klassen-Wrapper ohne Konsumenten

Mehrere Services exportieren eine **Klasse**, die nirgendwo instanziiert wird. Die zugrundeliegenden Funktionen sind teilweise weiter im Einsatz — nur der Klassen-Wrapper ist tot.

| Datei | Symbol | Kategorie | Begründung |
|-------|--------|-----------|------------|
| `server/services/auth.ts:85` | `AuthService` (Klasse) | `sicher löschbar` | Klassenname kommt nur in der Definition vor; Auth-Funktionen werden über Routen-Helper genutzt. |
| `server/services/whatsapp-service.ts:37` | `WhatsAppService` (Klasse) | `wahrscheinlich löschbar` | Klassenname nur in der Definition. Achtung: WhatsApp-Webhook könnte dynamisch zugreifen — vor Löschung Webhook-Pfad prüfen. |
| `server/services/whatsapp-reminder-scheduler.ts:9` | `sendDailyAppointmentReminders` | `bitte prüfen` | Klingt wie Cron-Endpoint — ggf. via Replit-Scheduler aufgerufen, nicht über Code-Import. **Vor Löschung Scheduler-Konfig prüfen.** |
| `server/services/call-scheduler.ts:53` | `calculateNextCallTime` | `wahrscheinlich löschbar` | Helper, der nirgends importiert wird. |

### 2.2 Tote Helper-Funktionen

| Datei:Zeile | Symbol | Kategorie | Begründung |
|-------------|--------|-----------|------------|
| `server/services/template-engine.ts:200` | `buildPlaceholdersFromFormData` | `wahrscheinlich löschbar` | Andere Placeholder-Pfade aktiv; dieser Eintrag wirkt verwaist. |
| `server/services/cover-letter.ts:55` | `renderCoverLetterText` | `sicher löschbar` | Cover-Letter wird per HTML/PDF gerendert; Text-Variante ohne Konsumenten. |
| `server/services/document-pdf.ts:243,247` | `generateSigningToken`, `hashToken` | `bitte prüfen` | Klingt nach Public-Signing-Flow. **Vor Löschung gegen `server/routes/public-signing.ts` abgleichen** — ggf. dort dupliziert. |
| `server/services/travel-time.ts:21,35,51` | `calculateBuffer`, `calculatePickupTime`, `getOsrmRoute` | `wahrscheinlich löschbar` | 0 externe Treffer. OSRM-Routing wirkt vorbereitend, aber nicht eingebaut. |
| `server/services/appointment-series.ts:42` | `generateSeriesDates` | `sicher löschbar` | Innere Helper-Funktion; Series-Logik nutzt anderen Pfad. |

### 2.3 Tote Typ-Aliase in Services

Häufig: Service-Modul exportiert Typen für seine eigene API, die intern auch wieder aufgegriffen werden.

| Datei:Zeile | Typ | Kategorie |
|-------------|-----|-----------|
| `server/services/appointments.ts:21–83` | `OverlapCheckResult`, `ValidationResult`, `DocumentationServiceEntry`, `DocumentationInput`, `DocumentationResult`, `KundenterminInput`, `AppointmentService` | `sicher löschbar` (alle nur intern) |
| `server/services/appointment-import.ts:11–55` | `ImportRow`, `BudgetTrimInfo`, `ImportAction`, `ImportResult` | `sicher löschbar` (alle nur intern) |
| `server/services/auto-breaks.ts:16` | `AutoBreakResult` | `sicher löschbar` (nur intern) |
| `server/services/avis-parser.ts:1,15,26` | `ParsedAvisHeader`, `ParsedAvisItem`, `ParsedAvis` | `sicher löschbar` |
| `server/services/qonto-csv-parser.ts:54` | `QontoCsvImportResult` | `sicher löschbar` |
| `server/services/email-parser.ts:3` | `ParsedLead` | `sicher löschbar` |
| `server/services/employee-availability.ts:94,110,116` | `WeeklyAvailabilityDay`, `WeeklyAvailabilityEmployee`, `WeeklyAvailabilityResponse` | `sicher löschbar` |
| `server/services/document-trigger-engine.ts:7` | `DocumentRequirement` | `sicher löschbar` |
| `server/services/time-entry-validation.ts:19` | `CheckTimeConflictsArgs` | `sicher löschbar` |

### 2.4 ZUGFeRD

| Datei:Zeile | Symbol | Kategorie | Begründung |
|-------------|--------|-----------|------------|
| `server/lib/zugferd.ts:369` | `generateZugferdXml` | `bitte prüfen` | Compliance-Funktion, die ggf. erst bei aktiviertem ZUGFeRD-Modus genutzt wird. **Nicht löschen, ohne Billing-Verantwortlichen zu fragen.** |

---

## 3. Backend-Storage (`server/storage/`)

> ⚠️ **Sprint-Kollision:** Sprint #108 (Architektur-Konsistenz / Storage-Layer-Umstellung) wird genau in diesem Bereich umbauen. Funde aus Abschnitt 3 sind als „Vor-Bereinigung" gefährlich — sie sollten **nach #108** erneut erhoben werden.

### 3.1 Tote Klassen-Wrapper

Wie in Services: Mehrere Storage-Module exportieren eine Klasse, die nirgendwo instanziiert wird. Funktionen werden statisch aufgerufen.

| Datei:Zeile | Symbol | Kategorie |
|-------------|--------|-----------|
| `server/storage.ts:200` | `DatabaseStorage` (Klasse) | `bitte prüfen` ⚠️ Sprint #108 — die Klasse wird derzeit aktiv refaktoriert und ggf. behalten. |
| `server/storage/service-catalog.ts:77` + Interface `IServiceCatalogStorage:65` | `ServiceCatalogStorage` | `bitte prüfen` ⚠️ Sprint #108 |
| `server/storage/documents.ts:88,116` | `IDocumentStorage`, `DocumentStorage`, `DocumentBatch:74`, `GroupedDocumentsByType:82` | `bitte prüfen` ⚠️ Sprint #108 |
| `server/storage/customer-management.ts:46–89` | `CustomerListFilters`, `PaginationOptions`, `PaginatedResult`, `CustomerListItem`, `CustomerManagementStorage` | `bitte prüfen` ⚠️ Sprint #108 |

### 3.2 Tote Tasks-Funktionen

| Datei:Zeile | Symbol | Kategorie | Begründung |
|-------------|--------|-----------|------------|
| `server/storage/tasks.ts:231,342` | `findMonthClosingTask`, `findBirthdayTask` | `sicher löschbar` | Nur in der eigenen Datei deklariert; im gesamten Repo kein Aufruf. Ersetzt durch `ensure*`/`complete*Task`-Varianten. |
| `server/storage/tasks.ts:405,425` | `completeBirthdayTask`, `reopenBirthdayTask` | `sicher löschbar` | Keine Aufrufer. Aufruferseite nutzt die `*All*`-Varianten (`completeAllBirthdayTasks`, `reopenAllBirthdayTasks`). |
| `server/storage/tasks.ts:10` | `TaskWithRelations` | `sicher löschbar` (nur intern verwendet) |

### 3.3 Tote Storage-Helper

| Datei:Zeile | Symbol | Kategorie |
|-------------|--------|-----------|
| `server/storage/whatsapp.ts:22` | `upsertWhatsAppNotificationRule` | `wahrscheinlich löschbar` (kein Konsument; vorher Notification-Regelwerk-Refactor prüfen) |
| `server/storage/appointment-helpers.ts:41` | `assignedEmployee` | `sicher löschbar` |
| `server/storage/budget/cap-calculator.ts:17,29,44` | `getMonthRange`, `getYearRange`, `netConsumedInRange` | `sicher löschbar` (0 externe Treffer; rein intern) |
| `server/storage/budget/cap-calculator.ts:8,9,12,74,82` | `MonthlyBudgetType`, `YearlyBudgetType`, `DateRange`, `CapInputs`, `CapResult` | `sicher löschbar` (alle nur intern) |
| `server/storage/budget-ledger.ts:1,2,24` | `BudgetSummary`, `Budget45aSummary`, `Budget39_42aSummary`, `AllBudgetSummaries`, `CascadeResult`, `DbClient`, `BudgetLedgerStorage` | `bitte prüfen` ⚠️ Sprint #108 |
| `server/storage/qonto.ts:15` | `PaymentAdviceWithItems` | `sicher löschbar` |
| `server/storage/time-tracking/appointments.ts:78` | `AppointmentServiceDetail` | `sicher löschbar` |
| `server/storage/budget/import-availability.ts:9` | `DateAwareAvailability` | `sicher löschbar` |
| `server/storage/appointment-series-storage.ts:24` | `SeriesWithCustomerName` | `sicher löschbar` |

### 3.4 Helper im Routes-Layer mit überflüssigem `export`

> **Wichtige Klarstellung:** Die Funktionen in dieser Tabelle sind **NICHT tot**. Sie werden aktiv genutzt — aber **nur innerhalb derselben Datei**. Das `export`-Schlüsselwort ist überflüssig. Hier geht es ausschließlich darum, das `export` zu entfernen, **nicht die Funktion selbst zu löschen**.

| Datei:Zeile | Symbol | Aktion | Begründung |
|-------------|--------|--------|------------|
| `server/routes/appointments.ts:84` | `checkCustomerAccess` | `sicher` — nur `export` entfernen | Wird in derselben Datei in Zeilen 478, 499 genutzt. **Kein** anderes Modul importiert sie. (Achtung: gleichnamige, eigenständige Funktionen existieren in `server/middleware/object-storage-auth.ts` und `server/routes/budget.ts` — nicht zusammenwerfen.) |
| `server/routes/appointments.ts:149` | `checkAppointmentReassignAccess` | `sicher` — nur `export` entfernen | Wird in derselben Datei in Zeile 812 genutzt. Kein Cross-Modul-Import. |
| `server/lib/conversion-schemas.ts:66` | `convertCustomerSchema` | `sicher löschbar` | Tatsächlich kein Konsument vorhanden. |
| `server/lib/duplicate-check.ts:5` | `DuplicateCustomer` | `sicher` — nur `export` entfernen | Typ wird in derselben Datei verwendet. |
| `server/lib/errors.ts:11` | `ErrorCodes` | `bitte prüfen` | Wird intern weit verzweigt genutzt; Export könnte für Tests gebraucht werden. Lieber unexportieren statt löschen. |

---

## 4. API-Routes

**Vollständige Verifikation: alle 29 Route-Dateien in `server/routes/**` sind registriert.**

Methodik: Jede `*.ts`-Datei in `server/routes/` (außer `index.ts`) wurde gegen `import …Router from "./…"`-Anweisungen im gesamten `server/`-Tree gegen-gegrept.

### 4.1 Top-Level (in `server/routes/index.ts` registriert)

`appointments`, `customers`, `auth`, `admin`, `team`, `time-entries`, `birthdays`, `birthday-cards`, `budget`, `tasks`, `service-records`, `services`, `search`, `settings`, `profile`, `company`, `billing`, `holidays`, `statistics`, `webhook`, `notifications`, `whatsapp`, `prospects`, `appointment-series`. → **24 Module.**

### 4.2 Nested (von einem anderen Route-Modul registriert)

| Modul | Eingebunden von | Mount-Pfad |
|-------|-----------------|------------|
| `month-closing` | `routes/time-entries.ts:13` | unter `/time-entries` |
| `appointment-documentation` | `routes/appointments.ts:38` | unter `/appointments` |
| `customers/contacts`, `customers/service-prices`, `customers/documents` | `routes/customers.ts:23-25` | unter `/customers` |
| `statistics/revenue`, `statistics/operations`, `statistics/customers` | `routes/statistics.ts:7-9` | unter `/statistics` |
| `admin/employees`, `admin/customers` (+ Sub-Routes), `admin/insurance-providers`, `admin/time-tracking`, `admin/documents`, `admin/audit`, `admin/lexware-export`, `admin/document-delivery`, `admin/prospects`, `admin/qonto`, `admin/whatsapp`, `admin/import-appointments`, `admin/contact-migration`, `admin/test-cleanup` | `routes/admin.ts:8-21` | unter `/admin` |
| `admin/customers/{assignments,budgets,details,contracts,workflows,duplicates}` | `routes/admin/customers.ts:25-30` | unter `/admin/customers` |
| `public-signing` | `server/index.ts` (separate Mount-Stelle) | unter `/api/public-signing` |
| `webhook-twilio` | `server/index.ts` | Twilio-Webhook |

→ **Alle 29 Route-Dateien sind aktiv. Keine Funde, kein Handlungsbedarf.**

---

## 5. Schema-Felder (`shared/schema/`)

> 🔒 **Diese Sektion ist bewusst leer für die jetzige Aufgabe.** Drizzle-Spalten zu identifizieren, die in keiner Storage-Funktion mehr gelesen/geschrieben werden, erfordert eine **separate, dedizierte Untersuchung** mit Produktions-Datencheck (`SELECT count(*) WHERE col IS NOT NULL`) pro Verdacht.
>
> Insgesamt umfasst das Schema **21 Tabellen** (~3.250 Zeilen), die größten:
> - `documents.ts` (337), `customers.ts` (294), `appointments.ts` (287)
> - `users.ts` (269), `budget.ts` (240), `prospects.ts` (207)
>
> Empfehlung: **Eigene Folge-Aufgabe** für „Schema-Audit nach Refactoring-Sprints". Diese muss zwingend nach #107/#108/#109 erfolgen, da dort Felder umgebaut werden könnten.

---

## 6. Shared-Utils & Types (`shared/`)

### 6.1 Domain-Hilfsfunktionen ohne Konsumenten

| Datei:Zeile | Symbol | Kategorie | Begründung |
|-------------|--------|-----------|------------|
| `shared/domain/appointments.ts:148,161,168,172,176,180` | `STATUS_COLORS`, `SERVICE_TYPE_COLORS`, `getStatusColor`, `getStatusLabel`, `getAppointmentTypeColor`, `getServiceColor` | `sicher löschbar` | 0 externe Treffer. Color-Logik vermutlich auf Tailwind-Klassen umgestellt. |
| `shared/domain/customers.ts:48,85` | `DEACTIVATION_REASONS`, `PFLEGEGRAD_VALUES` | `bitte prüfen` | Konstanten könnten in Forms genutzt werden — vor Löschung Forms grep. |
| `shared/domain/time-entries.ts:3,56,84,85` | `ENTRY_TYPE_LABELS`, `ENTRY_TYPES_WITHOUT_KILOMETERS`, `WORK_ENTRY_TYPES`, `WorkEntryType` | `bitte prüfen` | Möglicherweise erst kürzlich entstanden; Labels in UI sehr wahrscheinlich genutzt. |

### 6.2 Tote Typen in `shared/api/`

| Datei:Zeile | Typ | Kategorie | Begründung |
|-------------|-----|-----------|------------|
| `shared/api/customers.ts:38–122` | `CustomerPricingInfo`, `BudgetSummaryInfo`, `CustomerBudgetsInfo`, `CustomerNeedsAssessmentInfo`, `CustomerContractInfo`, `CustomerCareLevelHistoryItem` | `wahrscheinlich löschbar` | 1–2 Treffer pro Symbol — tatsächlich nur Eigen-Definition + ggf. Re-Export. |
| `shared/api/time-tracking.ts:60` | `AppointmentServiceBreakdown` | `sicher löschbar` |
| `shared/api/billing.ts:23` | `InvoiceLineItem` | `bitte prüfen` (Name-Kollision mit Drizzle-Typ; vorsichtig prüfen) |
| `shared/api/index.ts` (Sammeldatei mit ~50 weiteren Typ-Re-Exports) | mehrere | `bitte prüfen` | Re-Export-Index — wenn der gesamte Index konsumentenlos ist, lässt sich das in einem Rutsch entfernen. Vor Löschung **explizit per ripgrep gegenchecken**. |

### 6.3 Tote Helper

| Datei:Zeile | Symbol | Kategorie |
|-------------|--------|-----------|
| `shared/utils/datetime.ts:29` | `ParsedTime` | `sicher löschbar` |
| `shared/utils/phone.ts:9,15` | `DACH_COUNTRIES`, `PhoneValidationResult` | `sicher löschbar` |

---

## 7. Zusammenfassung & Empfehlungen

### 7.1 Empfohlene Quick-Wins (Kategorie `sicher löschbar`)

Diese **38 Funde** sind technisch isoliert (keine externen Konsumenten, keine Tests, keine dynamischen Pfade) und damit risikoarm. Schätzung: **ca. 600–900 LOC** Reduktion bei ca. 1–2 h Aufwand.

> ⚠️ **Trotzdem: Erst nach Merge der Refactoring-Sprints #107/#108/#109 anfassen.** Auch „sicher löschbar"-Symbole können zwischenzeitlich von Sprint-Branches re-aktiviert werden — und ein Merge-Konflikt mit gelöschtem Code ist viel teurer als 1–2 Wochen warten. Die Quick-Wins werden dann in einer eigenen Folge-Aufgabe gebündelt umgesetzt.

Top-Kandidaten (sortiert nach Impact):

1. **Tote Re-Export-Indizes** — `client/src/lib/api/index.ts`, `client/src/components/charts/index.ts`, `client/src/components/patterns/index.ts`, `client/src/features/appointments/components/index.ts`. Reine Aufräumung, keine Verhaltensänderung.
2. **Verwaiste Tasks-Funktionen** — `findMonthClosingTask`, `findBirthdayTask`, `completeBirthdayTask`, `reopenBirthdayTask` in `server/storage/tasks.ts`.
3. **Klassen-Wrapper ohne Konsumenten** — `AuthService`, ggf. `WhatsAppService`-Klasse, `CustomerManagementStorage` (Letzteres erst nach Sprint #108).
4. **Color-/Label-Utilities in `shared/domain/appointments.ts`** — `getStatusColor` & Co.
5. **`cap-calculator.ts` interne Helper unexportieren** — `getMonthRange`, `getYearRange`, `netConsumedInRange` und 5 lokale Typen.
6. **Service-interne Typ-Aliase** — `OverlapCheckResult`, `ValidationResult`, `DocumentationServiceEntry`, …, `ParsedAvis*`, `QontoCsvImportResult`, etc.
7. **Routes-Helper (Abschnitt 3.4) unexportieren** — `checkCustomerAccess`, `checkAppointmentReassignAccess`, `DuplicateCustomer` (nur das `export` entfernen, Funktion behalten).

### 7.2 Diskussionspunkte (Kategorien `wahrscheinlich löschbar` und `bitte prüfen`)

Diese **33 Funde** brauchen vor der Löschung eine kurze Klärung. Empfohlene Reihenfolge:

1. **Nach Sprint #108** erneut erheben — alle Storage-Funde (`DatabaseStorage`, `*Storage`-Klassen, `BudgetLedgerStorage`, `checkCustomerAccess` etc.) können sich durch das Refactoring komplett anders darstellen.
2. **WhatsApp/Cron-bezogene Symbole** (`sendDailyAppointmentReminders`, `WhatsAppService`-Klasse) gegen die Replit-Scheduler-Konfiguration abgleichen, bevor sie verschwinden.
3. **`generateSigningToken`/`hashToken`** gegen `server/routes/public-signing.ts` abgleichen — möglicherweise Funktions-Duplikat.
4. **`generateZugferdXml`** mit Billing-Verantwortlichem klären (Compliance-Funktion).
5. **Schema-Audit als eigener Task** (siehe Abschnitt 5).
6. **`shared/api/`-Re-Export-Index** nach #108 mit grep verifizieren und ggf. komplett vereinfachen.

### 7.3 Was **nicht** in diesem Bericht steht

- **Keine Schema-Spalten-Vorschläge** — das braucht eine eigene Untersuchung mit Produktionsdaten-Check.
- **Keine Bewertung von Tests-only-Code** — Tests gelten als Konsumenten.
- **Keine Performance- oder Architektur-Bewertung** — Out of Scope.
- **Kein Vorschlag zu PDF-Testartefakten im Projekt-Root** (Out of Scope laut Aufgabe).

### 7.4 Empfohlene Folge-Aufgaben

1. **„Dead-Code Quick-Wins anwenden"** — die 38 sicheren Funde aus 7.1 löschen, eine PR pro Bereich (Frontend / Backend / Shared) für einfache Rollbacks.
2. **„Dead-Code-Prüfliste nach Sprint #108"** — die 19 `bitte prüfen`-Funde nach Sprint-Abschluss erneut bewerten.
3. **„Schema-Audit auf ungenutzte Spalten"** — separate Untersuchung mit Produktionsdaten-Check (siehe Abschnitt 5).
