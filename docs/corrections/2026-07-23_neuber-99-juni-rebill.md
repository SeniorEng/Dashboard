# Ursula Neuber (Kunde 99) — Juni 2026 nach doppeltem Storno neu abrechnen

- **Datum der Korrektur:** 23.07.2026
- **Task:** #1855
- **Skript (gelöscht nach Anwendung):** `server/scripts/fix-ursula-99-june-rebill.ts`,
  eingeführt in `5b5f82bd` (23.07.2026)

## Problem

Kundin 99 (gesetzliche Pflegekasse, PG 2) hatte für Juni 2026 vier
dokumentierte und signierte Termine (1503, 1591, 1674, 1820). Der Juni war
**zweimal** berechnet und **zweimal** storniert worden:

| Rechnung | Status | Storno |
|---|---|---|
| `RE-2026-0263` | storniert | `RE-2026-0332` (Entwurf) |
| `RE-2026-0401` | storniert | `RE-2026-0414` (Entwurf) |

Dadurch stand die §45b-Konsumption des Juni netto per Reversal auf **null**
(Netto-Null-Fall). Die vier Termine erschienen wieder als „abrechenbar",
obwohl die Leistung erbracht und dokumentiert war.

## Maßnahme

Prod-Remediation nach read-only-Prüfung (Checks A–G): den Juni sauber neu
abrechnen, ohne die stornierten Belege anzutasten. GoBD-Linie eingehalten —
Storno + Neuausstellung, kein stilles Editieren eines gestellten Betrags.

## Nachweis

git-Historie (`5b5f82bd`) · DB-Audit-Log · dieses Protokoll ·
`.agents/memory/45b-carryover-soft-delete-remediation.md`.

Die Ausnahme in `shared/ssot-registry.ts` (das Skript enthielt ein Monatsende,
das zufällig der 30.06. war und keine §45b-Frist meinte) ist mit dem Skript
entfallen.
