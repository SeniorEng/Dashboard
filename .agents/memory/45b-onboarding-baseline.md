---
name: §45b onboarding baseline (Vorjahr = aufgebraucht)
description: Why the whole §45b runtime path floors the runtime-derived anchor to the current year, and which helper is now unit-test-only.
---

# §45b Onboarding-Baseline

Beim Kunden-Onboarding gilt das **Vorjahr** des §45b-Entlastungsbetrags als
**vollständig aufgebraucht** (Default-Übertrag 0 €). Das laufende Jahr stockt ab
dem Anker (frühestens 1.1. des laufenden Jahres) voll auf. Es gibt KEINEN
automatisch materialisierten Vorjahres-Übertrag mehr.

**Rule:** Der GESAMTE §45b-Runtime-Pfad bodet den zur Laufzeit aus der
Pflegegrad-Historie abgeleiteten Anker (`earliestCareLevelStart`) auf den 1.1.
des laufenden Jahres mit `floorAutoAnchor45bToCurrentYear` — gilt für Lesepfad
(`calculateAllocated45b`), Carryover-Anlage (`ensureYearlyCarryover45b`) UND den
`/initial-budget`-§45b-Write. Es gibt keinen persistierten Anker und keine
`'manual'`-Sonderbehandlung mehr (Task #1204 — siehe 45b-anchor-origin-stamp.md).
`clampDerived45bAnchor`/`earliest45bRelevantAnchor` (rechtliches Vorjahres-Fenster
bis 30.06.) sind NICHT mehr im Runtime-Pfad — sie bleiben nur als unit-getestete
Helfer (`tests/unit/budget-45b-anchor.test.ts`) erhalten.

**Why:** Ein automatischer Vorjahres-Übertrag (bis 12 × 131 €) hat beim
Onboarding keine fachliche Grundlage und führte zu Geister-Carryovers (nach dem
Löschen einer Carryover-Zeile tauchte sofort wieder ein voller Vorjahres-Übertrag
auf). Operator trägt ein echtes Restguthaben manuell ein (Wizard-Feld „Übertrag
(€)", Default 0; validFrom 1.1. / expiresAt 30.06., verfällt mit Write-off).

**How to apply:** Jede neue §45b-Anker-Berechnung MUSS denselben Floor verwenden
(alle drei Stellen synchron halten, sonst driften Anzeige-Summe und
Carryover-Zeilen). FORWARD-ONLY: keine Datenmigration — Bestands-Allocations
werden nicht umgeschrieben.

Das frühere `vorjahrVerbraucht45b`-Wizard-Feld (Modell „max − verbraucht") wurde
entfernt; nur noch das freie `uebertrag45b`-Feld bleibt.
