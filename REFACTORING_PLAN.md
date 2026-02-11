# SeniorenEngel / CareConnect – Refactoring-Plan

**Erstellt:** 2026-02-11
**Codebase-Größe:** ~37.400 Zeilen (Server: 11.142, Client: 23.450, Shared: 2.845)

---

## Übersicht

Die App ist funktional umfangreich und bereits mit guter Architektur aufgebaut (Service-Layer, Storage-Abstraktion, Feature-basierte Frontend-Struktur, Shared-Domain-Logik). Dieses Dokument identifiziert Verbesserungspotenziale für Code-Qualität, Wartbarkeit und Skalierbarkeit.

---

## 1. KRITISCH: Direkte DB-Zugriffe in Route-Handlern

**Problem:** 4 Route-Dateien greifen direkt auf die Datenbank zu, statt den Storage-Layer zu nutzen. Das umgeht die Abstraktion, erschwert Testing und macht zukünftiges Caching unmöglich.

**Betroffene Dateien & Queries:**

| Datei | Queries | Typ |
|-------|---------|-----|
| `server/routes/appointments.ts` (719 Z.) | 5 direkte DB-Queries | SELECT, INSERT auf `appointment_services` |
| `server/routes/admin/customers.ts` (696 Z.) | 6 direkte DB-Queries | INSERT/UPDATE auf `customer_assignment_history`, `customers` |
| `server/routes/time-entries.ts` (742 Z.) | 4 direkte DB-Queries | SELECT/INSERT auf `employee_month_closings` |
| `server/routes/settings.ts` (61 Z.) | 2 direkte DB-Queries | SELECT/INSERT auf `system_settings` |

**Maßnahme:**
1. Entsprechende Methoden im Storage-Layer erstellen
2. Route-Handler auf Storage-Aufrufe umstellen
3. `import { db }` aus Route-Dateien entfernen

**Aufwand:** Mittel | **Impact:** Hoch (Architektur-Konsistenz)

---

## 2. HOCH: Überdimensionierte Route-Dateien

**Problem:** Mehrere Route-Dateien sind zu groß und mischen verschiedene Verantwortlichkeiten:

| Datei | Zeilen | Enthält |
|-------|--------|---------|
| `server/routes/time-entries.ts` | 742 | CRUD + Month-Closing + Vacation + Auto-Breaks + Validation |
| `server/routes/appointments.ts` | 719 | CRUD + Documentation + Services + Status + Validation |
| `server/routes/admin/customers.ts` | 696 | CRUD + Assignments + Contacts + Recurring + Insurance + History |
| `server/routes/budget.ts` | 582 | Allocations + Consumption + Estimation + Cascade + Settings |

**Maßnahme:**
1. `time-entries.ts` aufteilen: `time-entries.ts` (CRUD), `month-closing.ts` (Monatsabschluss)
2. `appointments.ts` aufteilen: `appointments.ts` (CRUD/Status), `appointment-documentation.ts` (Dokumentation)
3. `admin/customers.ts` aufteilen: `admin/customers.ts` (CRUD), `admin/customer-assignments.ts` (Zuweisungen), `admin/customer-contacts.ts` (Kontakte)
4. Business-Logik in Service-Layer verschieben

**Aufwand:** Hoch | **Impact:** Hoch (Wartbarkeit, Testbarkeit)

---

## 3. HOCH: Fehlerbehandlung standardisieren

**Problem:** 149 try-catch-Blöcke in Route-Handlern mit inkonsistenter Fehlerbehandlung. Viele Handler haben identische catch-Blöcke:

```typescript
catch (error) {
  console.error("...", error);
  res.status(500).json({ message: "..." });
}
```

**Maßnahme:**
1. Express Error-Handling-Middleware erstellen (zentral)
2. Route-Handler auf `next(error)` umstellen
3. Zod-Validierungsfehler automatisch behandeln
4. Einheitliche Fehler-Response-Struktur sicherstellen

**Aufwand:** Mittel | **Impact:** Hoch (Code-Reduktion, Konsistenz)

---

## 4. HOCH: Storage-Layer aufteilen

**Problem:** `server/storage.ts` (848 Zeilen) ist die zentrale Datei mit dem `IStorage`-Interface und `DatabaseStorage`-Klasse. Zusammen mit den Storage-Modulen (3.469 Zeilen) entsteht eine sehr große, schwer navigierbare Abstraktion.

**Aktuelle Struktur:**
```
server/storage.ts              (848 Z.) - Interface + Hauptklasse
server/storage/budget-ledger.ts (1.301 Z.) - Budget-Logik
server/storage/customer-management.ts (866 Z.)
server/storage/time-tracking.ts (665 Z.)
server/storage/tasks.ts         (215 Z.)
server/storage/service-catalog.ts (204 Z.)
server/storage/customer-pricing.ts (119 Z.)
server/storage/compensation.ts   (99 Z.)
```

**Maßnahme:**
1. `IStorage`-Interface in domänenspezifische Interfaces aufteilen (`IAppointmentStorage`, `ICustomerStorage`, etc.)
2. Storage-Klasse als Facade über spezialisierte Module
3. Methoden für `appointment_services`, `month_closings`, `system_settings` aus Routes hierher verschieben

**Aufwand:** Hoch | **Impact:** Mittel-Hoch (Modularität)

---

## 5. HOCH: Überdimensionierte Page-Komponenten

**Problem:** Mehrere Frontend-Seiten sind zu lang und mischen UI, Logik und API-Aufrufe:

