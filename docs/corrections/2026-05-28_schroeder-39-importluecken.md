# Rosemarie Schröder (Kunde 39) — Import-Lücken bei Terminen und Signaturen

- **Datum der Korrektur:** 28.05.2026
- **Task:** #708
- **Skript (gelöscht nach Anwendung):** `server/scripts/correct-schroeder-39.ts`,
  eingeführt in `19a43a2f` (28.05.2026)

## Problem

Aus dem Excel-Import blieben bei Kundin 39 zwei Termine (#177, #710) auf
`scheduled` stehen. Der Re-Import behandelte sie als „Duplikat → skip", statt
sie auf `completed` anzuheben. Zwei weitere Termine (#303, #304 vom 18.03.2026)
hatten kein `signed_at`, obwohl der Leistungsnachweis unterschrieben vorlag.

Beide Lücken wirkten in dieselbe Richtung: die Termine fielen aus dem
§45b-Verbrauch heraus und erschienen fälschlich als nicht verbraucht.

## Maßnahme

Idempotenter Einmal-Lauf: die zwei hängengebliebenen Termine auf `completed`,
die zwei fehlenden `signed_at` nachgetragen. Termin #1387 (27.05.2026) wurde
**bewusst nicht** angefasst.

## Vorher / Nachher

Zielzustand laut Skript-Verifikation: §45b-Verbrauch 2026 für Kunde 39 =
**475,55 €**.

## Nachweis

git-Historie (`19a43a2f`) · DB-Audit-Log · dieses Protokoll.
