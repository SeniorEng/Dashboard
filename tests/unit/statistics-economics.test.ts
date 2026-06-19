import { describe, it, expect } from "vitest";
import {
  buildEconomics,
  costForMinutes,
  marginPercent,
  nonBillableRateCents,
} from "@shared/domain/statistics/economics";
import { computeKmLineTotalCents } from "@shared/domain/invoice-line-items";
import type { EconomicsRatesCents } from "@shared/statistics";

const RATES: EconomicsRatesCents = {
  hauswirtschaftRateCents: 1600,
  alltagsbegleitungRateCents: 1800,
  erstberatungRateCents: 2000,
  travelKmRateCents: 30,
  customerKmRateCents: 30,
  travelKmPriceCents: 30,
  customerKmPriceCents: 30,
};

describe("economics SSoT — pure helpers", () => {
  it("costForMinutes = minutes/60 × Stundensatz, kaufmännisch gerundet (Integer-Cents)", () => {
    expect(costForMinutes(60, 1600)).toBe(1600);
    expect(costForMinutes(90, 1600)).toBe(2400);
    expect(costForMinutes(30, 1800)).toBe(900);
    // 50 min @ 1600 = 1333.33 → 1333
    expect(costForMinutes(50, 1600)).toBe(1333);
  });

  it("costForMinutes ist defensiv gegen NaN/Infinity", () => {
    expect(costForMinutes(Number.NaN, 1600)).toBe(0);
    expect(costForMinutes(60, Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("marginPercent: Marge/Erlös in ganzen Prozent, Erlös ≤ 0 ⇒ 0", () => {
    expect(marginPercent(10000, 3000)).toBe(30);
    expect(marginPercent(0, 500)).toBe(0);
    expect(marginPercent(-100, 50)).toBe(0);
  });

  it("nicht-abrechenbare Zeit wird zum Hauswirtschafts-Satz bewertet", () => {
    expect(nonBillableRateCents(RATES)).toBe(RATES.hauswirtschaftRateCents);
  });
});

describe("economics SSoT — buildEconomics", () => {
  const result = buildEconomics({
    rates: RATES,
    hauswirtschaftMinutes: 120, // 2h @ 1600 = 3200
    alltagsbegleitungMinutes: 60, // 1h @ 1800 = 1800
    erstberatungMinutes: 30, // 0.5h @ 2000 = 1000
    nonBillable: [
      { category: "bueroarbeit", minutes: 60 }, // @ HW 1600 = 1600
      { category: "vertrieb", minutes: 30 }, // @ HW 1600 = 800
    ],
    travelKm: 10,
    customerKm: 4,
    timeEntryKm: 6,
    documentedServiceRevenueCents: 50000,
  });

  it("Personalkosten je Gruppe + abrechenbar/gesamt sind Integer-Cent-Summen", () => {
    expect(result.personnel.hauswirtschaft).toEqual({ minutes: 120, costCents: 3200 });
    expect(result.personnel.alltagsbegleitung).toEqual({ minutes: 60, costCents: 1800 });
    expect(result.personnel.billable).toEqual({ minutes: 180, costCents: 5000 });
    expect(result.personnel.erstberatung).toEqual({ minutes: 30, costCents: 1000 });
  });

  it("nicht-abrechenbar: HW-Bewertung je Kategorie, Summen stimmen", () => {
    expect(result.personnel.nonBillable.byCategory.map((c) => c.costCents)).toEqual([1600, 800]);
    expect(result.personnel.nonBillable.minutes).toBe(90);
    expect(result.personnel.nonBillable.costCents).toBe(2400);
  });

  it("Personal-Gesamt = abrechenbar + Erstberatung + nicht-abrechenbar", () => {
    expect(result.personnel.totalMinutes).toBe(180 + 30 + 90);
    expect(result.personnel.totalCostCents).toBe(5000 + 1000 + 2400);
  });

  it("km laufen über die km-SSoT (computeKmLineTotalCents), Erlös vs Kosten getrennt", () => {
    expect(result.km.travel.chargedCents).toBe(computeKmLineTotalCents(10, 30));
    expect(result.km.travel.paidCents).toBe(computeKmLineTotalCents(10, 30));
    expect(result.km.customer.chargedCents).toBe(computeKmLineTotalCents(4, 30));
    // Mitarbeiter-km aus Zeiterfassung: nur Kostenseite, kein Erlös
    expect(result.km.timeEntry.chargedCents).toBe(0);
    expect(result.km.timeEntry.paidCents).toBe(computeKmLineTotalCents(6, 30));
    expect(result.km.totalChargedCents).toBe(
      computeKmLineTotalCents(10, 30) + computeKmLineTotalCents(4, 30),
    );
    expect(result.km.totalPaidCents).toBe(
      computeKmLineTotalCents(10, 30) + computeKmLineTotalCents(4, 30) + computeKmLineTotalCents(6, 30),
    );
  });

  it("Ergebnis: Erlös = Service + km-Erlös, Kosten = Personal + km-Kosten, Marge konsistent", () => {
    const expectedRevenue = 50000 + result.km.totalChargedCents;
    const expectedCost = result.personnel.totalCostCents + result.km.totalPaidCents;
    expect(result.result.revenueCents).toBe(expectedRevenue);
    expect(result.result.totalCostCents).toBe(expectedCost);
    expect(result.result.marginCents).toBe(expectedRevenue - expectedCost);
    expect(result.result.marginPercent).toBe(marginPercent(expectedRevenue, expectedRevenue - expectedCost));
  });

  it("produktiv = abrechenbar + Erstberatung + km-Kosten; Overhead = nicht-abrechenbar", () => {
    expect(result.result.productiveCostCents).toBe(5000 + 1000 + result.km.totalPaidCents);
    expect(result.result.nonBillableCostCents).toBe(2400);
    // Produktiv + Overhead = Personal-Gesamt + km-Kosten = Gesamtkosten
    expect(result.result.productiveCostCents + result.result.nonBillableCostCents).toBe(
      result.result.totalCostCents,
    );
  });

  it("Anzeige === Berechnung: result.* sind dieselben Integer-Cents, die die Gruppen aufsummieren", () => {
    const personnelSum =
      result.personnel.billable.costCents +
      result.personnel.erstberatung.costCents +
      result.personnel.nonBillable.costCents;
    expect(result.result.personnelCostCents).toBe(personnelSum);
    expect(result.result.kmPaidCents).toBe(result.km.totalPaidCents);
    expect(result.result.kmChargedCents).toBe(result.km.totalChargedCents);
  });
});