| Seite | Zeilen | Problem |
|-------|--------|---------|
| `new-appointment.tsx` | 679 | Form-Logik + Validation + UI |
| `admin/time-entries.tsx` | 629 | Admin-Tabelle + Dialoge + Filter |
| `document-appointment.tsx` | 615 | Dokumentations-Flow + Signatur + Services |
| `admin/services.tsx` | 556 | Service-Verwaltung + Formulare |
| `admin/insurance-providers.tsx` | 521 | Provider-CRUD + Formulare |
| `admin/customer-new.tsx` | 485 | Multi-Step-Form |

**Maßnahme:**
1. Custom Hooks für Daten-Logik extrahieren (nach `features/*/hooks/` Pattern)
2. Form-Komponenten in eigene Dateien auslagern
3. Listen-/Tabellen-Komponenten separieren
4. Bestehendes Feature-Pattern (`features/appointments/`, `features/time-tracking/`) als Vorbild

**Aufwand:** Hoch | **Impact:** Mittel (Wartbarkeit, Wiederverwendbarkeit)

---

## 6. MITTEL: Shared Domain-Logik erweitern

**Problem:** `shared/domain/` hat nur 2 Dateien (appointments: 421 Z., budgets: 105 Z.). Viel Business-Logik lebt noch in Route-Handlern und Seiten.

**Kandidaten für Domain-Module:**
- `shared/domain/time-entries.ts` – Pausenregeln, Monatsabschluss-Logik, Urlaubsberechnung
- `shared/domain/customers.ts` – Pflegegrad-Regeln, Kontakt-Typen, Status-Logik
- `shared/domain/services.ts` – Service-Typ-Regeln, System-Service-Logik, Abrechnungsregeln

**Aufwand:** Mittel | **Impact:** Mittel (Single Source of Truth)

---

## 7. MITTEL: TypeScript-Fehler beheben

**Problem:** ~12 TypeScript-Fehler im Codebase (pre-existing):
- Typ-Verengung bei String-Literalen (admin/customers.ts, services.tsx)
- `Express.User` Namespace-Problem (appointments.ts)
- Map-Iteration ohne `downlevelIteration` (cache.ts)
- Fehlende Felder in Insurance-Provider-Typen (customer-management.ts)

**Maßnahme:** Systematisch jeden Fehler beheben, ggf. tsconfig.json anpassen.

**Aufwand:** Niedrig-Mittel | **Impact:** Mittel (Code-Qualität, IDE-Unterstützung)

---

## 8. MITTEL: Test-Abdeckung verbessern

**Aktuelle Tests:**
```
tests/auth.test.ts
tests/appointments.test.ts
tests/customers.test.ts
tests/budget.test.ts
tests/services.test.ts
tests/time-entries.test.ts
tests/setup.ts
tests/test-utils.ts
```

**Fehlende Tests:**
- Service-Layer (appointments, auto-breaks, cache)
- Domain-Logik (shared/domain/*)
- Budget-Berechnung (Kaskaden-Buchung, FIFO)
- Storage-Module (budget-ledger, customer-management)

**Aufwand:** Hoch | **Impact:** Mittel (Regressionssicherheit)

---

## 9. MITTEL: Design-System-Tokens aufräumen

**Problem:** `client/src/design-system/tokens.ts` enthält deprecated Avatar-Styles und möglicherweise ungenutzte Tokens.

**Maßnahme:**
1. Alle Token-Referenzen im Code prüfen
2. Ungenutzte Tokens entfernen
3. Deprecated Avatar-Sektion entfernen

**Aufwand:** Niedrig | **Impact:** Niedrig (Code-Hygiene)

---

## 10. NIEDRIG: Zentrale Fehler-Codes konsolidieren

**Problem:** `server/lib/errors.ts` definiert Fehler-Codes, aber nicht alle Routes nutzen sie konsistent.

**Maßnahme:** Alle Fehler-Responses auf zentrale Codes umstellen.

**Aufwand:** Mittel | **Impact:** Niedrig (API-Konsistenz)

---

## EMPFOHLENE REIHENFOLGE

### Sprint 1: Quick Fixes (1-2 Tage)
1. TypeScript-Fehler beheben (#7)
2. Design-System-Tokens aufräumen (#9)
3. Zentrale Fehlerbehandlung-Middleware (#3 - Grundstruktur)

### Sprint 2: Architektur-Bereinigung (3-5 Tage)
4. Direkte DB-Zugriffe in Storage-Layer verschieben (#1)
5. Route-Dateien aufteilen (#2 - größte Dateien zuerst)
6. Storage-Interface modularisieren (#4)

### Sprint 3: Frontend-Refactoring (3-5 Tage)
7. Page-Komponenten aufteilen (#5 - größte Seiten zuerst)
8. Shared Domain-Logik erweitern (#6)

### Sprint 4: Qualitätssicherung (2-3 Tage)
9. Test-Abdeckung verbessern (#8)
10. Fehler-Codes konsolidieren (#10)

---

## RISIKEN & HINWEISE

- **vite.config.ts** ist eine geschützte Datei und kann nicht automatisch bearbeitet werden. Manual Vendor Chunks müssen manuell umgesetzt werden.
- **Keine Breaking Changes** an der API: Frontend-Client-Calls müssen kompatibel bleiben.
- **Drizzle-Migrationen** für Schema-Änderungen immer über `db:push` anwenden.
- **Feature-Flags** für größere Refactorings in Betracht ziehen, um schrittweise umzustellen.
