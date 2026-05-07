# Technisches Refactoring-Audit — 2026-05-07

> **Scope:** Reiner Findings-Bericht zur technischen Code-Qualität, Konsistenz und Aufräumarbeiten. **Keine Code-Änderungen** — nur Analyse und Empfehlungen für Folge-Tasks.
> **Out of scope:** Security, Performance, UI/UX, Business-Logik-Korrektheit (separate Skills/Audits).

---

## Executive Summary

Die Codebasis ist im Kern gesund — TypeScript läuft sauber durch (`npm run check` ohne Fehler), `any`/`@ts-ignore`-Belastung ist minimal (~17 Fundstellen, **0** ts-ignore), und Konventionen wie zentrale `SignaturePad`, `invalidateRelated`, German Zod werden flächendeckend befolgt. Die Refactoring-Themen sind primär **strukturell und kosmetisch**, nicht funktional.

### Top-Findings nach Priorität

| # | Priorität | Finding | Ort | Aufwand |
|---|---|---|---|---|
| 1 | **P1** | 22 Routes führen direkten Drizzle-DB-Zugriff aus statt `server/storage/` zu nutzen (138 `db.*`-Aufrufe gesamt; davon 36 allein in `billing.ts`) | `server/routes/` | L |
| 2 | **P1** | 3 Routes-Dateien überschreiten 700 LOC und mischen mehrere Domänen (`billing.ts` 2068, `appointments.ts` 1337, `budget.ts` 915) | `server/routes/` | L |
| 3 | **P1** | 19 Page-Komponenten >500 LOC, davon 6 >900 LOC (`edit-appointment.tsx` 1332, `users.tsx` 1119, `new-appointment.tsx` 1067) | `client/src/pages/` | L |
| 4 | **P2** | Inkonsistente Storage-Struktur: 18 flache vs. 29 modular geschachtelte Dateien — kein einheitliches Layout-Vorbild | `server/storage/` | M |
| 5 | **P2** | 35 ungenutzte Exports/Typen laut knip — größter Cluster: `client/src/components/charts/*` (komplettes Chart-Submodul ohne Konsumenten) | mehrere | S–M |
| 6 | **P2** | Direkte `queryClient.invalidateQueries`-Aufrufe in 56 Dateien parallel zu `invalidateRelated()` — Risiko von Drift bei Cross-Domain-Invalidierung | `client/src/` | M |
| 7 | **P3** | `client/src/features/`-Migration ist nur in 4 Domänen umgesetzt (appointments/customers/prospects/time-tracking); restlicher Frontend-Code lebt in `pages/` | `client/src/` | L |
| 8 | **P3** | Test-Helper teilweise dupliziert: `tests/test-utils.ts` (zentral) vs. `tests/helpers/*` (neuer); kein einheitlicher Import-Pfad | `tests/` | S |

---

## 1. Storage-Layer-Konsistenz (P1)

### Befund

22 von 33 Routes-Dateien importieren Drizzle-Operatoren (`eq`, `and`, `sql`, …) direkt und führen DB-Operationen außerhalb des Storage-Layers aus. Insgesamt **138 direkte `db.{select|insert|update|delete|transaction|execute}`-Aufrufe** in `server/routes/`.

**Top-Offender (mit Anzahl direkter DB-Aufrufe):**

| Datei | LOC | DB-Calls | Anmerkung |
|---|---|---|---|
| `server/routes/billing.ts` | 2068 | 36 | Mischt Rechnungslogik + DB + PDF + Mail |
| `server/routes/admin/customers/workflows.ts` | 573 | 12 | Workflow-Mutationen direkt am Schema |
| `server/routes/customers/service-prices.ts` | 590 | 11 | Pricing-Logik wäre Storage-Kandidat |
| `server/routes/admin/employee-availability.ts` | 619 | 11 | Verfügbarkeits-CRUD ohne Storage-Modul |
| `server/routes/admin/test-cleanup.ts` | 454 | 10 | Test-Only — Akzeptabel |
| `server/routes/appointments.ts` | 1337 | 9 | Bereits teils auf Storage migriert, Rest offen |
| `server/routes/admin/lexware-export.ts` | 449 | 8 | Reine Read-Aggregation ohne Storage-Helfer |

