/**
 * Phase-1.2-Drift-Folge — Unit-Tests für die pure `classifyCostEstimate`-
 * Funktion (`shared/domain/budget/cost-estimate-outcome.ts`).
 *
 * Sichert alle vier Klassifikations-Branches inkl. VAT-Mathematik und
 * Warnungs-Strings ab. Schützt die Wire-Shape der `/cost-estimate`-Route
 * vor unbeabsichtigten Änderungen — der Route-Wrapper baut das Response
 * direkt aus dem Outcome.
 */
// @ts-nocheck

import { describe, it, expect } from "vitest";
import { classifyCostEstimate } from "@shared/domain/budget/cost-estimate-outcome";

describe("classifyCostEstimate — Branch-Klassifikation", () => {
  it("Selbstzahler: liefert bruttoCents = totalCost + MwSt, kein Warning, kein HardBlock", () => {
    const out = classifyCostEstimate({
      totalCostCents: 100_00,
      availableCents: 0,
      weightedVatRate: 19,
      acceptsPrivatePayment: false,
      isSelbstzahler: true,
    });
    expect(out.kind).toBe("selbstzahler");
    expect(out.warning).toBeNull();
    expect(out.isHardBlock).toBe(false);
    expect(out.privateCents).toBe(0);
    expect(out.vatCents).toBe(19_00);
    expect(out.bruttoCents).toBe(119_00);
  });

  it("OK-Pfad: totalCost ≤ available → keine Warnung, kein Block, alle Beträge 0", () => {
    const out = classifyCostEstimate({
      totalCostCents: 50_00,
      availableCents: 100_00,
      weightedVatRate: 19,
      acceptsPrivatePayment: false,
      isSelbstzahler: false,
    });
    expect(out.kind).toBe("ok");
    expect(out.warning).toBeNull();
    expect(out.isHardBlock).toBe(false);
    expect(out.privateCents).toBe(0);
    expect(out.vatCents).toBe(0);
  });

  it("Soft-Private: Budget-Engpass + acceptsPrivatePayment → privateCents = shortfall, MwSt auf shortfall, warning enthält Betrag", () => {
    const out = classifyCostEstimate({
      totalCostCents: 150_00,
      availableCents: 100_00,
      weightedVatRate: 19,
      acceptsPrivatePayment: true,
      isSelbstzahler: false,
    });
    expect(out.kind).toBe("soft_private");
    expect(out.isHardBlock).toBe(false);
    expect(out.privateCents).toBe(50_00);
    expect(out.vatCents).toBe(9_50); // 50 € × 19 % = 9,50 €
    expect(out.warning).toMatch(/^Budget reicht nicht — 50,00\s*€ werden privat berechnet\.$/);
  });

  it("Hard-Block: Budget-Engpass ohne acceptsPrivatePayment → isHardBlock=true, warning enthält shortfall, keine privatCents", () => {
    const out = classifyCostEstimate({
      totalCostCents: 150_00,
      availableCents: 100_00,
      weightedVatRate: 19,
      acceptsPrivatePayment: false,
      isSelbstzahler: false,
    });
    expect(out.kind).toBe("hard_block");
    expect(out.isHardBlock).toBe(true);
    expect(out.privateCents).toBe(0);
    expect(out.vatCents).toBe(0);
    expect(out.warning).toMatch(/^Budget reicht nicht — es fehlen 50,00\s*€\.$/);
  });

  it("Selbstzahler-Priorität: isSelbstzahler überstimmt Budget-Engpass-Logik (kein HardBlock auch bei totalCost > available)", () => {
    const out = classifyCostEstimate({
      totalCostCents: 200_00,
      availableCents: 0,
      weightedVatRate: 7,
      acceptsPrivatePayment: false,
      isSelbstzahler: true,
    });
    expect(out.kind).toBe("selbstzahler");
    expect(out.isHardBlock).toBe(false);
    expect(out.warning).toBeNull();
    expect(out.vatCents).toBe(14_00); // 200 € × 7 % = 14 €
    expect(out.bruttoCents).toBe(214_00);
  });

  it("Grenzfall total = available: OK-Pfad (Kosten passen exakt)", () => {
    const out = classifyCostEstimate({
      totalCostCents: 100_00,
      availableCents: 100_00,
      weightedVatRate: 19,
      acceptsPrivatePayment: true,
      isSelbstzahler: false,
    });
    expect(out.kind).toBe("ok");
    expect(out.warning).toBeNull();
  });

  it("Rundung: shortfall × VAT wird mathematisch korrekt gerundet (Bankers irrelevant)", () => {
    // shortfall = 33,33 €, 19 % = 6,3327 € → 633 ct
    const out = classifyCostEstimate({
      totalCostCents: 133_33,
      availableCents: 100_00,
      weightedVatRate: 19,
      acceptsPrivatePayment: true,
      isSelbstzahler: false,
    });
    expect(out.privateCents).toBe(33_33);
    expect(out.vatCents).toBe(633);
  });
});
