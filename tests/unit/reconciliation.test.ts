/**
 * Task #875 (Budget GF Phase 5) — Reconciliation classifier (R4/N7/I16/I20).
 * Reine Logik (unit-Project, kein Server/DB).
 *
 * Golden cases a/b/c + Invarianten:
 *  - Geld-Erhaltung: captureCents + overflowCents(uncovered) deckt actual,
 *    releaseCents + captureCents balanciert gegen den Hold.
 *  - case c ohne Privatzahlung ⇒ hardBlocked (führt zu OverBudgetCompletionError).
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { classifyReconciliation } from "@shared/domain/budget/reconciliation";

describe("Budget GF Phase 5 — Reconciliation classifier (Task #875)", () => {
  it("case a (partial_capture): IST < Hold ⇒ Rest wird freigegeben", () => {
    const r = classifyReconciliation({
      holdCents: 10_000,
      actualCents: 6_000,
      samePotHeadroomCents: 0,
      isPrivateCapable: false,
    });
    expect(r.case).toBe("partial_capture");
    expect(r.captureCents).toBe(6_000);
    expect(r.releaseCents).toBe(4_000);
    expect(r.extendCents).toBe(0);
    expect(r.overflowCents).toBe(0);
    expect(r.hardBlocked).toBe(false);
  });

  it("case a Grenzfall: IST === Hold ⇒ nichts freigeben, nichts nachziehen", () => {
    const r = classifyReconciliation({
      holdCents: 8_000,
      actualCents: 8_000,
      samePotHeadroomCents: 5_000,
      isPrivateCapable: false,
    });
    expect(r.case).toBe("partial_capture");
    expect(r.captureCents).toBe(8_000);
    expect(r.releaseCents).toBe(0);
  });

  it("case b (same_pot_extend): Mehrbetrag passt in Headroom derselben Töpfe", () => {
    const r = classifyReconciliation({
      holdCents: 10_000,
      actualCents: 13_000,
      samePotHeadroomCents: 5_000,
      isPrivateCapable: false,
    });
    expect(r.case).toBe("same_pot_extend");
    expect(r.captureCents).toBe(13_000);
    expect(r.releaseCents).toBe(0);
    expect(r.extendCents).toBe(3_000);
    expect(r.overflowCents).toBe(0);
    expect(r.hardBlocked).toBe(false);
  });

  it("case c privatfähig: Überlauf geht in den uncapped Topf (kein Hard-Block)", () => {
    const r = classifyReconciliation({
      holdCents: 10_000,
      actualCents: 20_000,
      samePotHeadroomCents: 3_000,
      isPrivateCapable: true,
    });
    expect(r.case).toBe("cross_pot_overflow");
    expect(r.extendCents).toBe(3_000);
    expect(r.overflowCents).toBe(7_000); // 20k - 10k hold - 3k headroom
    expect(r.captureCents).toBe(20_000); // hold + headroom + overflow
    expect(r.requiresPrivatePot).toBe(true);
    expect(r.hardBlocked).toBe(false);
  });

  it("case c NICHT privatfähig: harter Über-Budget-Abschluss (I16/I20)", () => {
    const r = classifyReconciliation({
      holdCents: 10_000,
      actualCents: 20_000,
      samePotHeadroomCents: 3_000,
      isPrivateCapable: false,
    });
    expect(r.case).toBe("cross_pot_overflow");
    expect(r.overflowCents).toBe(7_000);
    expect(r.captureCents).toBe(13_000); // hold + headroom, OHNE overflow
    expect(r.hardBlocked).toBe(true);
  });

  it("Property: Geld-Erhaltung — gedeckter Betrag + ungedeckter Überlauf = IST", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 500_000 }),
        fc.integer({ min: 0, max: 500_000 }),
        fc.integer({ min: 0, max: 500_000 }),
        fc.boolean(),
        (holdCents, actualCents, samePotHeadroomCents, isPrivateCapable) => {
          const r = classifyReconciliation({ holdCents, actualCents, samePotHeadroomCents, isPrivateCapable });
          const uncovered = r.hardBlocked ? r.overflowCents : 0;
          // Alles was gebucht wird plus der (bei Hard-Block) ungedeckte Rest
          // muss exakt die Ist-Kosten ergeben.
          expect(r.captureCents + uncovered).toBe(actualCents);
          // Beträge sind nie negativ.
          expect(r.captureCents).toBeGreaterThanOrEqual(0);
          expect(r.releaseCents).toBeGreaterThanOrEqual(0);
          expect(r.overflowCents).toBeGreaterThanOrEqual(0);
          // releaseCents nur in case a.
          if (r.releaseCents > 0) expect(r.case).toBe("partial_capture");
          // hardBlocked impliziert cross_pot_overflow ohne Privatfähigkeit.
          if (r.hardBlocked) {
            expect(r.case).toBe("cross_pot_overflow");
            expect(isPrivateCapable).toBe(false);
          }
        },
      ),
    );
  });
});
