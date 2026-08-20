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

| | Vorher | Nachher |
|---|---|---|
| Termine #177, #710 | `scheduled` (vom Re-Import als „Duplikat → skip" behandelt) | `completed` |
| Termine #303, #304 (18.03.2026) | `signed_at` leer trotz unterschriebenem Leistungsnachweis | `signed_at` nachgetragen |
| §45b-Verbrauch 2026, Kunde 39 | um die vier Termine zu niedrig | **475,55 €** (`TARGET_45B_CENTS_2026 = 47555`, vom Skript verifiziert) |

Termin #1387 (27.05.2026) blieb bewusst unangetastet.

## Audit-Referenz

git-Historie (`19a43a2f`) · DB-Audit-Log zum 28.05.2026 auf `appointments`
für Kunde 39 · dieses Protokoll.
