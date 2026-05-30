---
name: §45b onboarding baseline (Vorjahr = aufgebraucht)
description: Why the whole §45b runtime path floors a derived anchor to the current year, and which helper is now script-only.
---

# §45b Onboarding-Baseline

Beim Kunden-Onboarding gilt das **Vorjahr** des §45b-Entlastungsbetrags als
**vollständig aufgebraucht** (Default-Übertrag 0 €). Das laufende Jahr stockt ab
dem Anker (frühestens 1.1. des laufenden Jahres) voll auf. Es gibt KEINEN
automatisch materialisierten Vorjahres-Übertrag mehr.

**Rule:** Der GESAMTE §45b-Runtime-Pfad bodet einen abgeleiteten Anker
(`budget_start_date_origin = 'derived_pflegegrad'`) auf den 1.1. des laufenden
Jahres mit `floorAutoAnchor45bToCurrentYear` — gilt für Lesepfad
(`calculateAllocated45b`), Carryover-Anlage (`ensureYearlyCarryover45b`) UND den
`/initial-budget`-§45b-Write. `'manual'`/NULL-Anker werden NIE gebodet (manuell
gewinnt). `clampDerived45bAnchor`/`earliest45bRelevantAnchor` (rechtliches
Vorjahres-Fenster bis 30.06.) sind seit dieser Umstellung NICHT mehr im
Runtime-Pfad — nur noch das einmalige Korrektur-Skript
`server/scripts/fix-customer-45b-anchor.ts` nutzt sie. Helfer + Unit-Tests
bleiben für gezielte Daten-Korrekturen erhalten.

**Why:** Ein automatischer Vorjahres-Übertrag (bis 12 × 131 €) hat beim
Onboarding keine fachliche Grundlage und führte zu Geister-Carryovers (nach dem
Löschen einer Carryover-Zeile tauchte sofort wieder ein voller Vorjahres-Übertrag
auf). Operator trägt ein echtes Restguthaben manuell ein (Wizard-Feld „Übertrag
(€)", Default 0; validFrom 1.1. / expiresAt 30.06., verfällt mit Write-off).

**How to apply:** Jede neue §45b-Anker-Berechnung MUSS denselben Floor verwenden
(alle drei Stellen synchron halten, sonst driften Anzeige-Summe und
Carryover-Zeilen). FORWARD-ONLY: keine Datenmigration — Bestands-Allocations
werden nicht umgeschrieben. Read-only-Sicherheitsnetz für die Umstellung:
`server/scripts/verify-45b-anchor-change.ts` (listet derived-Anker, deren
berechnete §45b-Verfügbarkeit alt vs. neu driftet).

Das frühere `vorjahrVerbraucht45b`-Wizard-Feld (Modell „max − verbraucht") wurde
 entfernt; nur noch das freie `uebertrag45b`-Feld bleibt.
