# Vollständige Tiefenanalyse & Refactoring-Plan — CareConnect

**Erstellt:** 2026-04-18
**Methode:** Gestaffelte 3-Phasen-Tiefenanalyse (Code Quality + Database → Business Logic + Error Handling + Security + Performance → UI/UX + QA + Regression Guard)
**Vorgängerbericht:** `.local/tiefenanalyse-full-app-2026-04-03.md` (15 Tage alt) — Status der dortigen Findings im Anhang B
**Codebase-Größe:** 416 Dateien, ~96.700 Zeilen TS/TSX

> **Scope:** Nur Analyse & Priorisierung. Keine Implementierung. Aufwand: **S** = ≤2h, **M** = ½–1 Tag, **L** = >1 Tag.

---

## 0. Gesamtbewertung

| Aspekt | Note | Trend ggü. 03.04. | Begründung |
|---|---|---|---|
| **Architektur** | ✅ GUT | ↗ | 6 Route-Dateien greifen noch direkt auf `db` zu, sonst saubere Schichten |
| **Datenintegrität** | ✅ GUT | ↑↑ | km×10-Artefakt **behoben**, Split-Rechnung in Transaktion **gewrappt** |
| **Sicherheit** | ⚠️ MITTEL | → | npm-Schwachstellen offen (basic-ftp HIGH), Mass-Assignment-Risiken |
| **Fehlerbehandlung** | ✅ GUT | → | `asyncHandler`-Pattern konsistent, wenige `catch{}` & generische Toasts |
| **Performance** | ⚠️ MITTEL | → | N+1 in `getPlannedCostCents` weiterhin offen (in neue Datei verschoben), Composite-Index fehlt |
| **UX / Accessibility** | ⚠️ MITTEL | → | aria-labels fehlen, einige Listen noch mit `Loader2` statt Skeleton, kleine Touch-Targets |
| **Testabdeckung** | 🔴 SCHWACH | → | Billing-Flow weiterhin ungetestet, kein E2E-Coverage-Report greifbar |

**Gesamtfazit:** Die App ist deutlich stabiler als am 03.04. Die zuvor kritischen Datenkorruptionsrisiken (km×10, Split-Rechnung ohne Transaktion, PDF-XSS) sind behoben. Verbleibende Risiken sind primär **Mass-Assignment**, **Timezone-Bugs durch `new Date(stringVar)`**, sowie **Performance** und **UX-Politur** in einigen Hot-Files.

---

## 1. Status-Übersicht

