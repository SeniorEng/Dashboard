# Umfang von Trigger A des Deaktivierungs-Guards — Prod-Messung

- **Datum des Protokolls:** 16.09.2026
- **Ticket:** 6hWcjpm3Q4V95Xwp (Deaktivierungs-Guard), PR #140
- **Skript (gelöscht nach Anwendung):** `docs/check-trigger-a-umfang.sql`
- **Art:** ausschließlich lesend — `SET TRANSACTION READ ONLY` + `ROLLBACK`,
  zusätzlich `PGOPTIONS='-c default_transaction_read_only=on'` beim Aufruf
- **Anwendung:** von Alrik gegen Prod gefahren, 16.09.2026

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

## Ergebnis

| Messung | Wert |
|---|---|
| Aktive Kunden gesamt | 165 |
| Davon mit Trigger A | **8 (4,8 %)** |
| Davon Pflegekasse | 7 |
| Davon Selbstzahler | 1 (Kunde 229) |
| Inaktive Kunden mit Trigger A | **0** — kein Altbestand |

**Ampel grün**, weit unter der Stopp-Grenze. PR #140 wurde daraufhin gemergt
(`cf4df8972c2e4bf469a952b9924f74bd228e70b7`).

## Was die Aufschlüsselung nach Zahler geklärt hat

Weiche W2 lautete: Trigger A gilt für **alle** Kundenklassen, auch Selbstzahler
— die Kundenunterschrift ist nicht nur Kassen-Compliance, sondern auch
operatives Kunden-Review (der Kunde bestätigt die erhaltene Leistung,
unabhängig vom Zahlungsweg).

Block 3 war bewusst **kein Filter**, sondern nur der Ausweis, welcher Anteil der
Zahl erst durch diese Entscheidung mitzählt. Antwort: **genau einer** (Kunde
229). Die zuerst erwogene Gegenposition (Selbstzahler ausschließen) hätte also
einen Kunden verloren — die Entscheidung war richtig, die Größenordnung aber
klein. Der Wert der Messung liegt darin, dass diese Einordnung jetzt eine Zahl
hat statt eines Arguments.

## Nebenbefund — Block 4, und er war der eigentliche Fund

Block 4 war eine **Gegenprobe mit Erwartung 0**: Leistungsnachweise mit
`status = 'completed'`, aber `customer_signed_at IS NULL`. Nach dem
Schreibpfad kann das nicht entstehen — `signServiceRecord` setzt Status und
Zeitstempel in *einem* atomaren UPDATE.

Gemessen: **42 Nachweise bei 39 Kunden.**

Ursache anschließend im Code gefunden: der Altdaten-Import
(`server/services/appointment-import.ts`, ~Zeile 1451) legt den Nachweis als
`pending` an und setzt ihn direkt danach hart auf `completed` — ohne
Zeitstempel, ohne Signaturdaten, ohne Hash. Der Nachweis behauptet danach
„Kunde hat unterschrieben", ohne dass eine Unterschrift existiert.

Die naheliegende Vermutung (`markAppointmentSystemSigned` / Task #876) ist
**widerlegt**: diese Funktion schreibt ausschließlich
`appointments.signature_data`/`signature_hash` und fasst
`monthly_service_records` nicht an.

Diese 42 Zeilen fallen heute durch **beide** Maschen: Trigger A sieht sie nicht
(sie sind `completed`), und die Abrechnung hält sie für fertig. Verfolgt als
Ticket **6hWgf8W5hRq8W99G** (P3) — dort steht auch die Bestätigungs-Abfrage,
ob wirklich alle 42 aus dem Import stammen.

Das war der Zweck der Gegenprobe: gemessen statt geglaubt. Der Kommentar im
Skript sagte „laut Schreibpfad kann das nicht entstehen" — die Messung sagt
etwas anderes.

## Warum das Skript gelöscht ist

Einmal-Werkzeug nach der Regel in `CLAUDE.md`: Der vollständige Nachweis ist
git-Historie plus dieses Protokoll. Ein liegengebliebenes Skript suggeriert
einen wiederholbaren Vorgang, den es nicht gibt — die Zahl gilt für den
16.09.2026 und wandert mit dem Bestand.

Wer sie neu erheben will, holt das Skript aus der Historie
(`git show cf4df897 -- docs/check-trigger-a-umfang.sql`) oder schreibt die
Abfrage neu; die Definition von Trigger A steht als SSoT in
`server/services/customer-deactivation-guard.ts` und ist dort die verbindliche
Quelle, nicht eine SQL-Kopie.
