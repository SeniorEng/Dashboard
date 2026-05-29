/**
 * Pure-Unit-Tests für `computeCapRemaining` (`shared/domain/budget/cap-math.ts`).
 *
 * Diese Tests laufen OHNE DB/Server und sind daher Teil der Stryker-
 * Mutation-Testing-Suite (Task #770). Sie decken alle drei Topf-Zweige
 * (§45b Jahrestopf, §45a Monats-Cap inkl. Carryover + Pflegegrad-Clamp,
 * §39/§42a Jahres-Cap) sowie die Statutory-Clamp-Grenzen ab.
 */
// @ts-nocheck

import { describe, it, expect } from "vitest";
import { computeCapRemaining } from "@shared/domain/budget/cap-math";
import {
  BUDGET_45B_MAX_MONTHLY_CENTS,
  BUDGET_39_42A_MAX_YEARLY_CENTS,
  BUDGET_45A_MAX_BY_PFLEGEGRAD,
} from "@shared/domain/budgets";

describe("computeCapRemaining — §45b (Jahrestopf, kein Fenster-Cap)", () => {
  it("liefert immer POSITIVE_INFINITY als capRemaining", () => {
    const out = computeCapRemaining({
      budgetType: "entlastungsbetrag_45b",
      pflegegrad: 3,
      monthlyLimitCents: 13100,
      yearlyLimitCents: null,
      carryoverCents: 5000,
      netUsedInWindowCents: 9999,
    });
    expect(out.capRemainingCents).toBe(Number.POSITIVE_INFINITY);
  });

  it("klemmt das Monatslimit auf den gesetzlichen Maximalwert", () => {
    const out = computeCapRemaining({
      budgetType: "entlastungsbetrag_45b",
      pflegegrad: 3,
      monthlyLimitCents: 20000, // über 131€
      yearlyLimitCents: null,
      carryoverCents: 0,
      netUsedInWindowCents: 0,
    });
    expect(out.clampedMonthlyLimitCents).toBe(BUDGET_45B_MAX_MONTHLY_CENTS);
  });
});

describe("computeCapRemaining — §39/§42a (Jahres-Cap)", () => {
  it("rechnet yearlyLimit − netUsed", () => {
    const out = computeCapRemaining({
      budgetType: "ersatzpflege_39_42a",
      pflegegrad: null,
      monthlyLimitCents: null,
      yearlyLimitCents: 100000,
      carryoverCents: 0,
      netUsedInWindowCents: 30000,
    });
    expect(out.capRemainingCents).toBe(70000);
  });

  it("clamped auf gesetzlichen Jahres-Höchstwert und nie negativ", () => {
    const out = computeCapRemaining({
      budgetType: "ersatzpflege_39_42a",
      pflegegrad: null,
      monthlyLimitCents: null,
      yearlyLimitCents: 9_999_999, // über gesetzlichem Max
      carryoverCents: 0,
      netUsedInWindowCents: BUDGET_39_42A_MAX_YEARLY_CENTS + 50000,
    });
    expect(out.clampedYearlyLimitCents).toBe(BUDGET_39_42A_MAX_YEARLY_CENTS);
    expect(out.capRemainingCents).toBe(0);
  });

  it("liefert POSITIVE_INFINITY wenn kein Jahreslimit gesetzt ist", () => {
    const out = computeCapRemaining({
      budgetType: "ersatzpflege_39_42a",
      pflegegrad: null,
      monthlyLimitCents: null,
      yearlyLimitCents: null,
      carryoverCents: 0,
      netUsedInWindowCents: 12345,
    });
    expect(out.capRemainingCents).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("computeCapRemaining — §45a (Monats-Cap + Carryover + Pflegegrad)", () => {
  it("rechnet (monthlyLimit + carryover) − netUsed", () => {
    const out = computeCapRemaining({
      budgetType: "umwandlung_45a",
      pflegegrad: 5,
      monthlyLimitCents: 10000,
      yearlyLimitCents: null,
      carryoverCents: 2000,
      netUsedInWindowCents: 3000,
    });
    expect(out.capRemainingCents).toBe(9000);
  });

  it("klemmt das Monatslimit auf den Pflegegrad-Höchstwert", () => {
    const out = computeCapRemaining({
      budgetType: "umwandlung_45a",
      pflegegrad: 2,
      monthlyLimitCents: 999_999, // über PG2-Max
      yearlyLimitCents: null,
      carryoverCents: 0,
      netUsedInWindowCents: 0,
    });
    expect(out.clampedMonthlyLimitCents).toBe(BUDGET_45A_MAX_BY_PFLEGEGRAD[2]);
    expect(out.capRemainingCents).toBe(BUDGET_45A_MAX_BY_PFLEGEGRAD[2]);
  });

  it("Pflegegrad 1 ist nicht anspruchsberechtigt → Cap 0", () => {
    const out = computeCapRemaining({
      budgetType: "umwandlung_45a",
      pflegegrad: 1,
      monthlyLimitCents: 50000,
      yearlyLimitCents: null,
      carryoverCents: 0,
      netUsedInWindowCents: 0,
    });
    expect(out.clampedMonthlyLimitCents).toBe(0);
    expect(out.capRemainingCents).toBe(0);
  });

  it("capRemaining wird bei Überverbrauch auf 0 geklemmt (nie negativ)", () => {
    const out = computeCapRemaining({
      budgetType: "umwandlung_45a",
      pflegegrad: 4,
      monthlyLimitCents: 10000,
      yearlyLimitCents: null,
      carryoverCents: 0,
      netUsedInWindowCents: 50000,
    });
    expect(out.capRemainingCents).toBe(0);
  });

  it("liefert POSITIVE_INFINITY wenn kein Monatslimit gesetzt ist", () => {
    const out = computeCapRemaining({
      budgetType: "umwandlung_45a",
      pflegegrad: 5,
      monthlyLimitCents: null,
      yearlyLimitCents: null,
      carryoverCents: 0,
      netUsedInWindowCents: 0,
    });
    expect(out.capRemainingCents).toBe(Number.POSITIVE_INFINITY);
  });
});
