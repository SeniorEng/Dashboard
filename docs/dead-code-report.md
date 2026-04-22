# Dead-Code-Analysebericht (Task #129)

**Stand:** 22.04.2026  
**Werkzeuge:** `knip@5` (Konfiguration in `knip.json`), Cross-Check mit `ts-prune`  
**Vorbedingung:** Refactoring-Sprints #107 und #108 sowie #109 sind abgeschlossen.

> **Wichtig:** Dieser Bericht **löscht nichts**. Er ist die Grundlage für eine
> bewusste Freigabe-Entscheidung. Pro Block markiert das **Risiko** (🟢 sicher,
> 🟡 prüfen, 🔴 nicht ohne Detailprüfung) den empfohlenen Umgang.

## Zusammenfassung

| Bereich | Funde | Empfehlung |
|---|---|---|
| Unbenutzte npm-Dependencies | 2 | 🟢 Quick Win — entfernen |
| `shared/types.ts` Doppel-Exports | ~15 | 🟢 Quick Win — wurden nach `shared/domain/*` migriert |
| Storage-Refactor-Reste (#108 Phase 3) | 6 | 🟡 prüfen — Interface-Aufräum nicht vollständig |
| Auto-generierter UI-Library-Code (shadcn) | ~50 | 🔴 nicht löschen — Konvention/Parität mit Upstream |
| Replit Object-Storage Integration | 9 | 🔴 nicht anrühren — auto-generiert |
| Tote Service-Klassen / Helper | ~10 | 🟡 prüfen — pro Stück Architektur-Entscheidung |
| Re-Export-Duplikate in `*/hooks/index.ts` | ~25 | 🟡 prüfen — Barrel-Konvention vs. Treeshaking |
| Tote Type-Exports | ~52 | 🟡 prüfen — Library-API vs. App-API |
| **Gesamt potenziell entfernbar** | **~170 Symbole** | – |

---

## 1. 🟢 Quick Wins (sicher löschbar nach Freigabe)

### 1.1 Unbenutzte Dependencies (`package.json`)

| Paket | Begründung |
|---|---|
| `node-zugferd` | Wird nirgends importiert. ZUGFeRD-XML wird über eigene Implementierung in `server/lib/zugferd.ts` erzeugt. |
| `tw-animate-css` | Kein Import in CSS oder `tailwind.config`. Vermutlich Restbestand eines früheren UI-Versuchs. |

**Aktion:** `npm uninstall node-zugferd tw-animate-css` (–2 Pakete, –~150 transitive).

### 1.2 `shared/types.ts` — komplette Doppel-Exports nach Domain-Migration

`shared/types.ts` ist eine alte Sammeldatei. Die meisten Exports leben jetzt in
`shared/domain/appointments.ts`, `shared/utils/holidays.ts`, etc. Folgende
Exports aus `shared/types.ts` haben **null Konsumenten** (außer der Datei
selbst), weil das Original woanders importiert wird:

- `AppointmentType`, `ServiceInfo`, `CardServiceInfo`, `TravelOriginSuggestion`
- `STATUS_ORDER`, `STATUS_LABELS`, `STATUS_COLORS`
- `APPOINTMENT_TYPE_COLORS`, `SERVICE_TYPE_COLORS`
- `getStatusColor`, `getStatusLabel`, `getAppointmentTypeColor`, `getServiceColor`
- `validateServiceDocumentationFromServices`, `suggestTravelOrigin`

`@shared/types` wird weiterhin für **`BirthdayEntry`, `AppointmentWithCustomer`,
`DURATION_OPTIONS`, `PFLEGEGRAD_OPTIONS`, `formatDuration`** gebraucht (heavy
usage in `client/src/pages/`). Diese müssten bleiben (oder ebenfalls in
`shared/domain/*` migriert werden).

**Aktion:** Nur die Doppel-Exports löschen, Datei behalten.

### 1.3 `shared/domain/appointments.ts` — Color-Tokens nirgends mehr genutzt

Nach UI-Refactor wurden Farben über `client/src/design-system/tokens.ts` zentralisiert.
Aus `shared/domain/appointments.ts` werden folgende Konstanten und Helper nicht
mehr importiert:

- `STATUS_ORDER`, `STATUS_COLORS`, `APPOINTMENT_TYPE_COLORS`, `SERVICE_TYPE_COLORS`
- `getStatusColor`, `getStatusLabel`, `getAppointmentTypeColor`, `getServiceColor`

**Aktion:** Entfernen.

### 1.4 Weitere kleine Dead-Symbols

| Pfad | Symbol | Bemerkung |
|---|---|---|
| `shared/utils/datetime.ts` | `firstDayOfMonth`, `lastDayOfYear` | Keine Importer. |
| `shared/utils/phone.ts` | `DACH_COUNTRIES`, `isDACHCountry` | DACH-Validierung läuft inline in `phone.ts`. |
| `shared/utils/zod-german.ts` | `germanErrorMap` | Wird nirgends als Zod-Errormap registriert. |
| `shared/domain/customers.ts` | `CONTACT_TYPE_VALUES`, `PFLEGEGRAD_VALUES` | Konkurrenz zu `PFLEGEGRAD_OPTIONS`. |
| `shared/domain/time-entries.ts` | `ENTRY_TYPE_LABELS` | Labels werden in der UI direkt gesetzt. |
| `shared/domain/vacation.ts` | `calculateProRataVacationDays` | Anteilige Berechnung läuft serverseitig anders. |
| `client/src/hooks/use-toast.ts` | `reducer`, `toast` | Werden über `use-toast`-Hook konsumiert, nicht direkt. |
| `client/src/lib/api/client.ts` & `index.ts` | `apiRequest` | Konsumenten nutzen `apiPost/apiGet/...`. |

---

## 2. 🟡 Bitte prüfen (Diskussionspunkte)

### 2.1 Storage-Refactor #108 — Interface-Aufräumung unvollständig

Laut Task #108 Phase 3 sollten folgende Symbole **modul-intern** werden (nicht
mehr exportiert):