### Impact

- **Verstößt gegen das in `replit.md` dokumentierte Architektur-Prinzip** „Centralized Logic" und das Storage-Layer-Pattern (`server/routes/admin/customers/` als Vorbild).
- **Doppelte Wahrheit**: Gleiche Tabelle wird mal über Storage (mit Audit-Hooks, Soft-Delete-Logik), mal direkt in der Route abgefragt — Inkonsistenzen bei Filtern, Tenant-Isolation und Historisierung sind systemisch wahrscheinlich.
- **Testbarkeit**: Routen mit eingebetteten DB-Queries lassen sich nur über echte DB-Roundtrips testen — kein Storage-Mocking möglich.
- Knüpft an offene Tasks #108 (Architektur-Konsistenz, 6 Routes) und #185 (Storage-Cleanup für Termine/Kunden/Rechnungen) an, ist aber **deutlich umfassender** als beide zusammen.

### Vorschlag

Phasenweise Migration in 3 Themenpaketen (siehe Folge-Task-Vorschläge). Reihenfolge: zuerst die kleinen Routen (`birthday-cards`, `tasks`, `public-signing`, `month-closing` — nur 1–2 DB-Calls), dann mittelgroße Domänen (employee-availability, lexware-export, workflows), zuletzt das Mega-Modul `billing.ts` zusammen mit dessen Aufteilung.

---

## 2. Modul-Struktur & Datei-Größe (P1/P2)

### Befund — Server-Routes

| Datei | LOC | Empfehlung |
|---|---|---|
| `server/routes/billing.ts` | **2068** | **Aufteilen** in `billing/index.ts`, `billing/invoices.ts`, `billing/send.ts`, `billing/split.ts`, `billing/storno.ts` (analog zu `admin/customers/`) |
| `server/routes/appointments.ts` | **1337** | Aufteilen nach Verb-Cluster: `appointments/list.ts`, `appointments/mutations.ts`, `appointments/junction.ts` |
| `server/routes/budget.ts` | **915** | Aufteilen: `budget/cost-estimate.ts`, `budget/consumption.ts`, `budget/admin-views.ts` |
| `server/routes/admin/employee-users.ts` | 731 | Aufteilen: `employee-users/crud.ts`, `employee-users/permissions.ts`, `employee-users/hierarchy.ts` |
| `server/routes/admin/customers.ts` | 715 | Bereits z.T. unter `admin/customers/`-Subdir aufgeteilt — Rest dorthin verschieben |
| `server/routes/appointment-series.ts` | 709 | Nach Storage-Verlagerung schrumpft die Route automatisch deutlich |

### Befund — Server-Storage (Layout-Inkonsistenz)

- **18 flache Dateien** in `server/storage/*.ts` (z. B. `customers-storage.ts`, `appointments-storage.ts`, `documents.ts`)
- **29 Dateien in 4 Subdirs** (`budget/`, `customer-mgmt/`, `time-tracking/`, `statistics/`)
- **Kein einheitliches Schema** — gleiche Domäne mal flach, mal modular: `customers-storage.ts` (264 LOC) **und** `customer-mgmt/` (subdir) **und** `customer-management.ts` (654 LOC) koexistieren.

### Befund — Client-Pages

