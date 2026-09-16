# Umfang von Trigger A des Deaktivierungs-Guards — Prod-Messung

- **Datum des Protokolls:** 16.09.2026
- **Ticket:** 6hWcjpm3Q4V95Xwp (Deaktivierungs-Guard), PR #140
- **Skript (gelöscht nach Anwendung):** `docs/check-trigger-a-umfang.sql`
- **Art:** ausschließlich lesend — `SET TRANSACTION READ ONLY` + `ROLLBACK`,
  zusätzlich `PGOPTIONS='-c default_transaction_read_only=on'` beim Aufruf
- **Anwendung:** von Alrik gegen Prod gefahren, 16.09.2026
- **Maßnahme / Vorher-Nachher / Audit-Referenz:** entfallen — der Lauf war rein
  lesend und hat nichts geändert. Es gibt daher keine Audit-Spur zu diesem
  Protokoll, und danach zu suchen wäre vergeblich.

## Warum gemessen wurde

Der Deaktivierungs-Guard hat genau **einen** harten Riegel: Trigger A
(Leistungsnachweis `pending`/`employee_signed` ohne Kundenunterschrift). B und C
sind nur Hinweise. Die Zahl entscheidet, ob der Riegel ein Sicherheitsnetz ist
oder eine Bremse — greift er bei jedem zweiten Kunden, blockiert er den
Normalbetrieb.

Die Vor-Messung des Tickets nannte 118 von 165 aktiven Kunden für *irgendeinen*
Trigger, mit B = 89 und C = 71 als Treibern. **Die A-Zahl fehlte** — und sie war
die einzige, die für einen harten Riegel zählt. Der Gate-2-Review hat das als
offenen Punkt festgehalten, dieses Skript hat ihn geschlossen.

Die Stopp-Grenze war vorab auf **20** festgelegt, nicht nachträglich.

## Die Prädikate — damit die Zahlen nachrechenbar bleiben

Ohne sie wäre dieses Protokoll eine Behauptung. Sie stehen hier inline und nicht
nur als git-Verweis, wie in den übrigen Protokollen dieses Ordners.

**Trigger A**, deckungsgleich mit `collectDeactivationBlockers` in
`server/services/customer-deactivation-guard.ts`:

```sql
r.deleted_at IS NULL
AND r.status IN ('pending', 'employee_signed')
AND r.customer_signed_at IS NULL
```

**Grundmenge** von Block 1–3: `customers WHERE deleted_at IS NULL AND status = 'aktiv'`.

**Block 4** (Gegenprobe) — beachte: **kein Kundenfilter**, weder `status` noch
`deleted_at` auf `customers`:

```sql
SELECT count(*), count(DISTINCT r.customer_id)
FROM monthly_service_records r
WHERE r.deleted_at IS NULL
  AND r.status = 'completed'
  AND r.customer_signed_at IS NULL;
```

**Block 5** (inaktive Kunden) — beachte: die Statusliste schließt `completed`
**aus**:

```sql
SELECT count(DISTINCT c.id)
FROM customers c
JOIN monthly_service_records r
  ON r.customer_id = c.id
 AND r.deleted_at IS NULL
 AND r.status IN ('pending', 'employee_signed')
 AND r.customer_signed_at IS NULL
WHERE c.deleted_at IS NULL
  AND c.status <> 'aktiv';
```

## Ergebnis

