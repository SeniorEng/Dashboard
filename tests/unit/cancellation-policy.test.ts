/**
 * Pure-Unit-Tests für die No-Show-/Reisekosten-Berechnung in
 * `shared/domain/cancellation-policy.ts` (Task #791 — Mutation-Testing-
 * Erweiterung).
 *
 * Diese Tests laufen OHNE DB/Server und sind Teil der Stryker-Mutation-
 * Suite. Abgedeckt:
 *   - computeNoShowCharge (Branches none / flat_amount / travel_plus_wait)
 *   - Fallback-Sätze (km-/Stunden-Satz aus Service-Katalog)
 *   - Negativ-Clamping und Beschreibungs-Komposition
 *   - hasChargeableCancellationPolicy
 *
 * Schwerpunkt auf den Geldbeträgen (km × Satz, Wartezeit-Anteil) und den
 * `km > 0 && kmRate > 0`-Bedingungen der Beschreibung, damit Mutationen an
 * Operatoren, Math.round und den Branch-Bedingungen gefangen werden.
 */
import { describe, it, expect } from "vitest";
import {
  computeNoShowCharge,
  hasChargeableCancellationPolicy,
} from "@shared/domain/cancellation-policy";

describe("computeNoShowCharge — Policy 'none'", () => {
  it("liefert durchgehend 0 und keine Beschreibung", () => {
    const out = computeNoShowCharge(
      { type: "none" },
      { travelKilometers: 10, waitMinutes: 30 },
    );
    expect(out).toEqual({
      totalCents: 0,
      travelCents: 0,
      waitCents: 0,
      flatCents: 0,
      description: "",
    });
  });
});

describe("computeNoShowCharge — Policy 'flat_amount'", () => {
  it("berechnet den Pauschalbetrag und ignoriert km/Wartezeit", () => {
    const out = computeNoShowCharge(
      { type: "flat_amount", flatCents: 2500 },
      { travelKilometers: 99, waitMinutes: 99 },
    );
    expect(out.totalCents).toBe(2500);
    expect(out.flatCents).toBe(2500);
    expect(out.travelCents).toBe(0);
    expect(out.waitCents).toBe(0);
    expect(out.description).toBe("Vergebliche Anfahrt (Pauschale)");
  });

  it("klemmt negativen/fehlenden Pauschalbetrag auf 0", () => {
    expect(
      computeNoShowCharge(
        { type: "flat_amount", flatCents: -100 },
        { travelKilometers: 0, waitMinutes: 0 },
      ).totalCents,
    ).toBe(0);
    expect(
      computeNoShowCharge(
        { type: "flat_amount", flatCents: null },
        { travelKilometers: 0, waitMinutes: 0 },
      ).flatCents,
    ).toBe(0);
  });
});

describe("computeNoShowCharge — Policy 'travel_plus_wait'", () => {
  it("rechnet km × Satz plus anteilige Wartezeit", () => {
    // 10 km × 50 ct = 500 ct ; 30 min / 60 × 2000 ct = 1000 ct → 1500 ct.
    const out = computeNoShowCharge(
      { type: "travel_plus_wait", kmRateCents: 50, hourlyRateCents: 2000 },
      { travelKilometers: 10, waitMinutes: 30 },
    );
    expect(out.travelCents).toBe(500);
    expect(out.waitCents).toBe(1000);
    expect(out.totalCents).toBe(1500);
    expect(out.flatCents).toBe(0);
    expect(out.description).toBe(
      "Vergebliche Anfahrt (10,00 km Anfahrt + 30 Min. Wartezeit)",
    );
  });

  it("rundet die Wartezeit kaufmännisch (Math.round)", () => {
    // 10 min / 60 × 2000 = 333.33… → 333 ct.
    const out = computeNoShowCharge(
      { type: "travel_plus_wait", kmRateCents: 0, hourlyRateCents: 2000 },
      { travelKilometers: 0, waitMinutes: 10 },
    );
    expect(out.waitCents).toBe(333);
    expect(out.totalCents).toBe(333);
  });

  it("nutzt Fallback-Sätze nur, wenn die Policy keinen eigenen Wert hat", () => {
    const out = computeNoShowCharge(
      { type: "travel_plus_wait" },
      { travelKilometers: 4, waitMinutes: 60 },
      { kmRateCents: 100, hourlyRateCents: 3000 },
    );
    // 4 km × 100 = 400 ct ; 60/60 × 3000 = 3000 ct → 3400 ct.
    expect(out.travelCents).toBe(400);
    expect(out.waitCents).toBe(3000);
    expect(out.totalCents).toBe(3400);
  });

  it("bevorzugt den Policy-Satz vor dem Fallback", () => {
    const out = computeNoShowCharge(
      { type: "travel_plus_wait", kmRateCents: 10 },
      { travelKilometers: 5, waitMinutes: 0 },
      { kmRateCents: 999 },
    );
    expect(out.travelCents).toBe(50);
  });

  it("lässt die Wartezeit-Beschreibung weg, wenn kein Stundensatz greift", () => {
    const out = computeNoShowCharge(
      { type: "travel_plus_wait", kmRateCents: 50 },
      { travelKilometers: 8, waitMinutes: 0 },
    );
    expect(out.description).toBe("Vergebliche Anfahrt (8,00 km Anfahrt)");
    expect(out.waitCents).toBe(0);
  });

  it("lässt die km-Beschreibung weg, wenn kein km-Satz greift", () => {
    const out = computeNoShowCharge(
      { type: "travel_plus_wait", hourlyRateCents: 1200 },
      { travelKilometers: 8, waitMinutes: 15 },
    );
    expect(out.travelCents).toBe(0);
    expect(out.description).toBe("Vergebliche Anfahrt (15 Min. Wartezeit)");
  });

  it("liefert die generische Beschreibung ohne km und ohne Wartezeit", () => {
    const out = computeNoShowCharge(
      { type: "travel_plus_wait", kmRateCents: 50, hourlyRateCents: 2000 },
      { travelKilometers: 0, waitMinutes: 0 },
    );
    expect(out.totalCents).toBe(0);
    expect(out.description).toBe("Vergebliche Anfahrt");
  });

  it("klemmt negative km und Wartezeit auf 0", () => {
    const out = computeNoShowCharge(
      { type: "travel_plus_wait", kmRateCents: 50, hourlyRateCents: 2000 },
      { travelKilometers: -10, waitMinutes: -30 },
    );
    expect(out.totalCents).toBe(0);
    expect(out.description).toBe("Vergebliche Anfahrt");
  });
});

describe("hasChargeableCancellationPolicy", () => {
  it("ist false nur für Policy 'none'", () => {
    expect(hasChargeableCancellationPolicy({ type: "none" })).toBe(false);
    expect(hasChargeableCancellationPolicy({ type: "flat_amount" })).toBe(true);
    expect(hasChargeableCancellationPolicy({ type: "travel_plus_wait" })).toBe(true);
  });
});
