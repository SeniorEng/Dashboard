/**
 * Task #954 — §45a statutorischer Default-Cap nach Pflegegrad (SSoT-Resolver).
 *
 * `resolve45aMonthlyLimitCents` ist die Single Source of Truth für den
 * effektiven §45a-Monats-Cap. Sowohl die Cap-Mathematik (`computeCapRemaining`)
 * als auch der Allokations-Pfad (`getCustomerBudgetAmounts`) rufen denselben
 * Resolver, damit Anzeige (Overview) und Buchung (Cascade) identisch defaulten.
 *
 * Drei Branches (entsprechend den Done-Kriterien):
 *  1. PG≥2 ohne expliziten Wert → gesetzlicher Default (Umwandlungsanspruch).
 *  2. Expliziter Wert → Override, unabhängig vom Pflegegrad.
 *  3. PG<2 ohne expliziten Wert → null (kein Anspruch, kein Cap-Beitrag).
 */
import { describe, it, expect } from "vitest";
import {
  resolve45aMonthlyLimitCents,
  BUDGET_45A_MAX_BY_PFLEGEGRAD,
} from "@shared/domain/budgets";

describe("resolve45aMonthlyLimitCents (Task #954)", () => {
  describe("PG≥2 ohne expliziten Wert → statutorischer Default", () => {
    for (const pg of [2, 3, 4, 5] as const) {
      it(`PG${pg}: null → BUDGET_45A_MAX_BY_PFLEGEGRAD[${pg}]`, () => {
        const expected = BUDGET_45A_MAX_BY_PFLEGEGRAD[pg];
        expect(expected).toBeGreaterThan(0);
        expect(resolve45aMonthlyLimitCents(null, pg)).toBe(expected);
        expect(resolve45aMonthlyLimitCents(undefined, pg)).toBe(expected);
      });
    }
  });

  describe("Expliziter Wert → Override (gewinnt immer)", () => {
    it("PG2 + expliziter Wert unter Default → exakt der explizite Wert", () => {
      const explicit = 20000;
      expect(explicit).toBeLessThan(BUDGET_45A_MAX_BY_PFLEGEGRAD[2]);
      expect(resolve45aMonthlyLimitCents(explicit, 2)).toBe(explicit);
    });
    it("PG2 + expliziter Wert über Default → roher Override (Clamp ist Aufgabe von clampToStatutoryMax)", () => {
      const explicit = BUDGET_45A_MAX_BY_PFLEGEGRAD[2] + 100_00;
      expect(resolve45aMonthlyLimitCents(explicit, 2)).toBe(explicit);
    });
    it("Expliziter Wert 0 → 0 (kein Fallthrough auf Default)", () => {
      expect(resolve45aMonthlyLimitCents(0, 2)).toBe(0);
      expect(resolve45aMonthlyLimitCents(0, 3)).toBe(0);
    });
    it("Expliziter Wert auch bei PG<2 → Override durchgereicht", () => {
      expect(resolve45aMonthlyLimitCents(15000, 1)).toBe(15000);
    });
  });

  describe("PG<2 ohne expliziten Wert → null (inaktiv, kein Default)", () => {
    it("PG1 + null → null", () => {
      expect(resolve45aMonthlyLimitCents(null, 1)).toBeNull();
    });
    it("PG0 / kein Pflegegrad + null → null", () => {
      expect(resolve45aMonthlyLimitCents(null, 0)).toBeNull();
      expect(resolve45aMonthlyLimitCents(null, null)).toBeNull();
    });
  });
});
