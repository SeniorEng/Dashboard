/**
 * Task #1353 — Backstop im Rechnungssplit: ein reiner Pflegekassen-Kunde
 * (kein Selbstzahler, `acceptsPrivatePayment = false`) darf NIE einen privaten
 * (Selbstzahler-)Anteil bekommen. Entstünde im Split dennoch ein Privatanteil
 * (Fallback-Topf für Termine ohne Budget-Mapping ODER ein vom Split selbst
 * ermittelter „Rest"), MUSS `splitLineItemsByPot({ allowPrivatePot: false })`
 * laut blockieren statt still eine 19%-Privatrechnung auszustellen
 * (Jungnickel-/AOK-Fall).
 *
 * Selbstzahler / `acceptsPrivatePayment = true` (`allowPrivatePot: true`)
 * behalten den privaten Topf — inkl. des Falls „Budget 0 → genau EINE
 * Privatrechnung" (#812).
 */
import { describe, it, expect } from "vitest";
import { splitLineItemsByPot } from "../../server/services/invoice-calc";
import type { BudgetSplitForAppointment } from "@shared/domain/budget-invoice-split";
import type { BuildLineItem } from "../../server/services/invoice-data";

function lineItem(appointmentId: number, totalCents: number): BuildLineItem {
  return {
    appointmentId,
    appointmentDate: "2026-06-10",
    serviceDescription: "Hauswirtschaft",
    serviceCode: "hauswirtschaft",
    startTime: "09:00",
    endTime: "10:00",
    durationMinutes: 60,
    quantityRaw: 1,
    quantityUnit: "hours",
    unitPriceCents: totalCents,
    totalCents,
    employeeName: "Test MA",
    appointmentNotes: null,
    serviceDetails: null,
  };
}

describe("splitLineItemsByPot Privat-Backstop (Task #1353)", () => {
  it("allowPrivatePot=false + Termin ohne Budget-Mapping (Fallback Privat) → blockiert", () => {
    const items = [lineItem(101, 5000)];
    // Leere Split-Map ⇒ kompletter Betrag landet im Fallback-Topf „private".
    expect(() => splitLineItemsByPot(items, new Map(), { allowPrivatePot: false }))
      .toThrowError(/101/);
  });

  it("allowPrivatePot=false + expliziter Privat-Rest aus dem Split → blockiert", () => {
    const items = [lineItem(202, 10000)];
    const split = new Map<number, BudgetSplitForAppointment>([
      [202, { cents: { entlastungsbetrag_45b: 7000, private: 3000 } }],
    ]);
    expect(() => splitLineItemsByPot(items, split, { allowPrivatePot: false }))
      .toThrowError(/202/);
  });

  it("allowPrivatePot=false + rein gesetzliche Anteile → erlaubt, kein Privat-Topf", () => {
    const items = [lineItem(303, 8000)];
    const split = new Map<number, BudgetSplitForAppointment>([
      [303, { cents: { entlastungsbetrag_45b: 8000 } }],
    ]);
    const byPot = splitLineItemsByPot(items, split, { allowPrivatePot: false });
    expect(byPot.has("private")).toBe(false);
    expect(byPot.get("entlastungsbetrag_45b")?.[0]?.totalCents).toBe(8000);
  });

  it("allowPrivatePot=true (Selbstzahler/privat) → Privat-Topf bleibt erhalten", () => {
    const items = [lineItem(404, 6000)];
    const byPot = splitLineItemsByPot(items, new Map(), { allowPrivatePot: true });
    expect(byPot.get("private")?.[0]?.totalCents).toBe(6000);
  });

  it("Budget 0 → genau EINE Privatrechnung bleibt erhalten (#812)", () => {
    // Kein Budget-Mapping, allowPrivatePot=true ⇒ alle Termine im Privat-Topf.
    const items = [lineItem(501, 3000), lineItem(502, 4500)];
    const byPot = splitLineItemsByPot(items, new Map(), { allowPrivatePot: true });
    expect([...byPot.keys()]).toEqual(["private"]);
    expect(byPot.get("private")?.map((li) => li.totalCents)).toEqual([3000, 4500]);
  });

  it("Default (ohne Option) ist rückwärtskompatibel: Privat-Topf erlaubt", () => {
    const items = [lineItem(601, 2500)];
    const byPot = splitLineItemsByPot(items, new Map());
    expect(byPot.get("private")?.[0]?.totalCents).toBe(2500);
  });
});
