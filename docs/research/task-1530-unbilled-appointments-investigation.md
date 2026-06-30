# Read-only Production Investigation — appointment-precise "noch abzurechnen"

**Erstellt:** 2026-06-30 (vor jeder Code-Änderung)
**Quelle:** Read-only Replica (PROD_DATABASE_URL, SET default_transaction_read_only = on)
**Datenschutz:** Diese Datei enthält KEINE Klarnamen oder Roh-IDs aus Produktion. Kunden sind pseudonymisiert (stabiler Hash). Termin-/LN-/Rechnungs-IDs sind weggelassen.

## Frage

Welche Termine versteckt der alte period-grobe "noch abzurechnen"-Filter? D.h. Termine, die
- abgeschlossen sind (Termin aktiv, nicht gelöscht),
- auf einem kundenunterschriebenen (status=completed) Leistungsnachweis liegen,
- auf KEINER aktiven Rechnung (nicht storniert, keine Stornorechnung) als Line-Item stehen,
- aber maskiert sind, weil für denselben Kunden+Monat bereits eine andere aktive Rechnung existiert.

## Ergebnis (aggregiert)

- **Versteckte Termine:** 30
- **Betroffene Kunde+Zeitraum-Kombinationen:** 25
- **Betroffene Kunden:** 25
- **Zeiträume:** 2026-06

## Verteilung (pseudonymisiert, nur Zählwerte)

| Kunde (Pseudonym) | Zeitraum | Versteckte Termine |
|---|---|---|
| K-0b6a0c35 | 2026-06 | 2 |
| K-0de46299 | 2026-06 | 1 |
| K-167269a8 | 2026-06 | 2 |
| K-20736e6f | 2026-06 | 1 |
| K-3333ca54 | 2026-06 | 1 |
| K-3a580fdb | 2026-06 | 1 |
| K-4a77e39f | 2026-06 | 1 |
| K-5db35131 | 2026-06 | 1 |
| K-62cc2ae3 | 2026-06 | 1 |
| K-6da20b0c | 2026-06 | 1 |
| K-6ee69185 | 2026-06 | 1 |
| K-73540dbb | 2026-06 | 1 |
| K-752beeb9 | 2026-06 | 1 |
| K-898aa202 | 2026-06 | 1 |
| K-9175f396 | 2026-06 | 2 |
| K-96c9ead5 | 2026-06 | 1 |
| K-a1c27410 | 2026-06 | 2 |
| K-a4f95809 | 2026-06 | 1 |
| K-a7e62258 | 2026-06 | 1 |
| K-b8ddaa2e | 2026-06 | 1 |
| K-c195a659 | 2026-06 | 1 |
| K-c50222f9 | 2026-06 | 1 |
| K-f4bdcdf4 | 2026-06 | 2 |
| K-f540cd54 | 2026-06 | 1 |
| K-f7022953 | 2026-06 | 1 |

## Interpretation

Alle 30 Termine wären heute in der Prozess-Gesundheits-Liste "Leistungsnachweise ohne Rechnung" UNSICHTBAR, weil je Kunde+Monat bereits eine (Geschwister-)Rechnung existiert. Die Abrechnungs-Engine würde sie bei manueller Auslösung sehr wohl nachberechnen (sie ist termin-genau) — aber nichts fordert das Büro dazu auf. Nach der termin-genauen Korrektur tauchen genau diese Fälle wieder auf.

Kein Schreibvorgang erfolgte durch diese Untersuchung. Die konkrete Bereinigung (mit Klarnamen-Zuordnung über einen Live-Query) ist Sache des Cleanup-Follow-ups; Roh-PII wird bewusst NICHT in git abgelegt.
