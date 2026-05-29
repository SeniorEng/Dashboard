/**
 * §39_42a Overview-Header darf NIE mehr „verfügbar" ausweisen, als gemäß
 * dem statutorischen Jahres-Cap (`BUDGET_39_42A_MAX_YEARLY_CENTS`) buchbar
 * wäre. Symmetrisch zum §45a-Pendant — wenn `yearlyLimitCents` in
 * `customer_budget_type_settings` über dem gesetzlichen Maximum liegt
 * (verunreinigte Settings-Daten), klemmt der Buchungspfad
 * (`createCascadeConsumption → computeCapSlot`), die Anzeige musste das
 * vorher selbst nicht. Jetzt rechnen beide Pfade gegen dieselbe SSoT.
 */
// @ts-nocheck

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { apiGet, getAuthCookie, runCleanup } from "../test-utils";
import {
  setupBudgetScenario,
  type BudgetScenarioHandle,
} from "../helpers/budget-scenarios";
import { BUDGET_39_42A_MAX_YEARLY_CENTS } from "@shared/domain/budgets";

beforeAll(async () => {
  await getAuthCookie();
});

afterAll(async () => {
  await runCleanup();
});

interface OverviewResponse {
  ersatzpflege39_42a: {
    currentYearAvailableCents: number;
    currentYearUsedCents: number;
    currentYearAllocatedCents: number;
  };
}

describe("Equality §39_42a Overview — statutorischer Jahres-Cap greift in der Anzeige", () => {
  it("yearlyLimit > BUDGET_39_42A_MAX_YEARLY_CENTS ⇒ Overview-currentYearAvailable ≤ statutorischer Jahres-Cap", async () => {
    const now = new Date();
    const firstOfYear = `${now.getFullYear()}-01-01`;
    const overshootYearlyLimit = BUDGET_39_42A_MAX_YEARLY_CENTS + 500_00; // +500 €

    const scenario: BudgetScenarioHandle = await setupBudgetScenario({
      customerNamePrefix: "EQUAL-3942A-CLAMP",
      pflegegrad: 2,
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: false,
      preferences: { budgetStartDate: firstOfYear },
      types: [
        { type: "entlastungsbetrag_45b", priority: 1, enabled: false },
        { type: "umwandlung_45a", priority: 2, enabled: false },
        {
          type: "ersatzpflege_39_42a",
          priority: 3,
          enabled: true,
          yearlyLimitCents: overshootYearlyLimit,
        },
      ],
      appointments: [],
    });
    try {
      const overview = await apiGet<OverviewResponse>(
        `/api/budget/${scenario.customerId}/overview`,
      );
      const v = overview.data.ersatzpflege39_42a;
      expect(
        v.currentYearAvailableCents,
        `Overview-currentYearAvailable=${v.currentYearAvailableCents} darf den ` +
          `statutorischen Jahres-Cap (${BUDGET_39_42A_MAX_YEARLY_CENTS} ct) nicht überschreiten, ` +
          `auch wenn yearlyLimit=${overshootYearlyLimit} ct in den Settings hinterlegt ist.`,
      ).toBeLessThanOrEqual(BUDGET_39_42A_MAX_YEARLY_CENTS);
    } finally {
      await scenario.cleanup();
    }
  }, 120_000);
});
