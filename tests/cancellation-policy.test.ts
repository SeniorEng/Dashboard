import { describe, it, expect } from "vitest";
import { computeNoShowCharge, hasChargeableCancellationPolicy } from "../shared/domain/cancellation-policy";

describe("Task #485 — computeNoShowCharge", () => {
  it("Policy 'none' → 0 Cent, egal welche Anfahrt/Wartezeit", () => {
    const out = computeNoShowCharge(
      { type: "none" },
      { travelKilometers: 25, waitMinutes: 90 },
    );
    expect(out.totalCents).toBe(0);
    expect(hasChargeableCancellationPolicy({ type: "none" })).toBe(false);
  });

  it("Policy 'flat_amount' → liefert genau die Pauschale (z.B. 25,00 €)", () => {
    const out = computeNoShowCharge(
      { type: "flat_amount", flatCents: 2500 },
      { travelKilometers: 99, waitMinutes: 99 },
    );
    expect(out.totalCents).toBe(2500);
    expect(out.flatCents).toBe(2500);
    expect(out.travelCents).toBe(0);
    expect(out.waitCents).toBe(0);
  });

  it("Policy 'travel_plus_wait' → km*Satz + Min/60*Stundensatz", () => {
    const out = computeNoShowCharge(
      { type: "travel_plus_wait", kmRateCents: 50, hourlyRateCents: 3000 },
      { travelKilometers: 10, waitMinutes: 30 },
    );
    // 10 km * 0,50 € = 5,00 €  +  0,5 h * 30,00 € = 15,00 €  → 20,00 €
    expect(out.travelCents).toBe(500);
    expect(out.waitCents).toBe(1500);
    expect(out.totalCents).toBe(2000);
  });

  it("Policy 'travel_plus_wait' nutzt Fallback-Sätze, wenn Kunde keine eigenen hat", () => {
    const out = computeNoShowCharge(
      { type: "travel_plus_wait", kmRateCents: null, hourlyRateCents: null },
      { travelKilometers: 4, waitMinutes: 60 },
      { kmRateCents: 35, hourlyRateCents: 2400 },
    );
    expect(out.travelCents).toBe(140); // 4 * 35
    expect(out.waitCents).toBe(2400);  // 1h * 24€
    expect(out.totalCents).toBe(2540);
  });

  it("Negative Eingaben werden auf 0 geklemmt — niemals negative Charges", () => {
    const out = computeNoShowCharge(
      { type: "travel_plus_wait", kmRateCents: 50, hourlyRateCents: 3000 },
      { travelKilometers: -10, waitMinutes: -30 },
    );
    expect(out.totalCents).toBe(0);
  });
});
