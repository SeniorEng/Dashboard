/**
 * Task #425 — §45b ist seit der Umstellung auf das Jahrestopf-Modell ohne
 * Monats-Cap. `buildBudgetWarning` reduziert sich daher auf den
 * Pot-Erschöpfungs-Hinweis (`availableAfterPlannedCents < 0`).
 */
import { describe, it, expect } from "vitest";
import { buildBudgetWarning } from "../../server/lib/budget-warning";
import type { BudgetSummary } from "../../server/storage/budget/types";

function summary(overrides: Partial<BudgetSummary>): BudgetSummary {
  const base: BudgetSummary = {
    customerId: 1,
    totalAllocatedCents: 50000,
    totalUsedCents: 3800,
    availableCents: 46200,
    plannedCents: 0,
    availableAfterPlannedCents: 46200,
    carryoverCents: 0,
    carryoverExpiresAt: null,
    currentYearAllocatedCents: 50000,
    monthlyLimitCents: null,
    currentMonthUsedCents: 5000,
    currentMonthPlannedCents: 4000,
    currentMonthAvailableCents: 46200,
    isCurrentlyActive: true,
  };
  return { ...base, ...overrides };
}

function thisMonthDate(): string {
  const d = new Date();
  d.setDate(15);
  return d.toISOString().slice(0, 10);
}

function nextMonthDate(): string {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() + 1);
  return d.toISOString().slice(0, 10);
}

describe("buildBudgetWarning (Task #425 — §45b Jahrestopf)", () => {
  it("liefert null wenn Topf nicht erschöpft", () => {
    const w = buildBudgetWarning(summary({}));
    expect(w).toBeNull();
  });

  it("warnt bei Topf-Erschöpfung (availableAfterPlannedCents < 0)", () => {
    const w = buildBudgetWarning(summary({ availableAfterPlannedCents: -2500 }));
    expect(w).toContain("übersteigen §45b");
    // `Intl.NumberFormat("de-DE", { style: "currency" })` trennt Zahl und €
    // mit einem NARROW NO-BREAK SPACE (U+202F); Test akzeptiert auch
    // gewöhnlichen Space / NBSP, falls die Runtime das mal anders normalisiert.
    expect(w).toMatch(/25,00[\s\u202F\u00A0]€/);
  });

  it("erzeugt KEINE Cap-Warnung mehr, auch wenn currentMonth-Felder knapp sind", () => {
    // Vor Task #425 hätte das hier eine "Monats-Cap erreicht"-Warnung erzeugt;
    // mit dem Jahrestopf-Modell ist diese Logik entfernt.
    const w = buildBudgetWarning(
      summary({
        currentMonthAvailableCents: 0,
        currentMonthPlannedCents: 4000,
        availableAfterPlannedCents: 100,
      }),
      { appointmentDates: [thisMonthDate()] },
    );
    expect(w).toBeNull();
  });

  it("ignoriert appointmentDates (keine Cap-Date-Logik mehr)", () => {
    const w = buildBudgetWarning(summary({}), { appointmentDates: [nextMonthDate()] });
    expect(w).toBeNull();
  });

  it("erwähnt §45b im Topf-Erschöpfungs-Hinweis (Wording-Stabilität)", () => {
    const w = buildBudgetWarning(summary({ availableAfterPlannedCents: -100 }));
    expect(w).toMatch(/Achtung/);
    expect(w).toContain("§45b");
    expect(w).not.toContain("Monats-Cap");
  });
});