| ID | Prio | Thema | Aufwand | Phase |
|---|---|---|---|---|
| **K1** | 🔴 KRITISCH | Mass-Assignment via `...req.body` (budgets, register) | S | P2-Sec |
| **K2** | 🔴 KRITISCH | `new Date(stringVar)` Timezone-Bugs (6 Stellen prod) | S | P1-CQ |
| **K3** | 🔴 KRITISCH | npm: `basic-ftp` HIGH (CRLF/DoS) + axios SSRF + dompurify | S | P2-Sec |
| **H1** | 🟠 HOCH | 6 Route-Dateien mit direktem `db.*`-Zugriff | M | P1-CQ |
| **H2** | 🟠 HOCH | N+1 in `getPlannedCostCents` (appointment-cost-calculator.ts:123) | M | P2-Perf |
| **H3** | 🟠 HOCH | Split-Rechnungen ohne `parent_invoice_id` → Storno-Inkonsistenz | M | P2-BL |
| **H4** | 🟠 HOCH | `parseInt(req.params.id)` ohne NaN-Check (mehrere admin-Routes) | S | P3-QA |
| **H5** | 🟠 HOCH | Composite-Index `budgetTransactions(customerId, budgetType, transactionType)` fehlt | S | P1-DB |
| **H6** | 🟠 HOCH | Icon-only Buttons ohne `aria-label` (Dashboard, availability, proof-review) | S | P3-UX |
| **M1** | 🟡 MITTEL | `error-boundary.tsx` benutzt eigenes `bg-gradient` (Layout-Konvention) | S | P3-UX |
| **M2** | 🟡 MITTEL | Generische Fallback-Fehler `"Fehler beim Speichern"` statt `error.message` | S | P2-EH |
| **M3** | 🟡 MITTEL | List-Endpunkte ohne Pagination (audit-log, whatsapp/log, vacation-summary) | M | P2-Perf |
| **M4** | 🟡 MITTEL | Listen mit `Loader2` statt Skeleton (customers, service-records, undocumented) | S | P3-UX |
| **M5** | 🟡 MITTEL | `customer-detail.tsx`: 4 separate `useQuery` → kombinierbar | M | P2-Perf |
| **M6** | 🟡 MITTEL | Empty `catch{}` in `session-timeout-warning.tsx`, `server/index.ts:316` | S | P2-EH |
| **M7** | 🟡 MITTEL | Touch-Target <44px in `layout.tsx:228` (raw `<button>` mit `p-1.5`) | S | P3-UX |
| **M8** | 🟡 MITTEL | `calendar.tsx:198`: `toLocaleDateString()` ohne `de-DE` Locale | S | P3-UX |
| **M9** | 🟡 MITTEL | Mutationen ohne Optimistic-Rollback-Pattern (`onMutate` snapshot) | M | P3-QA |
| **M10** | 🟡 MITTEL | 0 % Test-Coverage für Billing-Flow (Split / Storno / Nachberechnung) | L | P3-QA |
| **N1** | 🟢 NIEDRIG | `generateZugferdXml` exportiert, nie importiert (Dead Code) | S | P1-CQ |
| **N2** | 🟢 NIEDRIG | `formatCents()` dupliziert: `pdf-generator.ts:90` + `qonto.tsx:109` | S | P1-CQ |
| **N3** | 🟢 NIEDRIG | knip-Konfiguration scannt `.cache/.bun` → 40k false positives | S | P1-CQ |
| **N4** | 🟢 NIEDRIG | 15 Dateien >800 LOC (Wartbarkeitsschwelle) | L | P1-CQ |
| **N5** | 🟢 NIEDRIG | `HH:mm:ss` in `appointments.ts:389` (Display sollte `HH:mm`) | S | P3-UX |
| **N6** | 🟢 NIEDRIG | FK-Indexe fehlen: `budget_allocations.created_by_user_id` u.a. | S | P1-DB |
| **N7** | 🟢 NIEDRIG | Kein Caching-Layer (Redis o.ä.) für Customer/Employee/Service-Catalog | M | P2-Perf |
| **N8** | 🟢 NIEDRIG | Schema nutzt `timestamp` statt empfohlenem `timestamptz` | M | P1-DB |
| **N9** | 🟢 NIEDRIG | `neon driver bug`-Handler in `server/index.ts:98` weiterhin nötig? | S | P2-EH |
| **N10** | 🟢 NIEDRIG | `...req.body`-Spread in `auth.ts` (Registrierung) ohne explizites Whitelisting | S | P2-Sec |

**Zusammenfassung:** 3 KRITISCH, 6 HOCH, 10 MITTEL, 10 NIEDRIG = 29 Findings.

---

## 2. KRITISCH — Sofort beheben (1–2 Tage)

### K1 — Mass-Assignment via `...req.body`
**Ort:** `server/routes/admin/customers/budgets.ts`, `server/routes/auth.ts` (Registrierung).
**Risiko:** Angreifer können nicht-erlaubte Felder (z. B. `role`, `isAdmin`, `customerId`) injizieren.
**Maßnahme:** Statt `...req.body` ein Zod-`.pick()` / `.partial()` Schema parsen und nur whitelistete Keys an Storage übergeben.
**Aufwand:** S (1–2 Stellen, Pattern bereits etabliert).

### K2 — `new Date(stringVar)` Timezone-Bugs
**Orte (Production):**
- `server/storage/tasks.ts:382` — `new Date(birthdayDateISO)`
- `server/storage/prospects.ts:148` — `new Date(expiresAt)`
- `server/storage/customer-mgmt/care-level.ts:36` — `new Date(validFromDate)`
- `server/lib/zugferd.ts:37` — innerhalb `parseDateString`
- `client/src/features/notifications/notification-list.tsx:39`
- `client/src/pages/admin/audit-log.tsx:72`

**Risiko:** Bei reinem `YYYY-MM-DD` interpretiert JS UTC-Mitternacht → in CET wird Tag um 1 verschoben. Bisher ein wiederkehrender Bugklassiker im Projekt.
**Maßnahme:** Konsequent `parseLocalDate()` aus `shared/utils/datetime.ts` verwenden. Lint-Regel ergänzen, falls noch nicht aktiv.
**Aufwand:** S (6 punktuelle Ersetzungen).