| Pfad | Symbol | Aktueller Status |
|---|---|---|
| `server/storage/budget/allocation-storage.ts` | `getMonthlyBudgetAmountCents` | exportiert, kein externer Konsument |
| `server/storage/budget/allocation-storage.ts` | `ensureYearlyCarryover45b` | exportiert, kein externer Konsument |
| `server/storage/budget/allocation-storage.ts` | `processExpiredCarryover` | exportiert, kein externer Konsument |
| `server/storage/budget/summary-queries.ts` | `getBudgetSummary45a` | exportiert, kein externer Konsument |
| `server/storage/budget/summary-queries.ts` | `getBudgetSummary39_42a` | exportiert, kein externer Konsument |
| `server/storage/budget/summary-queries.ts` | `getAvailableCarryoverCents` | exportiert, kein externer Konsument |

**Empfehlung:** `export` entfernen → reine modul-interne Funktionen. Keine
Verhaltensänderung, nur Sichtbarkeit. Risiko niedrig, weil knip + ts-prune
beide bestätigen, dass es keine Importer gibt.

### 2.2 Tote Service-Klassen / Helper

| Pfad | Symbol | Anmerkung |
|---|---|---|
| `server/services/appointments.ts` | `AppointmentService` (Klasse) | Konkurriert mit funktionalem Code in `routes/appointments.ts`. **Klären:** Architektur-Migration unvollständig? |
| `server/services/auth.ts` | `AuthService` (Klasse) | Dito. |
| `server/services/whatsapp-service.ts` | `WhatsAppService` (Klasse) | Vermutlich nie produktiv genutzt; WhatsApp-Notifications laufen über Direkt-API. |
| `server/services/whatsapp-reminder-scheduler.ts` | `sendDailyAppointmentReminders` | Cron-Eintrag prüfen — falls keiner ruft, ganzer Datei tot. |
| `server/storage.ts` | `DatabaseStorage` (Klasse) | God-Klasse aus Vor-Refactor-Zeit; wahrscheinlich Restbestand. |
| `server/storage/customer-management.ts` | `CustomerManagementStorage` | Klassen-Wrapper überflüssig, wenn nur Funktionen exportiert werden. |
| `server/storage/documents.ts` | `DocumentStorage` | Dito. |
| `server/storage/service-catalog.ts` | `ServiceCatalogStorage` | Dito. |
| `server/services/template-engine.ts` | `buildPlaceholdersFromFormData` | Wird durch konkurrierende Funktion ersetzt. |
| `server/services/cover-letter.ts` | `renderCoverLetterText` | Anschreiben-Generierung läuft über andere Pfade. |
| `server/services/document-pdf.ts` | `generateSigningToken`, `hashToken` | Token-Logik scheinbar dupliziert in `services/document-trigger-engine.ts`. |
| `server/lib/zugferd.ts` | `generateZugferdXml` | Wird ZUGFeRD aktuell wirklich erzeugt? Falls die Funktion tot ist und nicht via `import()` gerufen wird, kann sie weg. |
| `server/services/travel-time.ts` | `calculateBuffer`, `calculatePickupTime`, `getOsrmRoute` | Travel-Logik konsolidiert? |
| `server/services/call-scheduler.ts` | `calculateNextCallTime` | Call-Scheduling aktuell deaktiviert? |