- **19 Pages > 500 LOC**, gesamtes Volumen: 38.843 LOC in 19 Dateien
- 6 Pages > 900 LOC sind klassische Refactor-Kandidaten:
  - `pages/edit-appointment.tsx` (1332) und `pages/new-appointment.tsx` (1067) — Logik ist teils bereits in `features/appointments/hooks/use-new-appointment-form.ts` (893 LOC) ausgelagert; der Page-Layer enthält trotzdem viel Form-/Layout-Code
  - `pages/admin/users.tsx` (1119), `pages/admin/prospects.tsx` (1036), `pages/admin/customer-detail.tsx` (980), `pages/admin/document-types.tsx` (890)

### Vorschlag

- Konvention dokumentieren: ab 500 LOC modularisieren, ab 800 LOC erzwingen (Ausnahme `budget-ledger.ts` per `replit.md`).
- Storage-Layout vereinheitlichen: subdir-pro-Domäne als Standard (Vorbild: `budget/`).
- Pages in `features/<domain>/` migrieren — `features/`-Struktur existiert bereits, ist aber unvollständig.

---

## 3. Dead Code & ungenutzte Exports (P2)

### Knip-Ergebnis (mit aktueller `knip.json`)

- **0 unused files** ✓
- **0 unused dependencies / 0 unlisted dependencies** ✓
- **12 unused exports** (Funktionen/Konstanten)
- **23 unused exported types**

**Nennenswerte Cluster:**

1. **`client/src/components/charts/*` — komplettes Chart-Submodul ohne Konsumenten:**
   - `BarSimple`, `BarStacked`, `CockpitKPI`, `DonutChart`, `Sparkline`, `StatCard` plus `index.ts`-Re-Exports
   - Vermutlich vorbereitet für Cockpit-V2 / Statistics-Refactor und nie aktiviert
2. **Statistics-Typen ohne Konsumenten** in `shared/statistics.ts`: `DrillDownRow`, `RevenueStageBreakdown`, `CustomerFunnel`, `FunnelConversionRates`, `ProjectedGrowthRange`, `ProfitabilityEmployeeRow`, `ServicePriceCalculationRow` — sieben Typen, vermutlich als Vertrag für unfertige Statistik-Features deklariert
3. **`server/lib/team-workload.ts`**: `clearGlobalAvgCache` + 3 Typen ungenutzt; identische Typen werden zusätzlich in `client/src/features/team/use-team-workload.ts` redundant deklariert (siehe §4)
4. **`server/lib/idempotency.ts`**: 4 Result-Typen ungenutzt — Verdacht auf abgebrochene Idempotency-API
5. **Einzelfälle**: `combinePdfBuffers` (`document-delivery.ts`), `LETTERXPRESS_SPEC`, `invoiceGoesToCustomer`, `BROWSER_PUSH_TOGGLE_KEY`, `SOUND_TOGGLE_KEY`

### Impact

- Niedrig (kein Runtime-Schaden), aber mentale Last + irreführende Such-Treffer.
- Insbesondere die `charts/*`-Komponenten suggerieren eine Designsystem-Erweiterung, die nicht existiert.

### Vorschlag

1. `client/src/components/charts/*` und `client/src/components/charts/index.ts` löschen, falls keine konkrete Roadmap existiert.
2. Statistics-Typen in `shared/statistics.ts` revidieren: entweder als Vertrag dokumentieren (warum exportiert?), oder entfernen.
3. `idempotency.ts`-Result-Typen prüfen — falls die API umgebaut wurde, alte Typen entfernen.

---

## 4. Shared-Code-Hygiene (P2)

### Befund

- **Strukturell sauber**: `shared/` enthält genau 4 Subdirs (`api`, `domain`, `schema`, `utils`) und keine Cross-Imports nach `server/` oder `client/`.
- **0 doppelte Zod-Schemas** zwischen `shared/api` und `shared/schema` (verschiedene Verantwortungen: `schema/` = Drizzle-Tabellen + Insert-Schemas, `api/` = HTTP-Response-Typen).
- **Symmetrische Datei-Namen** zwischen `shared/api/` und `shared/schema/` (`appointments`, `billing`, `customers`, `insurance`, `time-tracking`) — gewollte Konvention, aber implizit. Es gibt keine README, die diese Trennung dokumentiert.