### K3 — npm-Schwachstellen (HIGH)
**Befund:** `basic-ftp` (CRLF Injection / DoS, **HIGH**), `axios` (SSRF, MODERATE), `dompurify` (MODERATE).
**Maßnahme:**
1. `npm audit fix` für non-breaking Updates.
2. Falls Major-Bumps nötig: betroffene Aufrufstellen identifizieren (`grep -rn "require\|from ['\"]basic-ftp"`), Migration planen.
3. `basic-ftp` ggf. ersetzen, falls nur 1–2 Aufrufstellen existieren.

**Aufwand:** S (sofern auto-fix greift), sonst M.

---

## 3. HOCH — Innerhalb der nächsten 2 Wochen

### H1 — Direkte DB-Zugriffe in 6 Route-Dateien
**Dateien:**
- `server/routes/admin/customers/assignments.ts` (mehrere `db.select`)
- `server/routes/admin/customers/budgets.ts` (`db.select`, `db.update`)
- `server/routes/admin/customers/workflows.ts` (heavy `db.select`)
- `server/routes/admin/time-tracking.ts` (`db.select`)
- `server/routes/admin/qonto.ts` (`db.select`)
- `server/routes/admin/employee-availability.ts` (`db.select`)

**Maßnahme:** Storage-Methoden anlegen (z. B. `customerAssignmentStorage.listForCustomer(id)`), Routes auf Storage umstellen, `import { db }` aus Routes entfernen.
**Aufwand:** M (pro Datei ~30–60 min).

### H2 — N+1 in `getPlannedCostCents`
**Ort:** `server/storage/budget/appointment-cost-calculator.ts:123` — Loop über `appointments` mit `calculateAppointmentCost(appt)` (führt selbst Queries aus).
**Impact:** Budget-Übersicht skaliert linear mit Anzahl geplanter Termine; bei 50 Terminen ~250 Queries.
**Maßnahme:** Batch-Variante `calculateAppointmentCostBatch(appointments[])` einführen, die Service-Catalog & Pricing einmalig vorlädt und dann pro Termin nur in-memory rechnet.
**Aufwand:** M.

### H3 — Split-Rechnungen ohne `parent_invoice_id`
**Ort:** `server/routes/billing.ts:814–1065` (Transaktions-Wrap ✅), `shared/schema/billing.ts` (Schema-Lücke).
**Risiko:** Storno einer der beiden Rechnungen lässt die andere "verwaist". Nutzer sieht Inkonsistenz erst beim nächsten Monatsabschluss.
**Maßnahme:**
1. Schema: `invoices.linked_invoice_id` nullable + Index.
2. Bei Split-Erstellung beide Rechnungen verlinken.
3. Bei Storno: gepaarte Rechnung erkennen → Bestätigungsdialog "Auch die zugehörige Rechnung stornieren?".

**Aufwand:** M (Schema + Migration + Storno-UI).

### H4 — `parseInt(req.params.id)` ohne NaN-Guard
**Orte:** `server/routes/admin/customers.ts:124, 317, 373`, `server/routes/admin/customers/budgets.ts:20`, vermutlich weitere.
**Risiko:** `NaN` → Storage-Query mit `WHERE id = NaN` → 500-Fehler statt 400.
**Maßnahme:** Zentralen Helper `parseIdParam(req, "id")` einführen, der bei Ungültigkeit `AppError.badRequest()` wirft. Routes umstellen via Suchen/Ersetzen.
**Aufwand:** S.

### H5 — Composite-Index für `budget_transactions`
**Befund:** Kein Index auf `(customer_id, budget_type, transaction_type)` — wird in fast jeder Budget-Abfrage genutzt.
**Maßnahme:** Migration mit `CREATE INDEX CONCURRENTLY` (oder Drizzle-Index-Definition + `db:push`).
**Aufwand:** S.

### H6 — Fehlende `aria-label` auf Icon-Buttons
**Orte:** `client/src/pages/dashboard.tsx:157, 167`, `client/src/pages/admin/availability.tsx:111`, `client/src/pages/admin/proof-review.tsx:142`.
**Maßnahme:** Pro Button `aria-label="Aktion"` ergänzen. Optional: ESLint-Regel `jsx-a11y/control-has-associated-label`.
**Aufwand:** S.

---

## 4. MITTEL — Innerhalb des nächsten Monats

