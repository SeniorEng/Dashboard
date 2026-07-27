# Client/Server-Drift-Audit — CareConnect

Datum: 2026-07-22 · Auditor: Claude (Code-Audit-Subagent)
Scope: `client/src/features/**`, `client/src/pages/**` (+ `client/src/components/**` außer `components/ui/**`), verglichen mit `server/**` und `shared/**`.
Ausgeschlossen: `client/src/components/ui/**` (shadcn-Primitives).

## 0. Was die Drift-Detektoren heute abdecken

`tests/helpers/equality-check.ts` (Task #427) führt read- und write-Pfad **serverseitig** aus und vergleicht eine Kennzahl. Die ~54 Tests in `tests/equality/` decken ab: Budget (39/42a/45a/45b, Carryover, Cap, Ledger, Overview-DTO), Rechnungen (Line-Item-Arithmetik, VAT, Pot-Aufteilung, ZUGFeRD), Storno, Travel/No-Show, Termin-Rebooking, Pflegegrad-Pricing, Month-Close-Cutoff, Import.

Nur **3** Tests referenzieren überhaupt Client-Dateien (jeweils als kommentierte Gegenstelle):
- `invoice-line-item-arithmetic.test.ts` → `client/src/pages/admin/billing.tsx`
- `budget-overview-dto-shape.test.ts` → `client/src/components/budget/BudgetLedgerSection.tsx`
- `45b-start-value-cap-client-server-drift.test.ts` → `client/src/components/budget/BudgetTypeSettings.tsx`

**Alles andere, was der Client selbst rechnet, ist ungedeckt.** Die folgenden Fundstellen sind verifizierte Re-Implementierungen von Server-/Shared-Logik im Client (oder Client-Client-Duplikate), sortiert nach Schwere.

---

## 1. HIGH — Minuten-Attribution pro Termin: 4. Kopie im Tages-Panel (my-times)

**Frage:** „Wie viele Minuten zählt ein Termin (je Status)?"

- **Client:** `client/src/features/time-tracking/components/day-detail-panel.tsx:44-78` (`getAppointmentServices`):
  - `customer_no_show` → `computeNoShowWage` (ok, shared SSoT),
  - `completed || documenting` → `actualDurationMinutes ?? plannedDurationMinutes` (Zeile 58-62),
  - **sonst-Fallback Zeile 70-77: keine Service-Zeilen → `durationPromised`** .
- **Server (Kopie 2):** `server/storage/time-tracking/overview.ts:128-173` — identische Regel (Z. 157-161), aber **ohne** `durationPromised`-Fallback: Termine ohne `appointment_services`-Zeilen tragen 0 Service-Minuten bei.
- **Server (Kopie 3):** `server/storage/time-tracking/payroll-hours.ts:308-309` — dieselbe Regel als SQL `COALESCE(actual, planned)`; Kommentar Z. 387-394 gesteht die Lockstep-Pflicht explizit ein.
- **Shared:** `shared/domain/appointments.ts:116-118` (`isAppointmentDocumented`, Task #1496: dokumentiert = NUR `completed`) — das Panel benutzt lokal ein anderes Prädikat (`completed || documenting`).

**Divergenz-Szenario:** Termin ohne Service-Breakdown (Altdaten/Import): Tages-Panel zeigt `durationPromised`-Minuten, Monatsübersicht (`overview.ts`) und Lohn (`payroll-hours.ts`) zählen 0 → Tagessumme ≠ Monatssumme ≠ Lohn. Ändert jemand die Statusmenge serverseitig (wie bei Task #1496 geschehen), driftet das Panel still.

**SSoT-Vorschlag:** `shared/domain/appointment-minutes.ts` — eine Funktion `effectiveServiceMinutes(appt, services)`, von overview.ts, payroll-hours.ts (als getestete SQL-Spiegelung wie bei `appointment-signed.ts`) und dem Panel konsumiert. Equality-Test: Tages-Panel-Summe == Monats-Overview für denselben Tag.

---

## 2. HIGH — Leistungsnachweis-Anzeige summiert anders als die Rechnung bucht

- **Client:** `client/src/pages/service-record-detail.tsx:206-212`
  ```ts
  const totalMinutes = appointments.reduce(... svc.actualDurationMinutes || 0 ...);
  const totalTravelKm  = ... (apt.travelKilometers || 0);
  const totalCustomerKm = ... (apt.customerKilometers || 0);
  ```
- **Server (Buchungspfad Rechnung):** `server/services/invoice-data.ts:496`
  ```ts
  const durationMinutes = Math.round(svc.actualDurationMinutes ?? svc.plannedDurationMinutes ?? 0);
  ```

**Divergenz-Szenario:** `actualDurationMinutes = null` (nie dokumentiert, aber geplant): Der LN-Detail-Screen zeigt dem Kunden/MA eine Gesamtzeit **ohne** diese Position, die Rechnung bucht sie mit `planned`. Anzeige (LN) ≠ Buchung (Rechnung) für denselben Monat — exakt die Bug-Klasse der Harness, ungedeckt weil der Vergleich LN-Anzeige↔Rechnung nirgends existiert.

**SSoT-Vorschlag:** dieselbe `effectiveServiceMinutes`-SSoT wie Finding 1; alternativ Server liefert `totalMinutes/totalTravelKm/totalCustomerKm` im Record-DTO (Reader = SSoT), Client rendert nur.

---

## 3. HIGH — „Offene Rechnungen €" wird dreimal unterschiedlich beantwortet

- **Client (Kopie 1):** `client/src/features/admin/components/admin-cockpit.tsx:207-208` — Cockpit-Kachel „Offene Rechnungen" = Σ `grossAmountCents` über `/billing/open-for-match` (= nur unbeanspruchte `versendet`-Rechnungen, Zweck: Qonto-Matching, `server/routes/billing.ts:244-248`).
- **Client (Kopie 2):** `client/src/features/billing/components/invoice-list.tsx:145-152` — Cluster-Kopfzeilen-€ = Σ `grossAmountCents` je Handlungs-Cluster (Gruppierung via SSoT `assignInvoiceActionCluster`, Summe aber lokal).
- **Server (SSoT):** `shared/domain/billing-pipeline.ts:385-404` (`summarizePipelineCents`, €-Konservierung) hinter `GET /billing/pipeline` (`server/routes/billing.ts:254 ff.`).
- Teilzahlungen: der offene Rest ist `openAmountCents` aus `classifyPaymentDifference` (`server/routes/billing.ts:220-232`) — **beide Client-Summen ignorieren ihn und zählen volle Brutto-Beträge**; `teilweise_bezahlt`/`avis_erhalten` fehlen in Kopie 1 komplett.

**Divergenz-Szenario:** 1 Rechnung 500 € `teilweise_bezahlt` (offen 120 €), 1 Rechnung `versendet` 300 €: Cockpit-Kachel 300 €, Pipeline-Stufen ~420 € offen, Cluster-Kopf 800 €. Drei Zahlen für „wie viel € offen" auf benachbarten Admin-Screens.

**SSoT-Vorschlag:** Cockpit-Kachel und Cluster-€ aus dem Pipeline-Reader speisen (Server liefert Summen); `open-for-match` bleibt reine Matching-Liste ohne €-Aggregat im UI.

---

## 4. HIGH — EU-Rentner-Arbeitszeitgrenzen existieren NUR im Client, zweifach und inkonsistent

- **Client (Tagesregel ≥3h):** `client/src/features/time-tracking/components/day-detail-panel.tsx:113-134` — summiert Termin-Minuten (eigene Attribution, s. Finding 1) + Zeiteinträge, **Ganztages-Eintrag = pauschal 480 min**.
- **Client (Monatsregel 15h/Woche):** `client/src/features/time-tracking/components/time-overview-summary.tsx:139-149` — `maxMonthlyHours = 15 * (daysInMonth/7)`, Basis = dokumentiert + geplant + Leerfahrten.
- **Server/Shared:** keine Implementierung. `isEuRentner` wird nur durchgereicht (`server/storage/time-tracking/payroll-hours.ts:70,211,513`, `server/routes/admin/mitarbeiterabrechnung.ts:130`); `shared/domain/time-entries.ts:179` kennt nur `ARBZG_MAX_DAILY_MINUTES = 600` (andere Regel).

**Problem:** Eine Compliance-Regel (Sozialversicherungsrecht) lebt als zwei verschiedene Formeln in zwei UI-Komponenten; Buchung/Lohn/Monatsabschluss prüfen nichts. Die 480-min-Annahme widerspricht der Server-Soll-Logik `dailySollHours` (`payroll-hours.ts:113-119`: `monthlyWorkHours/21.7` bzw. 2,5h Minijob).

**SSoT-Vorschlag:** `shared/domain/eu-rentner-limits.ts` (Tages- + Monatsprüfung, eine Stundenbasis), vom Client konsumiert und serverseitig mindestens in der Mitarbeiterabrechnung als Warnung gespiegelt; Equality-Test Client-Warnung ↔ Payroll-Stunden.

---

## 5. HIGH — Termin-Status-Labels: SSoT + 2 abweichende Client-Kopien

- **SSoT:** `shared/domain/appointments.ts:68-75` `STATUS_LABELS` — u.a. `cancelled: "Storniert"`, `customer_no_show: "Kunde nicht angetroffen"`. Wird im Client bereits benutzt (`client/src/pages/admin/prospects.tsx:73,222`).
- **Kopie 1:** `client/src/components/patterns/status-badge.tsx:40-54` `statusLabels` — `cancelled: "Abgesagt"` (≠ „Storniert"), **`customer_no_show` fehlt** → `statusLabels[v] || v` (Z. 200) rendert auf `client/src/pages/appointment-detail.tsx:251` den rohen Enum-Wert `customer_no_show` als Badge-Text.
- **Kopie 2 (stale Vokabular):** `client/src/features/team/components/employee-time-card.tsx:10-18` `APPOINTMENT_STATUS_LABELS` mit Schlüsseln `planned/confirmed/in_progress/documented/invoiced` — **fünf davon existieren im Statusmodell gar nicht** (`shared/domain/appointments.ts:14,30-36`); reale Status `scheduled`/`documenting`/`customer_no_show` fallen auf den grauen Default mit Roh-Label (Z. 186).

**SSoT-Vorschlag:** beide Maps löschen, `STATUS_LABELS` (+ ggf. Farb-Map daneben in `design-system/tokens.ts`, die es für Status-Farben schon gibt) importieren. ast-grep-Guard: kein Objekt-Literal mit Schlüssel `scheduled|documenting|completed` außerhalb `shared/domain/appointments.ts`.

---

## 6. MEDIUM — Monats-„Gesamt"/„Dokumentiert" wird clientseitig aus offener Bucket-Menge summiert

- **Client:** `client/src/features/time-tracking/components/time-overview-summary.tsx:115-137,166` — `completedTotal`, `documentedTotalWithLeer`, `totalServiceMinutes`, `totalKm` als Handsummen über die Server-Buckets. Der Kommentar Z. 133-135 dokumentiert den bereits passierten Vorfall: Leerfahrten-Bucket kam serverseitig dazu, Client-Summe stimmte nicht mehr, wurde manuell nachgezogen.
- **Server:** `server/storage/time-tracking/overview.ts:82-263` liefert nur Buckets (kein Gesamt für die Employee-Sicht); die Admin-Sicht hat `totalWorkMinutes` (Z. 348). Equality-Test `admin-vs-employee-hours` vergleicht **nur Server-Pfade** (`tests/equality/admin-vs-employee-hours.test.ts` importiert `server/storage/time-tracking/overview`), nie die Client-Summe.

**Divergenz-Szenario:** nächster neuer Bucket (z.B. Bereitschafts-Minuten) → Server-Spalten summieren ihn, Client-„Gesamt" nicht (oder umgekehrt). Genau die schon einmal passierte Drift.

**SSoT-Vorschlag:** Server liefert `totals` im Overview-DTO (eine Aggregation neben den Buckets); Client rendert nur. Guard: DTO-Shape-Test wie `budget-overview-dto-shape`.

---

## 7. MEDIUM — Qonto-Zuordnung: Client prüft „Betrag passt?" exakt, SSoT toleriert 100 Cent + Skonto

- **Client:** `client/src/features/qonto/components/transactions-tab.tsx:189-204` — `selectedSum !== txAmount` (Σ `grossAmountCents`, exakter Vergleich) entscheidet über den Mismatch-Bestätigungsdialog; zweite Summe gleicher Art Z. 820-830.
- **SSoT:** `shared/domain/qonto/payment-difference.ts:27,58-87` — `classifyPaymentDifference` mit `PAYMENT_DIFFERENCE_TOLERANCE_CENTS = 100` und Skonto; laut Header von **allen** Server-Lese-/Schreibpfaden genutzt (`server/routes/admin/qonto.ts` /match, /bulk-match, confirm-paid).

**Divergenz-Szenario:** Differenz 40 Cent: Server bucht „tolerated" als Vollzahlung, UI zeigt vorher den Warn-Dialog „Summe weicht ab" → Operator-Führung widerspricht der Buchung. Wird die Toleranz per Settings angehoben (im SSoT-Kommentar angekündigt!), driftet der Dialog.

**SSoT-Vorschlag:** Dialog-Entscheidung über `classifyPaymentDifference`/`isPaymentFullyCovered` treffen (shared, im Client importierbar).

---

## 8. MEDIUM — `isEntryLocked` doppelt implementiert (Client-Gating vs. Server-Enforcement)

- **Client:** `client/src/features/time-tracking/constants.ts:42-49` — `lockedTypes = ["urlaub","krankheit"]`, Datum < heute.
- **Server:** `server/routes/time-entries.ts:216-218` — identische Regel, zweite Kopie; Enforcement Z. 432-433, 562-563 (`&& !isAdmin`).

Kein Shared-Modul. Ändert der Server die Liste (z.B. `feiertag` dazu) oder die Grenze (heute inklusiv?), zeigt der Client Edit-Buttons, deren Request dann 4xx wirft — oder sperrt Einträge, die der Server erlauben würde.

**SSoT-Vorschlag:** nach `shared/domain/time-entries.ts` heben (dort leben schon `FULL_DAY_ENTRY_TYPES` etc.), beide Seiten importieren.

---

## 9. MEDIUM — `formatKm` in Billing re-implementiert die per Task #616 ersetzte 1-NK-Variante

- **SSoT:** `shared/utils/format.ts:34-43` — `formatKm` = `quantizeKm` (kaufm. 2 NK, `shared/domain/invoice-line-items.ts:26-30`) + `toFixed(2)`; Kommentar: 1 NK erzeugte früher „Anzeige ≠ Buchung" („70,0 km" statt „7,30 km").
- **Schatten-Kopie:** `client/src/features/billing/utils.ts:23-27` — eigenes `formatKm` mit `maximumFractionDigits: 1`, ohne Quantisierung; genutzt in `client/src/features/billing/components/economics-overview-card.tsx:33,204` — dort stehen km-Mengen, die mit Rechnungs-Line-Items (`formatKmQuantityDisplay`, 2 NK) übereinstimmen müssen.

**Divergenz-Szenario:** 7,35 km → Rechnung/Ledger „7,35", Economics-Karte „7,4". Die historisch bereits gefixte Drift-Klasse wurde unter gleichem Funktionsnamen wieder eingeführt (die „Ersetzungs-Regel" wurde hier durch Namens-Shadowing unterlaufen).

**SSoT-Vorschlag:** lokale Funktion löschen, `formatKm` aus `@shared/utils/format` importieren. ESLint-/ast-grep-Guard: kein `function formatKm` außerhalb shared.

---

## 10. MEDIUM — Termin-Endzeit/„Gesamtdauer" wird an ≥5 Stellen unabhängig berechnet

Shared-SSoT existiert: `shared/domain/appointments.ts:204-216` (`getEndTime`) und `addMinutesToTime` — wird an diesen Stellen NICHT benutzt:
- `client/src/features/time-tracking/components/day-detail-panel.tsx:80-93` — eigene `getAppointmentEndTime` (andere Prioritätskette: actualEnd → scheduledEnd → Start+Σ Services, eigenes %24h-Handling).
- `client/src/features/appointments/hooks/use-edit-appointment-form.ts:362-367` — `minutesToTimeDisplay((startMinutes + totalMinutes) % 1440)`; **dieselbe Datei** rechnet Z. 474-478 und 566-567 erneut, dort mit `addMinutesToTime`.
- `client/src/features/appointments/hooks/use-new-appointment-form.ts:381-385, 433, 493` — dritte Kopie.
- `client/src/pages/document-appointment.tsx:69` — summiert `totalServiceMinutes` erneut, obwohl der Hook (`use-documentation-form.ts:199-204`) dieselbe Summe schon für `calculatedEnd` bildet.
- **Server (Buchung):** `server/services/appointments.ts:543-545` — `actualEnd = actualStart + Σ(actualDurationMinutes || 0)`.

**Risiko:** Die Vorschau-Endzeit im Formular (Modulo-Variante) und die gebuchte `scheduledEnd`/`actualEnd` (addMinutes-Variante) können bei Mitternachts-Überlauf/Regeländerung abweichen; Task #595-Kommentar (`use-edit-appointment-form.ts:448`) belegt, dass genau hier schon einmal gedriftet wurde.

**SSoT-Vorschlag:** eine shared Funktion `endTimeFromServices(start, services)`; Formular-Hooks + Server-Service importieren sie.

---

## 11. MEDIUM — Prospect-Funnel: zwei widersprüchliche Stage-Gruppierungen, keine Shared-Definition

- **Server:** liefert nur Roh-Counts je Status (`server/storage/prospects.ts:181-190`).
- **Client (Kopie 1):** `client/src/features/prospects/components/pipeline-funnel.tsx:19-22` — „Interessenten" = Σ **aller** Status, inkl. `gewonnen` (bereits aktiver Kunde → Doppelzählung gegen die „Aktiv"-Kachel) und `nicht_interessiert`.
- **Client (Kopie 2):** `client/src/features/admin/components/admin-cockpit.tsx:222-225` — `openProspects = neu+kontaktiert+wiedervorlage+qualifiziert`, Erstberatung separat, `gewonnen` separat.

**Divergenz:** Cockpit und Prospects-Seite zeigen für „wie viele Interessenten haben wir?" verschiedene Zahlen. Die Gruppierung („offen" / „in Beratung" / „terminal") ist eine Fachfrage und gehört als Partition neben `PROSPECT_STATUSES` in `shared/schema/prospects.ts` (Muster: `FINAL_APPOINTMENT_STATUSES`-Komplement, `shared/domain/appointments.ts:53-57,168-170`).

---

## 12. MEDIUM — 750-Zeilen-Dokumente-Sektion als Copy-Paste-Zwilling (bereits divergierend)

- `client/src/features/team/components/employee-documents-section.tsx` (781 Zeilen)
- `client/src/features/customers/components/admin/customer-documents-section-admin.tsx` (747 Zeilen)

`diff -u` zeigt nur ~260 abweichende Zeilen bei 1528 Gesamtzeilen (~83 % identisch; überwiegend testid-Präfixe und Endpoint-Pfade). Bereits real divergiert: Signatur-`width/height`-Props nur in der Kunden-Variante; „Alle entfernen"-Button nur in der Mitarbeiter-Variante; Upload-/Batch-/History-Logik doppelt gepflegt (jeder Bugfix muss zweimal passieren — z.B. die `totalFiles`-Zählung Z. 539 vs. Z. 508).

**SSoT-Vorschlag:** eine generische `<DocumentsSection target="employee" | "customer">` mit Endpoint-/testid-Konfiguration.

---

## Weitere Beobachtungen (unterhalb der Top-12)

- **Parallel-Hooks auf denselben Endpoint:** `useEmployees` (`client/src/features/customers/hooks/use-employees.ts:19-28`, Key `["employees","list"]`, Typ `EmployeeListItem`) vs. `useAdminEmployees` (`client/src/features/appointments/hooks/use-active-employees.ts:45-54`, Key `["admin","employees"]`, Typ `UserWithRoles`) — beide GET `/admin/employees`, zwei Caches, Invalidierung trifft je nur einen.
- **4× Inline-Query auf `/budget/${customerId}/type-settings`** (`BudgetTypeSettings.tsx:153-155`, `BudgetLedgerSection.tsx:133-134,680-681`, `customer-detail-sections.tsx:161-162`) — gleicher Key (gut), aber zwei verschiedene Response-Typen (`BudgetTypeSetting` vs. `BudgetTypeSettingRow`) für dasselbe Payload; gehört in einen Feature-Hook.
- **SERVICE_CODE_LABELS** dreifach (`day-detail-panel.tsx:38-42`, `status-badge.tsx:56-60`, `termine-tab.tsx`) — kosmetisch, aber leicht per Shared-Map zu ersetzen.
- **Positivbeispiele** (Muster für die Remediation): `client/src/features/team/components/workload-metrics.ts` (dünner Adapter auf `computeTeamWorkload`), `client/src/features/billing/utils.ts:55-78` (delegiert Cluster/Aging an shared), `pages/undocumented-appointments.tsx` (nutzt `getDocumentationAgeBucket`), `generate-all-dialog.tsx` (nutzt `hasOpenAppointments` shared).

## Systematik-Empfehlung

1. **Neue Equality-Test-Klasse „Client-Aggregation == Server-Aggregation":** Die Harness kann Client-Reinfunktionen direkt importieren, wenn Berechnungen aus TSX-Komponenten in importierbare `*-view.ts`/`*-metrics.ts`-Module gezogen werden (Muster `team-workload-view.ts`). Kandidaten: Findings 1, 2, 3, 6.
2. **ast-grep-Guards** (in `tests/architecture/`): (a) kein `.reduce(` über Felder mit Suffix `Cents|Minutes|Kilometers` in `client/src/**/*.tsx` außerhalb freigelisteter View-Module; (b) keine Objekt-Literale mit Termin-Status-Schlüsseln außerhalb `shared/domain/appointments.ts`; (c) keine Funktionsnamen, die shared-Exporte shadowen (`formatKm`, `isEntryLocked`, …) — Liste aus `shared/**`-Exporten generieren.
3. **DTO-Regel „Reader liefert Summen":** Wo der Client heute Buckets summiert, liefert der Server das Aggregat mit (Finding 3, 6) — dann prüft der bestehende OpenAPI-Drift-Gate die Shape mit.
