/**
 * Task #1083 — Rechnung: kumulierte Positionen.
 *
 * Sichert die reine Aggregations-Logik aus
 * `shared/domain/invoice-line-aggregation.ts`:
 *   - eine Zeile je Service-Typ (gleicher serviceCode + Stückpreis),
 *   - EINE gemeinsame „Fahrtkosten"-Zeile (travel_km + customer_km gemergt),
 *   - `no_show_charge` bleibt pro Termin stehen,
 *   - Σ(totalCents) bleibt bit-genau erhalten (GoBD / ZUGFeRD-Reconciliation),
 *   - deterministische Reihenfolge: Service-Gruppen → Fahrtkosten → no_show.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  aggregateInvoiceLineItems,
  FAHRTKOSTEN_LABEL,
  type AggregatableInvoiceLine,
} from "@shared/domain/invoice-line-aggregation";

function line(p: Partial<AggregatableInvoiceLine>): AggregatableInvoiceLine {
  return {
    appointmentId: 1,
    appointmentDate: "2026-01-05",
    startTime: "09:00",
    endTime: "10:00",
    serviceDescription: "Leistung",
    serviceCode: "hauswirtschaft",
    durationMinutes: 60,
    quantityRaw: 1,
    quantityUnit: "hours",
    unitPriceCents: 4500,
    totalCents: 4500,
    employeeName: "MA",
    appointmentNotes: null,
    serviceDetails: null,
    ...p,
  };
}

describe("aggregateInvoiceLineItems (Task #1083)", () => {
  it("fasst gleichen Service-Typ (serviceCode + Stückpreis) zu einer Zeile zusammen", () => {
    const out = aggregateInvoiceLineItems([
      line({ appointmentId: 1, serviceCode: "hauswirtschaft", unitPriceCents: 4500, quantityRaw: 1, totalCents: 4500 }),
      line({ appointmentId: 2, serviceCode: "hauswirtschaft", unitPriceCents: 4500, quantityRaw: 2, totalCents: 9000 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].serviceCode).toBe("hauswirtschaft");
    expect(out[0].totalCents).toBe(13500);
    expect(out[0].quantityRaw).toBeCloseTo(3, 6);
    expect(out[0].appointmentId).toBeNull();
  });

  it("trennt gleichen serviceCode mit unterschiedlichem Stückpreis", () => {
    const out = aggregateInvoiceLineItems([
      line({ serviceCode: "hauswirtschaft", unitPriceCents: 4500, totalCents: 4500 }),
      line({ serviceCode: "hauswirtschaft", unitPriceCents: 5000, totalCents: 5000 }),
    ]);
    expect(out).toHaveLength(2);
    expect(out.map((l) => l.unitPriceCents).sort()).toEqual([4500, 5000]);
  });

  it("mergt travel_km + customer_km zu EINER Fahrtkosten-Zeile je Stückpreis", () => {
    const out = aggregateInvoiceLineItems([
      line({ serviceCode: "travel_km", quantityUnit: "km", unitPriceCents: 35, quantityRaw: 3, totalCents: 105 }),
      line({ serviceCode: "customer_km", quantityUnit: "km", unitPriceCents: 35, quantityRaw: 2, totalCents: 70 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].serviceDescription).toBe(FAHRTKOSTEN_LABEL);
    expect(out[0].serviceCode).toBe("travel_km");
    expect(out[0].quantityUnit).toBe("km");
    expect(out[0].quantityRaw).toBeCloseTo(5, 3);
    expect(out[0].totalCents).toBe(175);
  });

  it("trennt Fahrtkosten nach Stückpreis", () => {
    const out = aggregateInvoiceLineItems([
      line({ serviceCode: "travel_km", quantityUnit: "km", unitPriceCents: 35, quantityRaw: 3, totalCents: 105 }),
      line({ serviceCode: "customer_km", quantityUnit: "km", unitPriceCents: 40, quantityRaw: 2, totalCents: 80 }),
    ]);
    expect(out).toHaveLength(2);
    expect(out.every((l) => l.serviceDescription === FAHRTKOSTEN_LABEL)).toBe(true);
  });

  it("lässt no_show_charge pro Termin stehen (nicht kumuliert)", () => {
    const out = aggregateInvoiceLineItems([
      line({ appointmentId: 1, serviceCode: "no_show_charge", serviceDescription: "Vergebliche Anfahrt 05.01.", unitPriceCents: 2000, totalCents: 2000 }),
      line({ appointmentId: 2, serviceCode: "no_show_charge", serviceDescription: "Vergebliche Anfahrt 06.01.", unitPriceCents: 2000, totalCents: 2000 }),
    ]);
    expect(out).toHaveLength(2);
    expect(out.map((l) => l.appointmentId)).toEqual([1, 2]);
  });

  it("Reihenfolge: Service-Gruppen → Fahrtkosten → no_show", () => {
    const out = aggregateInvoiceLineItems([
      line({ serviceCode: "no_show_charge", serviceDescription: "Vergebliche Anfahrt", totalCents: 2000 }),
      line({ serviceCode: "travel_km", quantityUnit: "km", unitPriceCents: 35, quantityRaw: 1, totalCents: 35 }),
      line({ serviceCode: "betreuung", serviceDescription: "Betreuung", unitPriceCents: 5000, totalCents: 5000 }),
    ]);
    expect(out.map((l) => l.serviceCode)).toEqual(["betreuung", "travel_km", "no_show_charge"]);
  });

  it("property: Σ(totalCents) bleibt bit-genau erhalten", () => {
    const kmCodes = ["travel_km", "customer_km"];
    const svcCodes = ["hauswirtschaft", "betreuung", "no_show_charge"];
    const itemArb = fc.record({
      serviceCode: fc.constantFrom(...kmCodes, ...svcCodes),
      unitPriceCents: fc.integer({ min: 1, max: 10000 }),
      quantityRaw: fc.integer({ min: 1, max: 50 }),
      totalCents: fc.integer({ min: -10000, max: 100000 }),
    });
    fc.assert(
      fc.property(fc.array(itemArb, { minLength: 0, maxLength: 30 }), (specs) => {
        const items = specs.map((s, idx) =>
          line({
            appointmentId: idx + 1,
            serviceCode: s.serviceCode,
            serviceDescription: s.serviceCode,
            quantityUnit: kmCodes.includes(s.serviceCode) ? "km" : "hours",
            unitPriceCents: s.unitPriceCents,
            quantityRaw: s.quantityRaw,
            totalCents: s.totalCents,
          }),
        );
        const before = items.reduce((sum, i) => sum + i.totalCents, 0);
        const after = aggregateInvoiceLineItems(items).reduce((sum, i) => sum + i.totalCents, 0);
        return before === after;
      }),
      { seed: 42, numRuns: 100 },
    );
  });
});