**Empfehlung:** Pro Eintrag manuell verifizieren (Suche nach dynamischen
Importen, Cron-Eintrag, externen Konsumenten). Falls bestätigt tot → löschen.

### 2.3 Tote Hook-Re-Exports (`client/src/features/.../hooks/index.ts`)

Die `index.ts`-Barrel-Files re-exportieren viele Hooks/Konstanten, die direkt
aus den Quelldateien importiert werden. Beispiele:

- `client/src/features/appointments/hooks/index.ts`: 19 ungenutzte Re-Exports
- `client/src/features/customers/hooks/index.ts`: `employeeKeys`,
  `useEmployeeWorkload`, `employeeWorkloadKeys`, `insuranceProviderKeys`
- `client/src/features/prospects/index.ts`: `useProspectAppointmentData`
- `client/src/features/time-tracking/hooks/use-month-closing.ts`:
  `useMonthClosingReadiness`, `useMonthClosingPreview` (ggf. tot in der UI?)

**Diskussion:** Behalten als Convention (Barrel als Public API) oder ausdünnen?
Wenn Treeshaking funktioniert, schadet ein toter Re-Export nichts; wenn die
Barrel-Konvention gestrichen wird, alle direkten Imports lassen und Barrels
löschen.

### 2.4 Tote Type-Exports (52 Stück)

Die meisten sind Public-API-Typen für Hooks oder Service-Module. Beispiele:

- `client/src/lib/api/types.ts`: 12 ungenutzte Interface-Definitionen
  (`PaginationParams`, `CustomerPricingInfo`, …) — vermutlich aus dem
  API-Contract-Audit (Skill `api-contract-audit`) übrig.
- `server/storage/time-tracking.ts`: 11 Typ-Exports
  (`TimeEntryFilters`, `VacationSummary`, …) — werden über
  `ITimeTrackingStorage` referenziert?
- `server/storage/budget-ledger.ts`: 7 Typen — die werden in der Facade
  re-exportiert; **das ist die Public API der Storage-Schicht und sollte
  bleiben**.

**Empfehlung:** Sehr selektiv vorgehen. Typen die eine öffentliche
Schnittstellen-Rolle haben (Storage-Interfaces, API-Response-Typen) bleiben
auch ohne aktuellen Konsumenten — sie sind das Vertragsdokument.

### 2.5 `server/storage/tasks.ts` — tote Helper

