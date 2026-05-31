/**
 * Task #871 — Property-Tests (fast-check) für die pure Topf-Kaskade
 * `planCascade`. Reine Logik (unit-Project, kein Server/DB).
 *
 * Invarianten:
 *  - I4 (Conservation/verlustfrei): Σ splits.amountCents + outstandingCents
 *    === floor(max(0, costCents)). Kein Cent geht verloren oder entsteht.
 *  - I13 (Kein Overdraw): jeder gedeckelte Split ≤ effektiver Topf-Kapazität,
 *    und jeder Split ≥ 0.
 *  - Prioritäts-Füllung: solange Rest > 0, wird jeder gedeckelte Topf bis zur
 *    Kapazität gefüllt, bevor der nächste etwas bekommt (Outstanding > 0 ⇒ alle
 *    gedeckelten Töpfe randvoll).
 *  - uncapped-Absorption (R7): existiert ein uncapped-Topf und Kost > 0, ist
 *    Outstanding == 0.
 *  - Determinismus: gleiche Eingabe ⇒ gleiche Ausgabe.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { planCascade, type CascadePot } from "@shared/domain/budget/plan-cascade";

const potArb = fc.record({
  budgetType: fc.string({ minLength: 1, maxLength: 6 }),
  capacityCents: fc.integer({ min: -5_000, max: 50_000 }),
  uncapped: fc.boolean(),
});

const cappedPotArb = fc.record({
  budgetType: fc.string({ minLength: 1, maxLength: 6 }),
  capacityCents: fc.integer({ min: 0, max: 50_000 }),
});

describe("planCascade — property invariants (Task #871)", () => {
  it("I4: Σ splits + outstanding === floor(max(0, cost))", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -10_000, max: 200_000 }),
        fc.array(potArb, { maxLength: 6 }),
        (cost, pots) => {
          const r = planCascade(cost, pots);
          const sum = r.splits.reduce((s, x) => s + x.amountCents, 0);
          const expected = cost > 0 ? Math.floor(cost) : 0;
          expect(sum + r.outstandingCents).toBe(expected);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("I13: jeder Split ≥ 0; gedeckelter Split ≤ Topf-Kapazität (floored, ≥0)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 200_000 }),
        fc.array(potArb, { maxLength: 6 }),
        (cost, pots) => {
          const r = planCascade(cost, pots);
          r.splits.forEach((split, i) => {
            expect(split.amountCents).toBeGreaterThanOrEqual(0);
            if (!split.uncapped) {
              const cap = Math.max(0, Math.floor(pots[i].capacityCents));
              expect(split.amountCents).toBeLessThanOrEqual(cap);
            }
          });
        },
      ),
      { numRuns: 500 },
    );
  });

  it("Prioritäts-Füllung: Outstanding > 0 ⇒ alle gedeckelten Töpfe randvoll", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 200_000 }),
        fc.array(cappedPotArb, { maxLength: 6 }),
        (cost, pots) => {
          const r = planCascade(cost, pots as CascadePot[]);
          if (r.outstandingCents > 0) {
            r.splits.forEach((split, i) => {
              const cap = Math.max(0, Math.floor(pots[i].capacityCents));
              expect(split.amountCents).toBe(cap);
            });
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it("uncapped-Absorption: uncapped-Topf vorhanden & Kost > 0 ⇒ Outstanding 0", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 200_000 }),
        fc.array(cappedPotArb, { maxLength: 5 }),
        (cost, capped) => {
          const pots: CascadePot[] = [
            ...(capped as CascadePot[]),
            { budgetType: "private", capacityCents: 0, uncapped: true },
          ];
          const r = planCascade(cost, pots);
          expect(r.outstandingCents).toBe(0);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("Determinismus: gleiche Eingabe ⇒ gleiche Ausgabe", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -10_000, max: 200_000 }),
        fc.array(potArb, { maxLength: 6 }),
        (cost, pots) => {
          expect(planCascade(cost, pots)).toEqual(planCascade(cost, pots));
        },
      ),
      { numRuns: 300 },
    );
  });
});
