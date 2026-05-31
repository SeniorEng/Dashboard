/**
 * Task #873 (Budget GF Phase 3) — Pure Invarianten I5 + I6 für den
 * uncapped-Selbstzahler-Topf und die typisierte Hard-Block-Ablehnung.
 * Reine Logik (unit-Project, kein Server/DB).
 *
 * I5 (Hard-Block): Fehlt der private (uncapped) Topf und übersteigt die Kost die
 *   Summe der gedeckelten Kapazitäten, bleibt ein Rest (`outstandingCents > 0`),
 *   den der Aufrufer als `BudgetHardBlockError` mit exaktem `shortfallCents`
 *   wirft.
 * I6 / R7 (uncapped absorbiert, Kapazität nie gelesen): Ein als `uncapped`
 *   markierter terminaler Topf nimmt den GESAMTEN Rest — und das UNABHÄNGIG von
 *   seiner `capacityCents`. Wir beweisen „die Kapazität wird nie als Zahl
 *   gelesen", indem wir absurde Kapazitäten (NaN, ±∞, negativ, 0, riesig)
 *   einsetzen und trotzdem IMMER `outstandingCents === 0` und einen privaten
 *   Split in Höhe des vollen Rests erhalten.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { planCascade, type CascadePot } from "@shared/domain/budget/plan-cascade";
import { BudgetHardBlockError } from "@shared/domain/budget/over-budget-error";
import { formatEuroDE } from "@shared/utils/money";

describe("Budget GF Phase 3 — uncapped-Topf & Hard-Block (Task #873)", () => {
  it("I6/R7: uncapped terminaler Topf absorbiert den vollen Rest — bei JEDER Kapazität", () => {
    const absurdCapacities = [
      0,
      -1,
      -999_999,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      1,
      10 ** 12,
    ];
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 500_000 }),
        fc.array(fc.integer({ min: 0, max: 50_000 }), { maxLength: 4 }),
        fc.constantFrom(...absurdCapacities),
        (cost, cappedCaps, uncappedCap) => {
          const cappedPots: CascadePot[] = cappedCaps.map((c, i) => ({
            budgetType: `s${i}`,
            capacityCents: c,
          }));
          const pots: CascadePot[] = [
            ...cappedPots,
            { budgetType: "private", capacityCents: uncappedCap, uncapped: true },
          ];
          const r = planCascade(cost, pots);
          // R7: kein Rest, egal welche (absurde) Kapazität der uncapped-Topf trägt.
          expect(r.outstandingCents).toBe(0);
          // Der private Split deckt exakt den Rest nach den gedeckelten Töpfen.
          const cappedConsumed = r.splits
            .filter((s) => !s.uncapped)
            .reduce((s, x) => s + x.amountCents, 0);
          const priv = r.splits.find((s) => s.uncapped);
          expect(priv).toBeDefined();
          expect(priv!.amountCents).toBe(Math.floor(cost) - cappedConsumed);
        },
      ),
      { numRuns: 400 },
    );
  });

  it("I5: KEIN uncapped-Topf & Kost > Σ Kapazität ⇒ outstanding > 0 (Hard-Block)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 20_000 }), { minLength: 1, maxLength: 4 }),
        fc.integer({ min: 1, max: 50_000 }),
        (caps, surplus) => {
          const sumCap = caps.reduce((s, c) => s + Math.floor(Math.max(0, c)), 0);
          const cost = sumCap + surplus; // garantiert über der Gesamtkapazität
          const pots: CascadePot[] = caps.map((c, i) => ({
            budgetType: `s${i}`,
            capacityCents: c,
          }));
          const r = planCascade(cost, pots);
          expect(r.outstandingCents).toBe(surplus);
          // Aufrufer-Kontrakt: aus dem Rest wird der typisierte Hard-Block.
          const err = new BudgetHardBlockError(r.outstandingCents);
          expect(err.shortfallCents).toBe(surplus);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("BudgetHardBlockError: Code, Felder & exakte Legacy-Meldung", () => {
    const err = new BudgetHardBlockError(1234);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("BUDGET_HARD_BLOCK");
    expect(err.shortfallCents).toBe(1234);
    expect(err.name).toBe("BudgetHardBlockError");
    // Routen matchen weiterhin via message.includes("Budget reicht nicht").
    expect(err.message).toContain("Budget reicht nicht");
    expect(err.message).toBe(
      `Budget reicht nicht — es fehlen ${formatEuroDE(1234)}. Kunde akzeptiert keine Privatzahlung.`,
    );
  });
});
