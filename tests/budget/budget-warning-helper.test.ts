/**
 * Unit-Tests für buildBudgetWarning(): Cap-Warnung ist date-aware (nur wenn
 * mind. ein Termin im laufenden Monat) und kostenbezogen (Cap-Rest reicht
 * nicht für die geplanten Termine im laufenden Monat).
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
    monthlyLimitCents: 5000,
    currentMonthUsedCents: 5000,
    currentMonthPlannedCents: 4000,
    currentMonthAvailableCents: 0,
    isCurrentlyActive: true,
  };
  return { ...base, ...overrides };
}

function nextMonthDate(): string {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() + 1);
  return d.toISOString().slice(0, 10);
}

function thisMonthDate(): string {
  const d = new Date();
  d.setDate(15);
  return d.toISOString().slice(0, 10);
}

describe("buildBudgetWarning", () => {
  it("feuert Cap-Warnung wenn Cap erschöpft (=0) und Planung im laufenden Monat", () => {
    const w = buildBudgetWarning(summary({}), { appointmentDates: [thisMonthDate()] });
    expect(w).toContain("Monats-Cap §45b");
    expect(w).toContain("erreicht");
  });

  it("feuert Cap-Warnung wenn Cap-Rest > 0 aber für Planung nicht reicht", () => {
    const w = buildBudgetWarning(
      summary({ currentMonthAvailableCents: 1200, currentMonthPlannedCents: 4000 }),
      { appointmentDates: [thisMonthDate()] },
    );
    expect(w).toContain("Monats-Cap §45b");
    expect(w).toContain("noch 12,00 € buchbar");
  });

  it("KEINE Cap-Warnung wenn Cap-Rest für Planung reicht", () => {
    const w = buildBudgetWarning(
      summary({ currentMonthAvailableCents: 5000, currentMonthPlannedCents: 4000 }),
      { appointmentDates: [thisMonthDate()] },
    );
    expect(w).toBeNull();
  });

  it("unterdrückt Cap-Warnung wenn alle Termine im Folgemonat liegen", () => {
    const w = buildBudgetWarning(summary({}), { appointmentDates: [nextMonthDate()] });
    expect(w).toBeNull();
  });

  it("ohne appointmentDates konservativ: Warnung wenn Cap-Shortfall besteht", () => {
    const w = buildBudgetWarning(summary({}));
    expect(w).toContain("Monats-Cap §45b");
  });

  it("Topf-Engpass-Teil bleibt unabhängig vom Termin-Datum bestehen", () => {
    const w = buildBudgetWarning(
      summary({
        availableAfterPlannedCents: -2500,
        currentMonthAvailableCents: 5000,
        currentMonthPlannedCents: 4000,
      }),
      { appointmentDates: [nextMonthDate()] },
    );
    expect(w).toContain("übersteigen §45b");
    expect(w).not.toContain("Monats-Cap");
  });

  it("ohne Cap (monthlyLimitCents=null) keine Cap-Warnung", () => {
    const w = buildBudgetWarning(
      summary({ monthlyLimitCents: null, currentMonthAvailableCents: 0, currentMonthPlannedCents: 5000 }),
      { appointmentDates: [thisMonthDate()] },
    );
    expect(w).toBeNull();
  });
});
