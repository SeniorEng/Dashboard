# Verifikationsbericht — Phase 3.2: Settings-Versionierung (Befund C-03)

**Datum:** 15.06.2026
**Art:** Verifikation/Absicherung (KEINE Wertumstellung)
**Ergebnis:** ✅ **C-03 GRÜN** — keine Restlücke. Eine Regressions-Absicherung wurde ergänzt.

## Frage (C-03)
Lesen Rebook-/Verfügbarkeits-**Preview** und tatsächliche **Buchung** für denselben
Termin denselben **stichtagsbezogenen** Settings-Stand (`forDate`)? Und ist
`forEdit` (jüngster Intent-Stand) sauber auf Edit-/Anzeige-Intent abgegrenzt?

## Lese-API (SSoT)
`readBudgetTypeSettings(customerId, mode, tx?)` in
`server/storage/budget/preferences-storage.ts` ist die einzige Lese-SSoT für
`customer_budget_type_settings`. Modi:
- `{ kind: "forDate", asOfDate }` → die zum Stichtag gültige (historisierte) Phase.
- `{ kind: "forEdit" }` → die jüngste Intent-Zeile pro Topf (auch zukunftsdatiert).
- `{ kind: "withTransition" }` → jüngste Zeile + heute effektiver Stand (UI-Banner).

Die Legacy-Getter (`getActiveBudgetTypeSettings` / `getLatestBudgetTypeSettings` /
`…WithTransition`) sind nur noch `@deprecated`-Wrapper auf diese SSoT
(Equality gepinnt durch `tests/equality/budget-settings-read-modes.test.ts`).

## Befund: alle wertrelevanten Lesepfade nutzen `forDate` am Termin-/Transaktionsdatum

| Pfad | Datei:Zeile | Modus | Stichtag |
|---|---|---|---|
| Buchung (Cascade-Konsum) | `consumption-engine.ts:403` | `forDate` | `params.transactionDate` |
| Buchung (Verfügbarkeit pro Topf) | `consumption-engine.ts:186` | `forDate` | `today` (= `transactionDate`, Z. 160) |
| Hold/Reservierung (Preview vor Buchung) | `reservation-storage.ts:241` | `forDate` | `params.transactionDate` |
| Verfügbarkeit/Overview (Preview) | `unified-reader.ts:181` | `forDate` | `asOfDate` |
| Summary/Cockpit | `summary-queries.ts:104,325,381,420` | `forDate` | `asOfDate` / `today` |
| Allokations-Berechnung | `allocation-storage.ts:404,429,468,1213` | `forDate` | `asOfDate` / `todayISO()` |
| Rebook-Validierung (Re-Cascade) | `rebook-storage.ts:51` | `forDate` | `original.transactionDate` |

→ Preview (`readUnifiedBudgetAvailability` / Summary) und Buchung
(`createCascadeConsumption`) lesen denselben Reader-Modus am **gleichen Stichtag**.
Sie können nicht auf den Latest-Intent abdriften.

## `forEdit` / `withTransition` — sauber abgegrenzt (kein Wertpfad)

| Pfad | Datei:Zeile | Modus | Begründung |
|---|---|---|---|
| `getRebookPreview` | `rebook-storage.ts:154` | `forEdit` | Operator-Sicht „welche Töpfe sind JETZT deaktiviert?" — bestimmt nur, WELCHE Transaktionen umgebucht werden. Die eigentliche Umbuchung re-cascadet pro Termin am Termin-Datum (`forDate`, Z. 51). |
| Banner „Geplante Änderung" | `routes/budget.ts:444` | `withTransition` | Reine UI-Anzeige (jüngster Intent + heute effektiv). |

Kein Buchungs-, Verfügbarkeits-, Cap- oder Allokations-Pfad verwendet `forEdit`.

## Regressions-Absicherung
`tests/equality/c03-preview-booking-settings-parity.test.ts` belegt für **denselben
Termin**:
1. Die SSoT-Modi divergieren, sobald eine Zukunftsphase existiert
   (`forDate(heute).§45a=enabled` ≠ `forEdit.§45a=disabled`) → eine Drift WÄRE
   möglich, wenn ein Wertpfad den falschen Modus läse.
2. Der **Preview**-Lesepfad (`readUnifiedBudgetAvailability`) folgt je Stichtag der
   gültigen Phase.
3. Der **Buchungs**-Lesepfad (`createConsumptionTransaction` → Cascade) bucht je
   Stichtag gegen exakt dieselbe Phase (heute §45a belastet; in der
   Zukunfts-/Deaktiviert-Phase alles privat).
4. Parität: Preview-`enabled` je Stichtag === Buchungs-Routing je Stichtag.

Ergänzend bestehen: `tests/budget/task-721-phased-consumption.test.ts`
(Buchung respektiert Phasen-Cap statt jüngste Zeile) und
`tests/budget/task-1169-settings-revisionssicher.test.ts` (revisionssichere
Phasen-Historisierung der Schreibseite).

## Fazit
C-03 ist grün; kein wertneutraler Fix erforderlich. Phase 3 kann fortgesetzt
werden.
