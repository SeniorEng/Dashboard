import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { apiGet, getAuthCookie } from "../test-utils";
import {
  setupBudgetScenario,
  type BudgetScenarioHandle,
  type BudgetScenarioSpec,
} from "./budget-scenarios";

interface OverviewResponse {
  entlastungsbetrag45b: {
    totalAllocatedCents: number;
    carryoverCents: number;
    carryoverExpiresAt: string | null;
    currentYearAllocatedCents: number;
  };
  umwandlung45a: {
    monthlyBudgetCents: number;
    currentMonthAllocatedCents: number;
  };
  ersatzpflege39_42a: {
    yearlyBudgetCents: number;
    currentYearAllocatedCents: number;
  };
}

describe("budget-scenarios DSL — smoke", () => {
  beforeAll(async () => {
    await getAuthCookie();
  });

  describe("Standard-PG3 mit allen drei Budget-Töpfen aktiv", () => {
    let scenario: BudgetScenarioHandle;
    const spec: BudgetScenarioSpec = {
      customerNamePrefix: "TEST-DSL-Smoke-PG3",
      preferences: { budgetStartDate: "2026-01-01" },
      types: [
        { type: "entlastungsbetrag_45b", enabled: true, priority: 1 },
        { type: "umwandlung_45a", enabled: true, priority: 2 },
        { type: "ersatzpflege_39_42a", enabled: true, priority: 3 },
      ],
    };

    beforeEach(async () => {
      scenario = await setupBudgetScenario(spec);
    });

    afterEach(async () => {
      await scenario.cleanup();
    });

    it("Overview spiegelt PG3-Default-Limits aller drei Töpfe wider", async () => {
      const overview = await apiGet<OverviewResponse>(
        `/api/budget/${scenario.customerId}/overview`,
      );
      expect(overview.status).toBe(200);
      // §45a: PG3-Default = 598,80 € monatlich (40 % von 1.497 €)
      expect(overview.data.umwandlung45a.monthlyBudgetCents).toBe(59880);
      // §39/§42a: gesetzlicher Default = 3.539 €/Jahr
      expect(overview.data.ersatzpflege39_42a.yearlyBudgetCents).toBe(353900);
    });
  });

  describe("PG3 + §45b Carryover 5000 Cent für Vorjahr", () => {
    let scenario: BudgetScenarioHandle;
    const spec: BudgetScenarioSpec = {
      customerNamePrefix: "TEST-DSL-Smoke-Carryover",
      types: [
        { type: "entlastungsbetrag_45b", enabled: true, priority: 1 },
        { type: "umwandlung_45a", enabled: false, priority: 2 },
        { type: "ersatzpflege_39_42a", enabled: false, priority: 3 },
      ],
      carryover: { type: "entlastungsbetrag_45b", amountCents: 5000, year: 2025 },
    };

    beforeEach(async () => {
      scenario = await setupBudgetScenario(spec);
    });

    afterEach(async () => {
      await scenario.cleanup();
    });

    it("Overview enthält Carryover-Anteil mit Juni-Verfallsdatum", async () => {
      const overview = await apiGet<OverviewResponse>(
        `/api/budget/${scenario.customerId}/overview`,
      );
      expect(overview.status).toBe(200);
      expect(overview.data.entlastungsbetrag45b.carryoverCents).toBeGreaterThanOrEqual(5000);
      expect(overview.data.entlastungsbetrag45b.carryoverExpiresAt).toBe("2026-06-30");
    });
  });
});