| ID | Maßnahme | Aufwand |
|---|---|---|
| M1 | `error-boundary.tsx`: eigenes `bg-gradient` entfernen, Layout-Hintergrund nutzen | S |
| M2 | Toast-Helper schreiben, der konsequent `error.message` mit Fallback nutzt; Hardcoded-Strings ersetzen | S |
| M3 | Pagination (`limit`/`offset` + total) für `audit-log`, `whatsapp/log`, `vacation-summary`. Frontend: Infinite-Scroll oder Page-Controls | M |
| M4 | Skeleton-Komponenten für `customers`, `service-records`, `undocumented-appointments` (3 Listen) | S |
| M5 | `customer-detail.tsx`: kombiniertes `/api/admin/customers/:id/page-data`-Endpoint mit `Promise.all` server-seitig | M |
| M6 | Leere `catch{}` mit explizitem `log.warn(...)` ersetzen | S |
| M7 | `layout.tsx:228`: `min-h-[44px] min-w-[44px]` ergänzen | S |
| M8 | `calendar.tsx:198`: `toLocaleDateString("de-DE", ...)` | S |
| M9 | `useMutation`-Wrapper mit Snapshot/Rollback-Pattern dokumentieren; gezielt für hochfrequente Mutationen anwenden (Termine ändern, Budget) | M |
| M10 | Vitest-Suite für `server/routes/billing.ts`: Happy-Path, Split, Storno, Nachberechnung. Ziel: >70 % Branch-Coverage | L |

---

## 5. NIEDRIG — Backlog / Tech-Debt

| ID | Maßnahme | Aufwand |
|---|---|---|
| N1 | `generateZugferdXml` löschen oder doch verwenden | S |
| N2 | `formatCents` in `shared/utils/money.ts` zentralisieren | S |
| N3 | `knip.json` korrigieren (Cache-Pfade ausschließen) → echte Dead-Code-Reports | S |
| N4 | Top-15 Dateien >800 LOC schrittweise zerlegen (`billing.ts`, `appointments.ts`, `time-tracking.ts`, `prospects.tsx`, `profile.tsx` … ) | L |
| N5 | Display-Format `HH:mm` statt `HH:mm:ss` in `appointments.ts:389` | S |
| N6 | Index auf `budget_allocations.created_by_user_id` und weitere FK-Spalten | S |
| N7 | Lightweight In-Memory-Cache (LRU) für `getInsuranceProviders`, `getServiceCatalog`, `getEmployees` mit kurzem TTL | M |
| N8 | Schema-Migration `timestamp` → `timestamptz` (DST-sicher) | M |
| N9 | Prüfen, ob Neon-Driver-Bug-Handler in `server/index.ts:98` noch nötig (Driver-Version aktuell?) | S |
| N10 | Auth-Registrierung: Zod-Schema für `req.body` statt Spread | S |

---

## 6. Empfohlene Reihenfolge (Sprint-Vorschlag)

**Sprint 1 (Sicherheit & Datenintegrität, ~3 Tage):**
K3 → K1 → K2 → H4 → H5

**Sprint 2 (Architektur-Konsistenz, ~3 Tage):**
H1 → H3 (Schema + Storno-Warnung) → H6 → H2

**Sprint 3 (UX-Politur, ~2 Tage):**
M1 → M2 → M4 → M6 → M7 → M8

**Sprint 4 (Performance + Tests, ~5 Tage):**
M3 → M5 → M9 → M10 → N7

**Backlog (rollend):** N1–N10.

---

## 7. Phasen-Berichte (Roh-Findings)

### Phase 1 — Strukturelle Fakten
- **Code Quality:** 6 Routes mit direktem `db.*`, 6× `new Date(stringVar)`, formatCents-Duplikat, ZUGFeRD-Dead-Code, knip-Konfig defekt.
- **Database:** `budget_transactions`-Composite-Index fehlt, mehrere FK-Spalten ohne Einzel-Index, Schema nutzt `timestamp` statt `timestamptz`. 24 Schema-Dateien sonst konsistent (`integer` für money, `real` für km nach K1-Fix).

