/**
 * Task #997 (#1/#2) — Single-Source USt-Behandlung.
 *
 * Sichert die reine Domänenlogik aus `shared/domain/invoice-vat.ts`:
 *   - Die USt-Behandlung ist an den BUDGET-TOPF gebunden (Kassen-/Budget-Topf
 *     = steuerbefreit, Selbstzahler/Privat-Topf = 19 %), nicht an einen
 *     einzelnen `billingType`-String.
 *   - `distributeVatAcrossLines` verteilt eine USt-Summe drift-frei auf die
 *     Einzelzeilen (Σ(Zeilen) === Gesamt-USt), für positive (Rechnung) wie
 *     negative (Storno) Beträge. Das ist die Grundlage dafür, dass im Renderer
 *     Σ(Brutto-Zeilen) === Gesamtbetrag gilt (kein ×1,19-Drift, RE-2026-0023).
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { BUDGET_TYPES } from "@shared/domain/budgets";
import {
  STANDARD_VAT_RATE_BP,
  resolveVatTreatment,
  distributeVatAcrossLines,
  grossUpUnitPriceCents,
} from "@shared/domain/invoice-vat";

describe("resolveVatTreatment — Topf-gebundene USt (Task #997)", () => {
  it("jeder echte Budget-/Kassen-Topf ist steuerbefreit", () => {
    for (const pot of BUDGET_TYPES) {
      // Auch wenn der billingType (fälschlich) selbstzahler wäre: Topf gewinnt.
      expect(resolveVatTreatment({ billingType: "selbstzahler", budgetType: pot })).toBe("exempt");
      expect(resolveVatTreatment({ billingType: "pflegekasse_gesetzlich", budgetType: pot })).toBe("exempt");
    }
  });

  it("Privat-Topf trägt 19 % (standard)", () => {
    expect(resolveVatTreatment({ billingType: "selbstzahler", budgetType: "private" })).toBe("standard");
    // Selbstzahler-Rest ohne expliziten Topf-Marker → billingType entscheidet.
    expect(resolveVatTreatment({ billingType: "selbstzahler", budgetType: null })).toBe("standard");
    expect(resolveVatTreatment({ billingType: "selbstzahler" })).toBe("standard");
  });

  it("Pflegekassen-Abrechnung ohne Topf-Marker ist steuerbefreit", () => {
    expect(resolveVatTreatment({ billingType: "pflegekasse_gesetzlich", budgetType: null })).toBe("exempt");
    expect(resolveVatTreatment({ billingType: "pflegekasse_privat" })).toBe("exempt");
  });

  it("unbekannter Topf-Marker (kein Budget-Topf, nicht private) → standard", () => {
    expect(resolveVatTreatment({ billingType: "pflegekasse_gesetzlich", budgetType: "unbekannt" })).toBe("standard");
  });
});

describe("distributeVatAcrossLines — Σ-Drift-Garantie (Task #997)", () => {
  it("Σ(Verteilung) === totalVat exakt (Property, positiv & negativ)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -100000, max: 100000 }), { minLength: 1, maxLength: 20 }),
        fc.integer({ min: -50000, max: 50000 }),
        (lineNets, totalVat) => {
          const dist = distributeVatAcrossLines(lineNets, totalVat);
          expect(dist).toHaveLength(lineNets.length);
          expect(dist.reduce((s, v) => s + v, 0)).toBe(totalVat);
        },
      ),
      { seed: 42, numRuns: 500 },
    );
  });

  it("verteilt nach Largest-Remainder: [3,3,3] cents @ 2ct USt → [1,1,0]", () => {
    // round(9 * 0,19) = 2; per-line round(3*0,19)=1 ⇒ Σ=3 wäre der alte ×1,19-Bug.
    expect(distributeVatAcrossLines([3, 3, 3], 2)).toEqual([1, 1, 0]);
  });

  it("netSum === 0 ⇒ gesamte USt auf die erste Zeile", () => {
    expect(distributeVatAcrossLines([0, 0, 0], 5)).toEqual([5, 0, 0]);
  });

  it("totalVat === 0 ⇒ alle Zeilen 0 (steuerbefreit)", () => {
    expect(distributeVatAcrossLines([10, 20, 30], 0)).toEqual([0, 0, 0]);
  });

  it("leere Zeilenliste ⇒ leeres Ergebnis", () => {
    expect(distributeVatAcrossLines([], 0)).toEqual([]);
  });

  it("Brutto je Zeile (net + verteilte USt) summiert exakt auf net+totalVat", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 100000 }), { minLength: 1, maxLength: 15 }),
        (lineNets) => {
          const netSum = lineNets.reduce((s, v) => s + v, 0);
          const totalVat = Math.round((netSum * STANDARD_VAT_RATE_BP) / 10000);
          const dist = distributeVatAcrossLines(lineNets, totalVat);
          const grossSum = lineNets.reduce((s, v, i) => s + v + dist[i], 0);
          expect(grossSum).toBe(netSum + totalVat);
        },
      ),
      { seed: 42, numRuns: 500 },
    );
  });
});

describe("grossUpUnitPriceCents (Task #997)", () => {
  it("standard rundet auf 19 % brutto", () => {
    expect(grossUpUnitPriceCents(10000, "standard")).toBe(11900);
    expect(grossUpUnitPriceCents(315, "standard")).toBe(Math.round(315 * 1.19));
  });

  it("exempt lässt den Nettopreis unverändert (netto === brutto)", () => {
    expect(grossUpUnitPriceCents(10000, "exempt")).toBe(10000);
  });
});
