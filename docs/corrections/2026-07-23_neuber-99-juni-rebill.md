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

Prod-Remediation nach read-only-Prüfung (Checks A–G). Drei Eingriffe, alle
auditiert:

1. **§45b-Carryover-Allokationen soft-gelöscht** (`deleted_at`) — der
   fachliche Kern. Erst das löst die Netto-Null auf und macht den Juni wieder
   abrechenbar. Audit-Action `budget_carryover_cleanup_soft_deleted`.
2. **Zwei hängende Stornorechnungs-Entwürfe** von `entwurf` auf `versendet`
   gesetzt (Audit-Action `invoice_sent`). Ein Storno-Entwurf, der nie
   ausgeht, hält die stornierte Forderung in der Schwebe.
3. **Monats-Rebooking** des Juni (Audit-Action `budget_rebook_month`).

GoBD-Linie eingehalten: Storno + Neuausstellung, kein stilles Editieren eines
gestellten Betrags, keine rückwirkende Erhöhung.

> Eine frühere Fassung dieses Protokolls behauptete, die Korrektur sei
> erfolgt, „ohne die stornierten Belege anzutasten". Das war falsch — Punkt 2
> tastet sie an, und Punkt 1 fehlte ganz.

## Vorher / Nachher

**Vorher:** §45b-Konsumption Juni 2026 netto per Reversal = **0 €**, vier
dokumentierte und signierte Termine (1503, 1591, 1674, 1820) erschienen wieder
als „abrechenbar"; zwei Stornorechnungen (`RE-2026-0332`, `RE-2026-0414`)
hingen als Entwurf.

**Nachher:** Juni neu abgerechnet, die beiden Storno-Entwürfe versendet, die
Carryover-Allokationen des Netto-Null-Falls soft-gelöscht.

## Audit-Referenz

Drei suchbare Audit-Actions, alle mit `task: "#1855"`:
`budget_carryover_cleanup_soft_deleted` · `invoice_sent` · `budget_rebook_month`.

## Nachweis

git-Historie (`5b5f82bd`) · DB-Audit-Log (Actions oben) · dieses Protokoll ·
`.agents/memory/45b-carryover-soft-delete-remediation.md` (verweist noch auf
das gelöschte Skript — der Zeiger ist mit dieser Ablage tot, der Inhalt lebt
hier).

Die Ausnahme in `shared/ssot-registry.ts` (das Skript enthielt ein Monatsende,
das zufällig der 30.06. war und keine §45b-Frist meinte) ist mit dem Skript
entfallen.