| Messung | Wert |
|---|---|
| Aktive Kunden gesamt | 165 |
| Davon mit Trigger A | **8 (4,8 %)** |
| Davon Pflegekasse | 7 |
| Davon im Rest-Bucket („Selbstzahler o. ä.") | 1 — Kunde 229 |
| Inaktive Kunden mit einem Nachweis `pending`/`employee_signed` ohne Kundenunterschrift | **0** |

**Ampel grün**, weit unter der Stopp-Grenze. PR #140 wurde daraufhin gemergt
(`cf4df8972c2e4bf469a952b9924f74bd228e70b7`).

Zur Zahler-Zeile: `customers.billing_type` ist freies `text`; Block 3 hatte zwei
Buckets, „Pflegekasse" (gesetzlich/privat) und alles andere als Rest. Bei n = 1
mit genannter ID ist das unkritisch, aber die Zeile sagt *nicht*, dass Kunde 229
`billing_type = 'selbstzahler'` trägt — nur, dass er nicht Pflegekasse ist. Die
ID stammt aus Block 2, die Klassen-Zuordnung aus Block 3.

### Was die Null in der letzten Zeile NICHT heißt

Sie heißt **nicht** „kein Altbestand". Block 5 kann die Klasse aus Block 4
(`status = 'completed'` ohne Zeitstempel) per Konstruktion nicht sehen, weil
seine Statusliste `completed` ausschließt. Und Block 4 lief **ohne
Kundenfilter** — wie viele der dort gefundenen 39 Kunden inaktiv sind, ist
**unbekannt**. Die 165 aus der ersten Zeile und die 39 aus dem Nebenbefund
stehen auf verschiedenen Grundmengen.

Die Null belegt genau eine Aussage: im *engen* Statusfenster von Trigger A liegt
bei inaktiven Kunden nichts.

**Offener Widerspruch dazu.** Der Docstring des Guards
(`server/services/customer-deactivation-guard.ts`) nennt als Anlass „Kunden 93
und 89, beide inaktiv, beide mit einem Leistungsnachweis, gegen den nie
unterschrieben wurde" — und Trigger A als „den Zustand der Bestandsfälle".
Wären beide Sätze und die Null wahr, hätte Block 5 mindestens 2 liefern müssen.
Drei Auflösungen sind denkbar, keine davon geprüft:

1. 93/89 tragen `inaktiv_ab`, aber `status = 'aktiv'` — dann stecken sie in den
   165 und womöglich in den 8. Das ist nicht unplausibel: Weiche W3 hat genau
   festgestellt, dass `inaktiv_ab` in dieser App „Vertrag läuft aus" bedeutet
   und *nicht* „deaktiviert".
2. Ihre Nachweise stehen auf `completed` und gehören zu den 42 aus Block 4.
3. Sie sind soft-gelöscht (`customers.deleted_at`).

Wer die Zahl weiterverwendet, muss das zuerst klären. Als Beleg für „bei
inaktiven Kunden liegt nichts Unsigniertes mehr" taugt sie nicht.

## Nebenbefund — Block 4, und er war der eigentliche Fund

Block 4 war eine **Gegenprobe mit Erwartung 0**. Gemessen: **42 Nachweise bei 39
Kunden** mit `status = 'completed'` und `customer_signed_at IS NULL`.

### Was gemessen ist und was gelesen

**Gemessen (Prod):** die 42 Zeilen bei 39 Kunden.

**Gelesen (Code, nicht gemessen):** ein Pfad, der diesen Zustand erzeugen
**kann** — `createServiceRecordsForImported` in
`server/services/appointment-import.ts`, erreichbar über den Import-Endpunkt in
`server/routes/admin/import-appointments.ts`. Er legt den Nachweis über
`createServiceRecord(...)` als `pending` an und setzt ihn direkt danach per
`update(monthlyServiceRecords).set({ status: "completed" })` — ohne
`customerSignedAt`, ohne Signaturdaten, ohne Hash. Der Nachweis behauptet
danach „Kunde hat unterschrieben".

**Offen:** dass **diese** 42 Zeilen von dort kommen. Der Pfad greift nur bei
Terminen mit `notes LIKE 'Import aus Altdaten%'`; die Zuordnung ist ungeprüft.
Die Bestätigungs-Abfrage liegt im Ticket.

### Was ausgeschlossen ist

Die naheliegende Vermutung (`markAppointmentSystemSigned` / Task #876) ist
**widerlegt** — und zwar nicht nur auf Funktionsebene: die Funktion
(`server/storage/appointments-storage.ts`) schreibt `signature_data`,
`signature_hash`, `signed_at` und `signed_by_user_id`, alle auf `appointments`;
und ihr einziger Aufrufer (`server/routes/admin/customers/budgets.ts`) schreibt
in seiner Schleife nur `budget_transactions`, `appointments` und `audit_log`.
Weder die Funktion noch ihre Route fassen `monthly_service_records` an.

Auch `signServiceRecord` (`server/storage/service-records-storage.ts`) kann den
Zustand nicht erzeugen: Status und `customerSignedAt` gehen dort in **einem**
atomaren UPDATE raus.

### Keine strukturelle Zusage

Eine Suche über alle Schreibstellen auf `monthly_service_records` (inkl.
`server/startup/**` und `server/scripts/**`) fand **zwei** Pfade, die
`status = 'completed'` setzen: `signServiceRecord` und die Import-Stelle. Alle
anderen setzen `deleted_at`/`updated_at`.

Das ist aber keine Invariante, sondern ein Befund über die heutigen Aufrufer.
`updateServiceRecord(id, data)` in `server/storage/service-records-storage.ts`
ist ein vollkommen generischer Setter auf `IStorage` — er *kann*
`status: 'completed'` ohne Zeitstempel schreiben; dass es nicht passiert, liegt
allein am einzigen heutigen Aufrufer. Eine DB-Bedingung
`completed ⇒ customer_signed_at IS NOT NULL` existiert **nicht**, und es gibt
keinen Wächter-Test darauf.

### Tragweite — nicht Tech-Debt

Die 42 Zeilen fallen durch **beide** Maschen, und die zweite ist die teure:

- **Trigger A sieht sie nicht** — sie sind `completed`, seine Statusliste
  schließt das aus.
- **Die Abrechnung hält sie für fertig.** `isServiceRecordSignedForBilling`
  (`shared/domain/billing-eligibility.ts`) liest **nur den Status**, nie
  `customer_signed_at`. Für Pflegekasse ist `completed` das strenge Gate —
  gerade weil die Kundenunterschrift der Kassen-Nachweis ist. Diese Zeilen
  passieren es.
- **Der gerenderte Nachweis widerspricht dem.** Ohne Signaturdaten fällt der
  LN-Renderer (`server/lib/pdf-generator.ts`) in den „noch nicht
  unterschrieben"-Zweig. Der Leistungsnachweis ist Anlage zur Rechnung.

Der auslösende Fall ist damit: Pflegekassen-Kunde, Nachweis ohne Signatur →
Rechnung wird als abrechenbar geführt, die beigelegte LN-Seite weist keine
Kundenunterschrift aus. Das ist ein Kassen-/GoBD-Nachweisthema an **bestehenden
Belegen**.

Der Defekt ist **nicht neu und nicht von dieser Messung verursacht** — sie hat
ihn nur sichtbar gemacht. Verfolgt als Ticket **6hWgf8W5hRq8W99G**. Die dort
zunächst gesetzte Priorität P3 stammt aus der Einschätzung *vor* diesem
Abrechnungs-Durchgriff; sie gehört mit diesem Befund **neu entschieden** und
wird hier ausdrücklich nicht als abgeschlossen protokolliert.

Das war der Zweck der Gegenprobe: gemessen statt geglaubt. Der Kommentar im
Skript sagte „laut Schreibpfad kann das nicht entstehen" — die Messung sagt
etwas anderes.

## Warum das Skript gelöscht ist

Einmal-Werkzeug nach der Regel in `CLAUDE.md`: Der vollständige Nachweis ist
git-Historie plus dieses Protokoll. Ein liegengebliebenes Skript suggeriert
einen wiederholbaren Vorgang, den es nicht gibt — die Zahl gilt für den
16.09.2026 und wandert mit dem Bestand.

Die Prädikate stehen oben inline, die Messung ist also ohne git-Archäologie
nachvollziehbar. Wer das ganze Skript braucht:

```
git show cf4df897:docs/check-trigger-a-umfang.sql
```

Die verbindliche Definition von Trigger A ist und bleibt
`collectDeactivationBlockers` in
`server/services/customer-deactivation-guard.ts` — nicht eine SQL-Kopie.
