# Chunk 5b — Appointments Frontend

**Tiefenstufe:** Deep (Refresh #822 gap-fill)
**Commit:** `178b2574`
**Risiko:** HOCH
**LOC / Files:** 7 918 / 34

> Dieser Chunk wurde in der Refresh-Welle #822 ursprünglich nur als
> Pattern-Scan abgehakt (mit dem Folge-Task „Deep-Audit Doku-Wizard +
> Mobile-Persistenz"). Dieser Eintrag löst diesen Folge-Task ein: Deep-Dive
> über die Hotspots — Doku-Wizard (`use-documentation-form.ts`,
> `document-appointment.tsx`), Mutations/Invalidation
> (`use-appointment-mutations.ts`, `use-appointment-series.ts`,
> `use-appointments.ts`), Neu-/Bearbeiten-Flows (`use-new-appointment-form.ts`,
> `edit-appointment.tsx`, `appointment-detail.tsx`) sowie Serien-/Import-Pfade.
> Severity-Aggregation bleibt in `../REPORT.md` maßgeblich.

## Befunde

### KRITISCH
- Keine.

### HOCH
- **Page-Size-Hard-Limit (>800 LOC) überschritten:**
  - `edit-appointment.tsx` — **1 428 LOC** (≈ 1,8× über Cap)
  - `use-new-appointment-form.ts` — **893 LOC**

  replit.md fordert striktes Modul-Splitting. Grund: Beide bündeln mehrere
  Mutationen + Serien-/Prospect-Sonderpfade + UI in einer Datei; Wartbarkeit,
  Review-Risiko und Merge-Konflikt-Fläche sind hoch. (= Plan §1.2 Splitting-
  Backlog; bislang deferred.) Empfehlung: Mutations-/Form-Logik in Feature-
  Hooks extrahieren analog zu `use-documentation-form.ts`.

### MITTEL
- **Serien-Vorschau-Generierung dupliziert die Server-Logik clientseitig**
  (`use-new-appointment-form.ts:416-464`, `seriesPreview`): Die Termin-Liste
  (`count`, `dates`) wird im Browser über `new Date(ktDate + "T00:00:00")`,
  `getDay()`, `weekCounter % 2` (Bi-Weekly) und `setDate(+1)`-Schleife erzeugt.
  Die **tatsächliche** Serie legt der Server aus
  `startDate`/`endDate`/`weekdays`/`frequency` an. Grund/Risiko: Divergiert die
  clientseitige Wochen-/Frequenz-Berechnung von der Server-Implementierung,
  zeigt der „X Termine"-Preview eine andere Zahl als am Ende gebucht wird
  (Anzeige-vs.-Buchung-Drift). Empfehlung: Preview-Count vom Server beziehen
  oder die Generierung in geteilten `@shared`-Code heben.
- **Page-Size-Soft-Limit (>500 LOC):** `import-appointments.tsx` (765),
  `document-appointment.tsx` (561), `new-appointment-erstberatung-tab.tsx`
  (532). Grund: Splitting-Kandidaten, geringeres Risiko als die HOCH-Fälle.

### NIEDRIG
- **Datetime-Konventionsverstöße (`new Date(string)` statt
  `@shared/utils/datetime`):**
  - `use-new-appointment-form.ts:419-449` (Serien-Datumsarithmetik via
    lokalem Midnight + `getFullYear/getMonth/getDate`),
  - `use-new-appointment-form.ts:504-505` (`new Date(ktDate).getTime()` —
    parst Datum-only als **UTC**-Midnight, während `:419` lokal parst;
    inkonsistent, aber für die 12-Monats-Range-Differenz folgenlos),
  - `new-appointment-kundentermin-tab.tsx:234,243` (Serien-Datums-Anzeige),
  - `use-appointment-series.ts:249` (`SeriesInfo`-Anzeige),
  - `appointment-documentation-diagnosis.tsx:81` (`formatTimestamp`,
    `new Date(iso).toLocaleString`).

  Grund: replit.md verbietet `new Date(string)` und schreibt zentrale,
  Berlin-normierte Helfer vor; überwiegend Anzeige-Pfade → niedrige Severity,
  aber Konventionsbruch + latentes TZ-Drift-Risiko.

## Positiv-Befunde (verifiziert)
- ✅ **Query-Invalidation-Disziplin überdurchschnittlich:** Alle Mutationen in
  `use-appointment-mutations.ts`, `use-appointment-series.ts`,
  `use-appointments.ts`, `edit-appointment.tsx` und `appointment-detail.tsx`
  nutzen `invalidateRelated` mit korrektem **customerId-Scoping** plus gezielten
  `refetchQueries(["budget-overview", customerId])`. Die zwei direkten
  `invalidateQueries`-Aufrufe (`use-appointment-mutations.ts:111` und `:143`,
  appointment-scoped `…/services`-Key) sind regelkonform mit
  `// invalidate-direct-allowed:` + `eslint-disable` markiert.
- ✅ **Mobile-Doku-Submit ist robust (#490):** `use-documentation-form.ts`
  implementiert eine saubere Submit-State-Machine (`idle/submitting/success/
  error`) mit `lastPayloadRef`-basiertem **Retry**, transientem Auto-Retry über
  `submitWithRetry` (nur Netzwerk/5xx, NIE fachliche 4xx wie
  `ALREADY_COMPLETED`/`SIGNATURE_LOCKED`), persistentem Fehler-Banner und
  deutschen Toasts. `document-appointment.tsx` nutzt durchgängig `min-h-[44px]`-
  Tap-Targets und native `type="time"`/`type="date"`-Picker.
- ✅ **Doppel-Submit-Schutz:** `isSubmitting`-Gate
  (`submitState === "submitting" || documentMutation.isPending`) sperrt die
  Aktionsbuttons.

## Test-Coverage
- ✅ E2E `e2e/smoke/documentation-submit-retry.spec.ts` — deckt die #490-
  Retry-State-Machine ab.
- ✅ E2E `e2e/smoke/appointment-detail-mobile-layout.spec.ts` — Mobile-Layout
  der Detailseite.
- ✅ E2E `e2e/smoke/edit-persistence.spec.ts` — Persistenz nach Bearbeiten.
- ✅ `tests/appointments/lock-after-ln-sign.test.ts` — Lock-Verhalten nach
  Leistungsnachweis-Signatur.
- ⚠️ **Lücke:** Keine direkte Unit-Coverage der `seriesPreview`-Generierung
  (`use-new-appointment-form.ts`) — gerade der unter MITTEL beschriebene
  Client-vs.-Server-Drift bleibt ungetestet.
- ⚠️ **Lücke:** Kein Test für die Datetime-Helfer-Konformität in diesem Feature
  (Serien-Datumsarithmetik, TZ-Verhalten).
- ℹ️ Die E2E-Smoke-Suite war zum Zeitpunkt früherer Refreshes wegen eines
  DB-Race im Test-Setup zeitweise rot; das ist ein bekanntes Setup-/Flake-
  Thema (flaky-tests.md) und KEIN neues Code-Finding dieses Chunks.
