/**
 * Task #871 — Golden-Matrix für die EINE pure Topf-Kaskaden-Funktion
 * `planCascade` (`shared/domain/budget/plan-cascade.ts`).
 *
 * Reine Logik (kein Server/DB → unit-Project). Deckt die Pflegegrad-relevanten
 * Cascade-Szenarien ab: voll gedeckt, Topf-Überlauf, privater Overflow,
 * uncapped-Selbstzahler-Topf, Carryover (mehrere Spezial-Anteile fließen über
 * die Topf-Kapazität ein), sowie die Klemm-Kanten (negative Kost/Kapazität).
 */
import { describe, expect, it } from "vitest";
import { planCascade } from "@shared/domain/budget/plan-cascade";

const POTS_3 = (a: number, b: number, c: number) => [
  { budgetType: "entlastungsbetrag_45b", capacityCents: a },
  { budgetType: "umwandlung_45a", capacityCents: b },
  { budgetType: "ersatzpflege_39_42a", capacityCents: c },
];

describe("planCascade — golden matrix (Task #871)", () => {
  it("Kost vollständig vom ersten Topf gedeckt", () => {
    const r = planCascade(5000, POTS_3(10000, 0, 0));
    expect(r.splits.map((s) => s.amountCents)).toEqual([5000, 0, 0]);
    expect(r.outstandingCents).toBe(0);
  });

  it("Überlauf füllt Töpfe prioritäts-geordnet", () => {
    const r = planCascade(10000, POTS_3(3000, 2000, 1000));
    expect(r.splits.map((s) => s.amountCents)).toEqual([3000, 2000, 1000]);
    expect(r.outstandingCents).toBe(4000); // Rest = privater Overflow
  });

  it("privater Overflow: Σ splits + outstanding == Kost", () => {
    const cost = 12345;
    const r = planCascade(cost, POTS_3(3000, 2000, 1000));
    const sum = r.splits.reduce((s, x) => s + x.amountCents, 0);
    expect(sum + r.outstandingCents).toBe(cost);
  });

  it("uncapped Selbstzahler-Topf absorbiert den gesamten Rest", () => {
    const r = planCascade(10000, [
      ...POTS_3(3000, 2000, 1000),
      { budgetType: "private", capacityCents: 0, uncapped: true },
    ]);
    expect(r.splits.map((s) => s.amountCents)).toEqual([3000, 2000, 1000, 4000]);
    expect(r.splits[3].uncapped).toBe(true);
    expect(r.outstandingCents).toBe(0);
  });

  it("reiner Selbstzahler (nur uncapped Topf)", () => {
    const r = planCascade(8888, [{ budgetType: "private", capacityCents: 0, uncapped: true }]);
    expect(r.splits[0].amountCents).toBe(8888);
    expect(r.outstandingCents).toBe(0);
  });

  it("Carryover: mehrere Anteile via Topf-Kapazität, exakt randvoll", () => {
    const r = planCascade(13100, POTS_3(13100, 0, 0));
    expect(r.splits[0].amountCents).toBe(13100);
    expect(r.outstandingCents).toBe(0);
  });

  it("deaktivierter/leerer Topf (capacity 0) wird übersprungen, Reihenfolge bleibt", () => {
    const r = planCascade(5000, POTS_3(0, 4000, 4000));
    expect(r.splits.map((s) => s.amountCents)).toEqual([0, 4000, 1000]);
    expect(r.outstandingCents).toBe(0);
  });

  it("Kost 0 → alle Splits 0, kein Outstanding", () => {
    const r = planCascade(0, POTS_3(3000, 2000, 1000));
    expect(r.splits.map((s) => s.amountCents)).toEqual([0, 0, 0]);
    expect(r.outstandingCents).toBe(0);
  });

  it("negative Kost wird auf 0 geklemmt", () => {
    const r = planCascade(-500, POTS_3(3000, 2000, 1000));
    expect(r.splits.map((s) => s.amountCents)).toEqual([0, 0, 0]);
    expect(r.outstandingCents).toBe(0);
  });

  it("negative/NaN Kapazität zählt als 0", () => {
    const r = planCascade(5000, [
      { budgetType: "a", capacityCents: -1000 },
      { budgetType: "b", capacityCents: NaN },
      { budgetType: "c", capacityCents: 2000 },
    ]);
    expect(r.splits.map((s) => s.amountCents)).toEqual([0, 0, 2000]);
    expect(r.outstandingCents).toBe(3000);
  });

  it("floort dezimale Eingaben deterministisch", () => {
    const r = planCascade(5000.9, [{ budgetType: "a", capacityCents: 1999.9 }]);
    expect(r.splits[0].amountCents).toBe(1999);
    expect(r.outstandingCents).toBe(3001); // floor(5000.9)=5000, 5000-1999
  });

  it("emittiert genau einen Split pro Topf, positionsgleich", () => {
    const pots = POTS_3(100, 200, 300);
    const r = planCascade(50, pots);
    expect(r.splits).toHaveLength(3);
    expect(r.splits.map((s) => s.budgetType)).toEqual(pots.map((p) => p.budgetType));
  });
});
