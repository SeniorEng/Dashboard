/**
 * Budget GF Phase 1 (Task #871) — die EINE pure Topf-Kaskaden-Funktion.
 *
 * `planCascade` ist die Single-Source-of-Truth für die Verteilung einer
 * Termin-/Buchungskost auf die priorisierten Budget-Töpfe (§45b → §45a →
 * §39/§42a → optional privater Selbstzahler-Topf). Sie ist:
 *
 *  - **pur & deterministisch**: keine DB-Zugriffe, keine Zeit, kein Zufall —
 *    gleiche Eingabe ⇒ gleiche Ausgabe. Voll property-test-bar (I4).
 *  - **prioritäts-füllend**: füllt Töpfe in Reihenfolge bis zu ihrer Kapazität;
 *    der Überlauf fließt in den nächsten Topf.
 *  - **subtract-last / verlustfrei**: `Σ splits.amountCents === min(costCents,
 *    Σ erreichbare Kapazität)`; ein Rest, der von keinem Topf gedeckt wird,
 *    landet als `outstandingCents` (privater Overflow / Hard-Block-Entscheidung
 *    liegt beim Aufrufer — siehe north star).
 *  - **uncapped-aware**: ein als `uncapped` markierter Topf (privater Selbst-
 *    zahler-Topf) absorbiert den GESAMTEN Rest; seine Kapazität wird NIE als
 *    Zahl gelesen. `[R7]`
 *
 * WICHTIG (Phase 1, consume-only): Der Consume-Pfad heute kennt KEINEN
 * uncapped-Topf — jeder Topf hat eine endliche `capacityCents` (= effektiv
 * verfügbar nach Cap- und Allocation-Limit). Der Rest nach allen Töpfen wird zu
 * `outstandingCents` und vom privaten Overflow-Pfad in
 * `createConsumptionTransaction` behandelt. Das `uncapped`-Flag ist bereits
 * implementiert, damit Phase 3 (uncapped-Topf) ohne Signatur-Änderung andockt.
 */

export interface CascadePot {
  budgetType: string;
  /**
   * Effektiv verfügbare Kapazität in Cent (nach Cap- UND Allocation-Limit).
   * Bei `uncapped: true` IGNORIERT — der Topf nimmt den vollen Rest.
   */
  capacityCents: number;
  /** Privater Topf, der den gesamten Rest absorbiert (Kapazität nie als Zahl gelesen). */
  uncapped?: boolean;
}

export interface CascadeSplit {
  budgetType: string;
  amountCents: number;
  uncapped: boolean;
}

export interface PlanCascadeResult {
  splits: CascadeSplit[];
  /** Rest, den kein Topf decken konnte (privater Overflow / Hard-Block beim Aufrufer). */
  outstandingCents: number;
}

/**
 * Verteilt `costCents` deterministisch auf die priorisierten Töpfe.
 *
 * Jeder Topf erhält `min(verbleibender Rest, capacityCents)` (bzw. den vollen
 * Rest bei `uncapped`). Negative/NaN-Kapazitäten werden als 0 behandelt; eine
 * negative Kost wird auf 0 geklemmt. Es wird IMMER ein Split pro Topf emittiert
 * (auch mit amountCents 0), damit die Reihenfolge stabil und die Zuordnung zum
 * Eingabe-Topf positionsgleich bleibt.
 */
export function planCascade(
  costCents: number,
  pots: ReadonlyArray<CascadePot>,
): PlanCascadeResult {
  let remaining = Number.isFinite(costCents) && costCents > 0 ? Math.floor(costCents) : 0;
  const splits: CascadeSplit[] = [];

  for (const pot of pots) {
    const uncapped = pot.uncapped === true;
    let amount = 0;
    if (remaining > 0) {
      if (uncapped) {
        amount = remaining;
      } else {
        const capacity = Number.isFinite(pot.capacityCents) && pot.capacityCents > 0
          ? Math.floor(pot.capacityCents)
          : 0;
        amount = Math.min(remaining, capacity);
      }
    }
    remaining -= amount;
    splits.push({ budgetType: pot.budgetType, amountCents: amount, uncapped });
  }

  return { splits, outstandingCents: remaining };
}
