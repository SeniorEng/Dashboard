# Katrin Vavrin (Kunde 96) — doppelte, zukunfts-datierte Budget-Phasen

- **Datum der Korrektur:** 16.07.2026
- **Task:** #1777
- **Skript (gelöscht nach Anwendung):** `server/scripts/cleanup-vavrin-96-budget-phases.ts`,
  eingeführt in `0d80cb9d` (16.07.2026)

## Problem

Ein einzelnes Speichern der Budget-Einstellungen erzeugte am 16.07.2026
doppelte, zukunfts-datierte Budget-Phasen auf §45b und §39/§42a.

Ursache: das Speichern sortierte zusätzlich die Töpfe um (§39/§42a →
Priorität 1, §45b → Priorität 2). Eine Prioritäts-Änderung zählt für **beide**
Töpfe als echte Änderung, also bekamen beide eine neue historisierte Version.
§39/§42a nutzte das getippte „Gültig ab" (17.07.), §45b hatte ein leeres
„Gültig ab" und fiel auf „neue Version ab morgen" zurück — ebenfalls der 17.07.

Die 16.07./17.07.-Zeilen waren damit Unfall-Einträge, keine echten
historischen Zustände.

## Maßnahme

Zielzustand hergestellt, **Beträge unverändert**, verfügbares Budget identisch:

- **§45b** (`entlastungsbetrag_45b`): genau **eine** offene Version — id 73,
  `enabled`, Priorität 2, `valid_from` = Epoch-Sentinel (undatiert),
  `valid_to = NULL`.
- **§39/§42a**: analog auf eine offene Version zurückgeführt.

## Nachweis

git-Historie (`0d80cb9d`) · DB-Audit-Log · dieses Protokoll.