### Cross-Layer-Drift-Hotspot

- `client/src/features/team/use-team-workload.ts` deklariert `EmploymentType`, `AssignmentRole`, `CustomerAssignment` lokal — die **identischen** Typen liegen ungenutzt exportiert in `server/lib/team-workload.ts`. Verdacht: Backend-Typen sollten ursprünglich in `shared/` wandern, blieben aber im Server.
- `shared/api/index.ts` re-exportiert nur 8 von 10 Modulen — `customers.ts` aus `shared/api/` wird laut Suche nur von **2** Frontend-Dateien importiert, obwohl 37 Frontend-Dateien aus `shared/schema` lesen. Das deutet darauf hin, dass `shared/api/` als Mini-Kontrakt-Layer noch nicht etabliert ist; Frontends gehen direkt auf Drizzle-Insert-Typen.

### Vorschlag

- Kurze Konventions-README in `shared/README.md`: Wer importiert was wofür?
- `team-workload`-Typen nach `shared/api/team.ts` (oder `shared/domain/team.ts`) extrahieren, beidseitig daraus konsumieren.
- Mittelfristig: Frontend systematisch von `@shared/schema` auf `@shared/api`-Response-Typen umstellen (deckt sich nicht mit P1-Storage-Migration, ist aber thematisch verwandt).

---

## 5. Konventions-Konsistenz im Frontend (P2)

### Pflicht-Komponenten

✓ **`SignaturePad`**: einzige Canvas-Implementierung im Repo (`client/src/components/ui/signature-pad.tsx`); 6 Konsumenten, alle korrekt — keine Eigen-Lösungen.

### `invalidateRelated` vs. direkte Invalidierung

- **20+ Dateien** nutzen `invalidateRelated()` (gut, dokumentiert in `replit.md`).
- **56 Dateien** rufen jedoch `useQueryClient` / `queryClient.invalidateQueries(...)` direkt auf.
- Stichprobe (`pages/admin/qonto.tsx`, `pages/admin/users.tsx`, `pages/profile.tsx`): direkter `invalidateQueries` parallel zu `invalidateRelated` im selben File — gemischter Stil, kein klarer Trigger, wann welche Variante zu verwenden ist.

### Impact

- Risiko von **stillen Cache-Inkonsistenzen**, da `invalidateRelated()` Cross-Domain-Invalidierung kennt, einzelne `invalidateQueries`-Aufrufe aber nur einen Schlüssel kennen.
- `replit.md` schreibt vor: „All mutations must use [invalidateRelated]."

### Frontend-Layout

- `client/src/features/` ist **nur in 4 Domänen** vorhanden: `appointments`, `customers`, `prospects`, `time-tracking` (jeweils `components/` + `hooks/`).
- Alle anderen Domänen (admin, billing, budget, dashboard, documents, statistics, tasks, team, profile, public-signing) leben weiterhin in `client/src/pages/` mit hochkomplexen Page-Komponenten — siehe §2.
- Inkonsistente Co-Location: in `pages/admin/components/*` liegen 4 große Komponenten, in `pages/admin/hooks/*` ein 907-LOC-Hook. Das ist eine dritte Mini-Konvention neben `features/` und `components/`.

### Vorschlag

- Audit aller `useQueryClient`-Konsumenten: was kann auf `invalidateRelated()` migriert werden? (Findings-Liste eines Folge-Tasks.)
- `features/`-Migration als Standard verbindlich erklären; `pages/admin/components/` und `pages/admin/hooks/` als Übergangs-Antipattern markieren und auflösen.

---

## 6. TypeScript- & Build-Hygiene (P3)

### Ergebnisse

- ✅ **`npm run check` läuft fehlerfrei** (`tsc --noEmit`).
- ✅ **0 `@ts-ignore` / `@ts-expect-error` / `@ts-nocheck`** im gesamten Repo.
- ⚠️ **17 `any`-Vorkommen** (sehr niedrig), Top-Files:

| Datei | Treffer | Hinweis |
|---|---|---|
| `server/storage/customer-management.ts` | 6 | Vermutlich Filter/Update-Helper — Inferenz möglich |
| `server/routes/admin/prospects.ts` | 6 | API-Boundary, ggf. `unknown` + Zod sauberer |
| `server/services/document-delivery.ts` | 4 | PDF-Buffer-Handling |
| `server/services/budget-renewal-checker.ts` | 4 | Internes Job-Modul |

### Vorschlag

- Niedrige Priorität: bei nächster Berührung der Module die `any`s durch Typ-Inferenz oder `unknown` + Narrowing ersetzen. Kein eigener Refactoring-Task notwendig.

---

## 7. Test-Code-Hygiene (P2)

### Struktur

- **65 Test-Dateien**, 21.337 LOC gesamt.
- Top-3-Dateien dominieren: `private-billing-e2e.test.ts` (1951), `budget-e2e.test.ts` (1456), `billing/billing-flow.test.ts` (1242).
- Subdirs nur teilweise genutzt: `tests/billing/`, `tests/budget/`, `tests/appointments/`, `tests/security/`, `tests/service-records/`, `tests/helpers/` — viele weitere Tests liegen flach in `tests/` (z. B. `appointments.test.ts` neben `tests/appointments/`).

### Helfer-Duplikation

- `tests/test-utils.ts` (zentral, von ~allen Suiten genutzt — `createTestCustomer`, `createTestEmployee`, …)
- `tests/helpers/` (neuer Subdir, enthält `frozen-clock.ts`, `race.ts`, `budget-scenarios.ts`)
- **Kein einheitlicher Importpfad**, keine README in `tests/helpers/`. Zwei parallele Helper-Konventionen.

### Skips & Veraltetes

- ✅ Keine `it.skip` / `describe.skip` / `.todo()` im Test-Code (sauber).
- `tests/budget_logic_tests.js` (Plain JS in TS-Repo) — Verdacht auf Legacy-Datei.

### Cross-Bezug zu offenen Tasks

- Knüpft an offene Tasks an: #114 (Test-Daten-Isolation), #137 (3 verbleibende Test-Fehler), #138 (Tests parallel ausführen), #186 (private-billing-Tests Custom-Pricing-Bug). Dieser Audit-Task **dupliziert deren Scope nicht** — er liefert nur die Struktur-Beobachtungen.

### Vorschlag

- Konvention festlegen: alle Test-Helper in `tests/helpers/`, `tests/test-utils.ts` dorthin migrieren oder explizit als „Top-Level-Helpers"-README dokumentieren.
- Subdir-Adoption vereinheitlichen: entweder alle Domänen-Tests in Subdirs oder alle flach.
- `tests/budget_logic_tests.js` prüfen und entweder portieren oder löschen.

---

## 8. Konsolidierung & Folge-Task-Vorschläge

Die Findings ergeben **5 thematisch geschnittene Folge-Tasks** (jeweils 1 Sprint umsetzbar). Bestehende offene Tasks werden referenziert, nicht dupliziert.

### Paket A — Storage-Layer-Abschluss (P1) · Bezug: #108, #185

**A1: Kleine Routes auf Storage-Layer migrieren (Quick-Win-Bundle)** · Aufwand S
Routes mit 1–2 direkten DB-Calls auf bestehende oder neue Storage-Helper umstellen: `birthday-cards.ts`, `tasks.ts`, `public-signing.ts`, `month-closing.ts`, `appointment-documentation.ts`, `admin/customers/duplicates.ts`, `admin/customers/contracts.ts`. Leichter Einstieg, schafft Vorbild für nachfolgende Pakete.