- `findMonthClosingTask`, `findBirthdayTask`: Werden in keinem Worker mehr
  benutzt. Wenn die Background-Jobs umgestellt wurden → löschbar.
- `completeBirthdayTask`, `reopenBirthdayTask`: Geburtstags-Task-Lifecycle
  scheinbar nicht (mehr) im Einsatz.

### 2.6 `server/storage/whatsapp.ts` — `upsertWhatsAppNotificationRule`

Notification-Regeln werden vermutlich anders verwaltet. Bitte vor Löschung
checken, ob Admin-UI dafür existiert.

---

## 3. 🔴 Nicht löschen (auto-generiert oder Library-Konvention)

### 3.1 shadcn/ui Komponenten (`client/src/components/ui/*`)

Viele Sub-Exports (`AlertDialogPortal`, `DropdownMenuRadioItem`, `SheetClose`,
…) sind Teil der shadcn-Standardpakete. Sie werden bewusst mit-exportiert, um
Parität mit Upstream-Updates zu wahren — beim nächsten `npx shadcn add`-Sync
würden sie sonst wieder auftauchen.

**Empfehlung:** **In Ruhe lassen.**

### 3.2 Replit Object-Storage Integration (`server/replit_integrations/object_storage/index.ts`)

`ObjectStorageService`, `ObjectNotFoundError`, `objectStorageClient`,
`canAccessObject`, `getObjectAclPolicy`, `setObjectAclPolicy` und die zugehörigen
Typen sind Teil der Replit-Integrations-Blueprint und werden bei Updates der
Integration überschrieben.

**Empfehlung:** **Nicht anrühren.**

### 3.3 `BudgetLedgerStorage`-Interface-Typen

`BudgetSummary`, `Budget45aSummary`, `Budget39_42aSummary`, `AllBudgetSummaries`,
`CascadeResult`, `DbClient`, `BudgetLedgerStorage` werden zwar formal "nicht
extern importiert" — sie sind aber das **Vertragsdokument** der gerade in
#108 fertiggestellten Storage-Facade. Müssen bleiben.

---

## 4. Empfohlene Quick-Wins (Konsens-Aktion)

Falls du schnell aufräumen willst, **das hier ist sicher** und erzeugt keine
Verhaltensänderung:

1. `npm uninstall node-zugferd tw-animate-css`
2. Aus `shared/types.ts` die ~15 Doppel-Exports löschen (siehe 1.2).
3. Aus `shared/domain/appointments.ts` die ~8 ungenutzten Color-Tokens und
   Helpers löschen (siehe 1.3).
4. Die kleinen Helper aus 1.4 (~10 Symbole) löschen.
5. Aus den 6 Symbolen aus #108-Restarbeit das `export` entfernen
   (siehe 2.1) — pure Sichtbarkeitsänderung.

**Erwarteter Aufwand:** ~30–45 Minuten inklusive `tsc`-Check und Test-Lauf.  
**Erwarteter Effekt:** ~50 tote Symbole weg, 2 Pakete weniger im Lockfile.

## 5. Diskussionspunkte für eine zweite Runde

- **§ 2.2 Service-Klassen** — Architektur-Frage: Klassen-Wrapper komplett raus
  oder ist da eine geplante Migration zu Service-Layer?
- **§ 2.3 Hook-Barrels** — Public-API-Konvention beibehalten oder treeshaken?
- **§ 2.4 API-Types** — Welche Typen sind reines Vertragsdokument
  (`shared/api/*.ts`), welche sind tote Hook-internals?
- **§ 2.5/2.6 Task-Helper** — Sind Background-Jobs für Birthday/MonthClosing
  vollständig umgezogen?

## 6. Wie diesen Bericht reproduzieren

```bash
npx knip --no-progress --reporter compact   # Knip-Befunde (Hauptquelle)
npx ts-prune -p tsconfig.json | grep -v "used in module"   # Cross-Check
```

Konfiguration: `knip.json` im Repo-Root.
