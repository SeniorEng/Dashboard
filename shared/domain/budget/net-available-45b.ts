/**
 * Task #1348 — Pure §45b-Verfügbarkeits-Arithmetik (SSoT-Kern).
 *
 * Die reine Schluss-Mathematik der §45b-Verfügbarkeit ("wieviel Entlastungsbetrag
 * ist zum Stichtag noch frei") lebt hier als pure, DB-freie Funktion. Der
 * DB-Reader `server/storage/budget/net-available-45b.ts` lädt nur die
 * Eingangsgrößen (Allocation, Holds, Verbrauch, Exklusion) und ruft GENAU diese
 * Funktion auf — so existiert die §45b-Verfügbarkeits-Mathe nur EINMAL.
 *
 * Identität (Erhaltungs-Gleichung des `unified-reader`, vor dem optionalen
 * Fenster-Cap, der bei §45b nur bei gesetztem `monthlyLimitCents` greift):
 *
 *     available = max(0, allocated − effectiveHolds − max(0, rawConsumed − excluded))
 *
 * Alrik-Gate: `availableCents` wird auf 0 gefloored — in BEIDEN Holds-Modi. Ein
 * Fehlbetrag (Über-Verbrauch) bleibt NICHT im gefloorten Wert hängen, sondern ist
 * über die roh durchgereichten `allocatedCents` / `consumedNetCents` als negativer
 * `allocated − consumedNet`-Saldo sichtbar (#95) — NIE aus `availableCents`
 * ableiten.
 *
 * Die Konstante liegt bewusst in `shared/domain/` (Architektur-Test #427:
 * `compute*45b`-Mathe muss in `shared/domain/` wohnen).
 */

export type Holds45bMode = "subtract" | "ignore";

export interface NetAvailable45bInputs {
  /** Bis zum Stichtag aufgelaufene Allocation (inkl. `manual_adjustment`-Posten). */
  readonly allocatedCents: number;
  /** Aktive Hard-Holds des Jahresfensters. */
  readonly holdsCents: number;
  /** Roher Netto-Verbrauch (consumption+write_off−reversal, OHNE manual_adjustment). */
  readonly rawConsumedNetCents: number;
  /** Verbrauch gegen einen aus `allocated` herausgefallenen Topf (Übertrag/IB). */
  readonly excludedConsumedNetCents: number;
  /**
   * Holds-Kontext:
   *  - `"subtract"` (Default): Holds werden abgezogen — READER-/BUCHUNGS-Sicht.
   *  - `"ignore"`: Holds wirken NICHT auf `availableCents` — FORECAST-Sicht (der
   *    Forecast zählt die geplanten Kosten ohnehin selbst, sonst Doppelzählung,
   *    #1340). `holdsCents` bleibt im Ergebnis sichtbar.
   */
  readonly holds?: Holds45bMode;
}

export interface NetAvailable45bComposition {
  /** Bis zum Stichtag aufgelaufene Allocation (inkl. `manual_adjustment`-Posten). */
  readonly allocatedCents: number;
  /** Aktive Hard-Holds des Jahresfensters. */
  readonly holdsCents: number;
  /** Roher Netto-Verbrauch (consumption+write_off−reversal, OHNE manual_adjustment). */
  readonly rawConsumedNetCents: number;
  /** Verbrauch gegen einen aus `allocated` herausgefallenen Topf (Übertrag/IB). */
  readonly excludedConsumedNetCents: number;
  /** `max(0, rawConsumedNet − excluded)` — der dem laufenden Topf zuzurechnende Verbrauch. */
  readonly consumedNetCents: number;
  /** `max(0, allocated − effectiveHolds − consumedNet)` — die verfügbare §45b-Summe in Cent. */
  readonly availableCents: number;
}

/**
 * Die EINE pure §45b-Verfügbarkeits-Mathe. Floored `availableCents` auf 0 (Alrik-
 * Gate, beide Holds-Modi); reicht alle Eingangsgrößen roh durch, damit ein
 * Fehlbetrag als negativer `allocated − consumedNet`-Saldo sichtbar bleibt.
 */
export function computeNetAvailable45b(
  inputs: NetAvailable45bInputs,
): NetAvailable45bComposition {
  const consumedNetCents = Math.max(
    0,
    inputs.rawConsumedNetCents - inputs.excludedConsumedNetCents,
  );
  const effectiveHoldsCents =
    (inputs.holds ?? "subtract") === "ignore" ? 0 : inputs.holdsCents;
  const availableCents = Math.max(
    0,
    inputs.allocatedCents - effectiveHoldsCents - consumedNetCents,
  );
  return {
    allocatedCents: inputs.allocatedCents,
    holdsCents: inputs.holdsCents,
    rawConsumedNetCents: inputs.rawConsumedNetCents,
    excludedConsumedNetCents: inputs.excludedConsumedNetCents,
    consumedNetCents,
    availableCents,
  };
}