**A2: Mittelgroße Admin-Routes auf Storage migrieren** · Aufwand M
`admin/employee-availability.ts` (11), `admin/lexware-export.ts` (8), `admin/customers/workflows.ts` (12), `admin/customers/assignments.ts` (4), `customers/service-prices.ts` (11), `service-records.ts` (7). Pro Route: neues bzw. erweitertes Storage-Modul, Route bleibt thin.

**A3: `billing.ts`-Mega-Refactor** · Aufwand L
`server/routes/billing.ts` (2068 LOC, 36 DB-Calls) parallel zu §2 in `billing/`-Subdir aufteilen UND auf `billing-storage.ts` konsolidieren. Knüpft an bestehende #108-Liste an, behandelt aber den größten Brocken separat.

### Paket B — Datei-Größe & Modul-Struktur (P1)

**B1: Top-Pages in `features/<domain>/` migrieren** · Aufwand L
Die 6 Pages > 900 LOC zerlegen: `edit-appointment`, `new-appointment`, `users`, `profile`, `admin/prospects`, `admin/customer-detail`. Logic in `features/`-Hooks, Layout in kleinere Komponenten. Frontend-`features/`-Konvention vereinheitlichen.

**B2: `server/storage/` Layout vereinheitlichen** · Aufwand M
Flache Storage-Dateien in Subdir-Schema überführen (Vorbild `budget/`). `customers-storage.ts` + `customer-management.ts` + `customer-mgmt/` zu einem Subdir konsolidieren. Naming-Konvention dokumentieren.

### Paket C — Dead Code & Aufräumen (P2)

**C1: Dead Exports + `charts/*`-Cleanup** · Aufwand S
`client/src/components/charts/*` löschen oder als „Reserved for Cockpit-V2" dokumentieren; ungenutzte Statistics-/Idempotency-Typen aus `shared/statistics.ts` und `server/lib/idempotency.ts` aufräumen; `tests/budget_logic_tests.js` prüfen/löschen. Knip als CI-Gate evaluieren.

### Paket D — Konventions-Drift Frontend (P2)

**D1: `invalidateQueries` → `invalidateRelated()` Audit & Migration** · Aufwand M
Findings-Liste der 56 Direkt-Aufrufer erstellen, je Mutation entscheiden: migrieren oder als legitime Einzel-Invalidierung dokumentieren. Anschließend Lint-Regel/ESLint-Rule (`no-restricted-syntax`) hinzufügen, die direktes `queryClient.invalidateQueries` außerhalb von `invalidateRelated`-Implementierung verbietet.

### Paket E — Shared-Code & Tests (P3)

**E1: `shared/`-README + Cross-Layer-Typen konsolidieren** · Aufwand S
`shared/README.md` mit Konvention (`api/` vs. `schema/` vs. `domain/` vs. `utils/`) anlegen. `team-workload`-Typen aus Server + Frontend in `shared/` extrahieren. Ggf. weitere doppelt deklarierte Typen einbeziehen.

**E2: Test-Helper-Layout vereinheitlichen** · Aufwand S
`tests/test-utils.ts` und `tests/helpers/` konsolidieren; README in `tests/helpers/` ergänzen; flache vs. subdir-basierte Test-Dateien einheitlich organisieren. Berührt nicht die Inhalte der bestehenden Tasks #114/#137/#138/#186.

---

## Anhang — Werkzeug-Output

- `npm run check`: ✅ ohne Fehler
- `npx knip`: 0 unused files, 0 unused deps, 12 unused exports, 23 unused exported types
- `rg "@ts-ignore|@ts-expect-error|@ts-nocheck"`: 0 Fundstellen
- `rg "as any|: any|<any>"`: 17 Fundstellen über 14 Dateien
- Routes-Direktquerys: 138 `db.*`-Aufrufe in 22 Dateien
- Pages > 500 LOC: 19 Dateien (38.843 LOC gesamt)
- Storage-Layout: 18 flache Dateien vs. 29 in 4 Subdirs
