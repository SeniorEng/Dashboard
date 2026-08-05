import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { apiGet, getAuthCookie } from "../test-utils";
import {
  setupBudgetScenario,
  type BudgetScenarioHandle,
  type BudgetScenarioSpec,
} from "./budget-scenarios";
import { carryoverAnchor } from "./billing-month";

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

// Relativer Kalender-Anker statt hartkodierter Jahreszahlen (2025/2026).
const ANCHOR = carryoverAnchor();

describe("budget-scenarios DSL — smoke", () => {
  beforeAll(async () => {
    await getAuthCookie();
  });

  describe("Standard-PG3 mit allen drei Budget-Töpfen aktiv", () => {
    let scenario: BudgetScenarioHandle;
    const spec: BudgetScenarioSpec = {
      customerNamePrefix: "TEST-DSL-Smoke-PG3",
      pflegegradSeit: "2026-01-01",
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
      carryover: { type: "entlastungsbetrag_45b", amountCents: 5000, year: ANCHOR.sourceYear },
    };

    beforeEach(async () => {
      scenario = await setupBudgetScenario(spec);
    });

    afterEach(async () => {
      await scenario.cleanup();
    });

    it("Overview enthält Carryover-Anteil mit Juni-Verfallsdatum", async () => {
      // Stichtag EXPLIZIT statt „heute": ein Vorjahres-Uebertrag ist nur bis zum
      // 30.06. des Zieljahres gueltig. Ohne `?date=` liest der Test gegen den
      // Lauftag und behauptet damit stillschweigend, wir befaenden uns im ersten
      // Halbjahr — ab dem 01.07. ist der Uebertrag KORREKT verfallen und der Test
      // kippt, ohne dass sich Produktivcode geaendert haette.
      const overview = await apiGet<OverviewResponse>(
        `/api/budget/${scenario.customerId}/overview?date=${ANCHOR.asOf}`,
      );
      expect(overview.status).toBe(200);
      expect(overview.data.entlastungsbetrag45b.carryoverCents).toBeGreaterThanOrEqual(5000);
      // Die Frist selbst bleibt unangetastet — sie wird weiterhin auf den 30.06.
      // des Zieljahres gepinnt, nur relativ statt als Literal.
      expect(overview.data.entlastungsbetrag45b.carryoverExpiresAt).toBe(ANCHOR.expiresAt);
    });
  });
});
