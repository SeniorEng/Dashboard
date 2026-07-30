# Nagler (Kunde 50) — Mai 2026 an IKK classic statt AOK PLUS

- **Datum der Korrektur:** 30.07.2026
- **Task:** #1894 (Folgekorrektur zu #1893, zeitraumgenauer Kostenträger)
- **Skript (gelöscht nach Anwendung):** `server/scripts/fix-nagler-50-mai-kostentraeger.ts`,
  eingeführt in `a74ed3b3`, gemerged über PR #16 (`b3f0cbf5`)

## Problem

Vor #1893 adressierten alle Abrechnungs-Lesepfade den **heute** gültigen
Kostenträger statt den im abgerechneten Zeitraum gültigen (`todayISO()`-vs-`asOf`).

Folge bei Kunde 50 (Nagler):

- `RE-2026-0186` (Rechnung-ID 188, Mai 2026, Status `versendet`, §45b,
  **123,49 € brutto**) ging an **AOK PLUS** (IK 107299005), obwohl im Mai 2026
  **IKK classic** (IK 187202793) Kostenträger war.

Zusätzlich war die Kassenhistorie selbst fehlerhaft: der Kassenwechsel stand auf
dem **08.06.2026** statt auf einem Monatsersten, und beide Zeilen überlappten
sich an genau diesem Randtag (IKK bis 08.06., AOK ab 08.06. — am 08.06. galten
zwei Kassen gleichzeitig, `.limit(1)` entschied zufällig).

Die Historie war dadurch auch über die UI nicht mehr reparierbar: der
#1893-Schreibpfad (`updateCustomerInsurance`) validiert nach **jeder**
Einzeländerung die komplette Fenster-Menge, und es gibt keine zulässige
Einzelschritt-Reihenfolge (IKK zuerst schließen → AOK beginnt weiter am 08.06.,
kein Monatserster; AOK zuerst ziehen → IKK endet weiter am 08.06., Überlappung).

## Maßnahme

1. **Kassenfenster (Skript, Phase A `fenster`)** — beide Zeilen in **einer**
   Transaktion umgesetzt, die resultierende Menge einmal gegen dieselbe SSoT
   `validateInsuranceWindows` (`shared/domain/insurance-period`) validiert:
   - Zeile #14 IKK classic: `2026-02-01 – 2026-06-08` → **`2026-02-01 – 2026-05-31`**
   - Zeile #148 AOK Plus: `ab 2026-06-08` → **`ab 2026-06-01`, offenes Ende**
   - Gegenprobe im Skript: Stichtag Mai löst auf IKK classic auf, Stichtag Juni
     auf AOK Plus.
2. **Storno + Neuausstellung — über die UI ausgeführt**, nicht über die
   Skript-Phasen B/C: `RE-2026-0186` storniert (Stornorechnung mit eigener
   Nummer, negierte Positionen, Budget-Rückbuchung) und Mai 2026 über den
   regulären Generator neu ausgestellt. Da #1893 zeitraumgenau auflöst und
   Phase A vorher lief, adressiert die neue Rechnung IKK classic.

**GoBD:** Die versendete Rechnung wurde nicht umgeschrieben — Storno +
Neuausstellung mit neuer Nummer, das Original bleibt als `storniert` erhalten
und die Stornorechnung referenziert es über `stornierte_rechnung_id`. Kein
direkter DB-Eingriff an Rechnungen.

## Vorher / Nachher

| Gegenstand | Vorher | Nachher |
|---|---|---|
| Kassenzeile #14 (IKK classic) | 01.02.2026 – 08.06.2026 | 01.02.2026 – 31.05.2026 |
| Kassenzeile #148 (AOK Plus) | ab 08.06.2026 | ab 01.06.2026 (offen) |
| Randtag 08.06.2026 | zwei Kassen gleichzeitig gültig | eindeutig AOK Plus |
| Stichtag Mai 2026 (31.05.) | zufällig auflösend | IKK classic (IK 187202793) |
| Mai-Rechnung | `RE-2026-0186`, 123,49 € brutto, `versendet`, Empfänger AOK PLUS | `RE-2026-0186` `storniert` (+ Stornorechnung); Mai 2026 neu ausgestellt an IKK classic, betragsgleich |

## Audit-Referenz

- Ausführung: `--apply --phase=fenster` unter `NODE_ENV=production`
- Audit-Attribution: **User 1**, Reason **„Nagler 1894 Kassenfenster"**
- Storno + Neuausstellung: reguläre UI-Pfade, damit im normalen
  Rechnungs-/Storno-Audit des Kunden 50 sichtbar.

## Bestandsscan (Phase D, read-only, prod)

Der Scan prüfte alle Kunden mit mehr als einer Kassenzuordnung auf dieselbe
Fehlerklasse:

- **[D1] Gestempelter vs. zeitraumgültiger Kostenträger:** **0 echte
  Kassenwechsel-Abweichungen.** Verbleibende Treffer waren ausschließlich
  Stammsatz-Duplikate (gleiche Kasse, abweichende Schreibweise / doppelter
  Stammsatz) — fachlich kein Fehlversand, ausdrücklich **nicht** zu stornieren.
- **[D2] Kassenhistorien mit echten Lücken (kostenträgerfreie Tage):** **0.**
  Der Long-List-Punkt „Stichtags-Resolver liefert in einer Lücke keinen
  Kostenträger" ist damit für den Prod-Bestand beantwortet.

Der Fall Nagler war also ein Einzelfall, kein Bestandsproblem — deshalb wurde
das Skript nach der Anwendung gelöscht statt zu einem Feature ausgebaut.