### Phase 2 — Domain-Analyse
- **Business Logic:** Erstberatung-Guard ✅ (`appointment-documentation.ts:97`), Budget-Cascade §45b→§45a→§39/42a→Privat zentral in `consumption-engine.ts:244-248` ✅, Idempotency ✅, Signatur-Lock ✅. **Lücke:** Split-Rechnungen nicht verlinkt.
- **Error Handling:** asyncHandler/AppError konsistent, withTimeout in Twilio/Lead-Auto-Reply ✅. 2 leere `catch{}`, ein paar generische Toast-Fallbacks.
- **Security:** Rate-Limiter aktiv (login + password-reset), CSRF via zentralen API-Client ✅, PDF-XSS behoben ✅. **Offen:** Mass-Assignment-Spreads, npm-Schwachstellen.
- **Performance:** N+1 in `getPlannedCostCents`, fehlender Composite-Index, kein Read-Cache, lazy-loading in `App.tsx` ✅.

### Phase 3 — UX & Stabilität
- **UI/UX:** Kleine Touch-Targets in `layout.tsx`, einige Listen mit Spinner statt Skeleton, fehlende aria-labels in 4 Pages, `error-boundary` mit eigenem Background, `calendar.tsx` ohne `de-DE`. Sonst Layout-Pattern konsistent.
- **QA/Edge:** Pflegegrad-Validation ✅, Negativwerte abgedeckt ✅, keine `form.reset()` in `onError` (gut). Lücken: NaN-Guards, Pagination, Optimistic-Rollback.
- **Regression Guard:** Hot-Files (letzte 50 Commits): `appointments.ts`, `schema/appointments.ts`, `new-appointment.tsx`, `time-tracking.ts`. → Diese benötigen besonders sorgfältige Reviews bei künftigen Änderungen.

---

## Anhang A — Verhältnis zu existierenden Dokumenten

- `REFACTORING_PLAN.md` (11.02.2026): historisch, sämtliche dortigen Punkte (1–10) sind erledigt oder in diesem Plan ersetzt. **Empfehlung:** Archivieren oder Header-Hinweis "Superseded by TIEFENANALYSE_REFACTORING_2026-04-18.md" einfügen.
- `PERFORMANCE_GUIDE.md`: weiterhin aktuell als Best-Practice-Referenz, ergänzt diesen Plan.
- `.local/tiefenanalyse-full-app-2026-04-03.md`: siehe Anhang B.

## Anhang B — Status der Findings vom 03.04.2026

| Alt-ID | Thema | Status 18.04. |
|---|---|---|
| K1 | km×10 in budget_transactions | ✅ **BEHOBEN** (Werte direkt, kein /10 mehr im Frontend) |
| K2 | Split-Rechnung ohne `db.transaction()` | ✅ **BEHOBEN** (`billing.ts:814–1065` ist gewrappt) |
| K3 | Frontend ignoriert `splitInvoices:true` | ⚠️ **NICHT VERIFIZIERT** — bitte separat prüfen |
| H1 | PDF-XSS (fehlendes escapeHtml) | ✅ **BEHOBEN** (Coverage in `pdf-generator.ts` vollständig) |
| H2 | npm-Schwachstellen | ↻ **TEILWEISE** (lodash gefixt, aber `basic-ftp`/axios/dompurify offen → K3 neu) |
| H3 | webhook-twilio ohne Timeout | ✅ **BEHOBEN** (`twilio-call-bridge.ts` nutzt `withTimeout`) |
| H4 | `toISOString().split("T")[0]` Timezone | ↻ **TEILWEISE** — meiste Stellen weg, aber `new Date(stringVar)` Verwandtsbug (siehe K2 neu) |
| H5 | Leere catch-Blöcke | ↻ **TEILWEISE** — von 4 auf 2 reduziert |
| M1 | N+1 in `getPlannedCostCents` | ⚠️ **OFFEN** (in `appointment-cost-calculator.ts:123` verschoben) → H2 neu |
| M2 | Composite-Index | ⚠️ **OFFEN** → H5 neu |
| M3 | `Math.round(km)` für duration-Feld | ⚠️ **NICHT VERIFIZIERT** in dieser Runde |
| M4 | Viele Queries in Budget-Übersicht | ⚠️ **OFFEN** (durch H2-Fix mit beseitigt) |
| M5 | Storno für Split-Rechnungen | ⚠️ **OFFEN** → H3 neu |
| M6 | Kleines Rebook-Button-Touch-Target | ⚠️ **NICHT GEPRÜFT** (vermutlich offen) |
| M7 | 0 Billing-Tests | ⚠️ **OFFEN** → M10 neu |
| M8 | `kasseRemaining` negativ | ⚠️ **NICHT VERIFIZIERT** |
| N1–N10 | Diverse | Mehrheit offen (weiter im Backlog) |

---

**Ende des Refactoring-Plans.**
