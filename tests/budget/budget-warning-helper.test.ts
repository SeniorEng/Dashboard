/**
 * Task #423 — Unit-Tests für buildBudgetWarning(): die Cap-Warnung darf
 * nur dann ausgelöst werden, wenn mindestens einer der gerade angelegten
 * Termine im laufenden Monat liegt. Sonst entsteht eine irreführende
 * "Cap erreicht"-Meldung obwohl im Folgemonat genug Budget vorhanden ist.
 */
import { describe, it, expect } from "vitest";
import { buildBudgetWarning } from "../../server/lib/budget-warning";
import type { BudgetSummary } from "../../server/storage/budget/types";

function summary(overrides: Partial<BudgetSummary>): BudgetSummary {
  const base: BudgetSummary = {
    type: "entlastungsbetrag_45b",
    initialBalanceCents: 50000,
    usedCents: 3800,
    plannedCents: 0,
    availableCents: 46200,
    availableAfterPlannedCents: 46200,
    monthlyLimitCents: 5000,
    carryoverCents: 0,
    currentMonthUsedCents: 5000,
    currentMonthAvailableCents: 0,
    currentYearAvailableCents: 46200,
  } as BudgetSummary;
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

describe("buildBudgetWarning — Date-Awareness", () => {
  it("feuert Cap-Warnung wenn Termin im laufenden Monat liegt", () => {
    const w = buildBudgetWarning(summary({}), { appointmentDates: [thisMonthDate()] });
    expect(w).toContain("Monats-Cap §45b");
    expect(w).toContain("erreicht");
  });

  it("unterdrückt Cap-Warnung wenn alle Termine im Folgemonat liegen", () => {
    const w = buildBudgetWarning(summary({}), { appointmentDates: [nextMonthDate()] });
    expect(w).toBeNull();
  });

  it("feuert Cap-Warnung wenn mindestens ein Termin im laufenden Monat liegt", () => {
    const w = buildBudgetWarning(summary({}), {
      appointmentDates: [nextMonthDate(), thisMonthDate()],
    });
    expect(w).toContain("Monats-Cap §45b");
  });

  it("ohne appointmentDates fällt zurück auf konservatives Verhalten (Warnung)", () => {
    const w = buildBudgetWarning(summary({}));
    expect(w).toContain("Monats-Cap §45b");
  });

  it("Topf-Engpass-Teil bleibt unabhängig vom Termin-Datum bestehen", () => {
    const w = buildBudgetWarning(
      summary({ availableAfterPlannedCents: -2500, currentMonthAvailableCents: 1000 }),
      { appointmentDates: [nextMonthDate()] },
    );
    expect(w).toContain("übersteigen §45b");
    expect(w).not.toContain("Monats-Cap");
  });

  it("ohne Cap (monthlyLimitCents=null) keine Cap-Warnung", () => {
    const w = buildBudgetWarning(
      summary({ monthlyLimitCents: null, currentMonthAvailableCents: 0 }),
      { appointmentDates: [thisMonthDate()] },
    );
    expect(w).toBeNull();
  });
});
