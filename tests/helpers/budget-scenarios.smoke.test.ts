import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { apiGet, getAuthCookie } from "../test-utils";
import {
  setupBudgetScenario,
  type BudgetScenarioHandle,
  type BudgetScenarioSpec,
} from "./budget-scenarios";
import { useTestClock } from "./test-clock";

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

// §45b-Präventions-Cluster Welle 1 — Fester Stichtag statt relativem Kalender-Anker. Die Uhr steht für
// Testprozess UND App-Server auf diesem Tag, deshalb sind die Jahreszahlen jetzt
// Literale und driften nicht mehr mit dem Lauftag.
//
// 15.06.2026 ist ein Montag im ERSTEN Halbjahr: der Übertrag aus 2025 gilt an
// diesem Tag noch (er verfällt zum 30.06.2026).
const KLOCK = "2026-06-15";
const SOURCE_YEAR = 2025;
const EXPIRES_AT = "2026-06-30";

describe("budget-scenarios DSL — smoke", () => {
  // `beforeEach`, nicht `beforeAll`: das Sicherheitsnetz in `tests/setup.ts`
  // stellt nach JEDEM Test die Echt-Uhr wieder her.
  beforeEach(() => {
    useTestClock(KLOCK);
  });

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
      carryover: { type: "entlastungsbetrag_45b", amountCents: 5000, year: SOURCE_YEAR },
    };

    beforeEach(async () => {
      scenario = await setupBudgetScenario(spec);
    });

    afterEach(async () => {
      await scenario.cleanup();
    });

    it("Overview enthält Carryover-Anteil mit Juni-Verfallsdatum", async () => {
      // Stichtag EXPLIZIT statt „heute": ein Vorjahres-Uebertrag ist nur bis zum
      // 30.06. des Zieljahres gueltig. Der `?date=`-Parameter bleibt bewusst
      // stehen, obwohl die Uhr denselben Tag zeigt — er haelt die fachliche
      // Aussage („zu DIESEM Stichtag") im Test sichtbar, statt sie in die
      // Uhr-Konfiguration zu verstecken.
      const overview = await apiGet<OverviewResponse>(
        `/api/budget/${scenario.customerId}/overview?date=${KLOCK}`,
      );
      expect(overview.status).toBe(200);
      expect(overview.data.entlastungsbetrag45b.carryoverCents).toBeGreaterThanOrEqual(5000);
      // Die Frist selbst bleibt unangetastet — 30.06. des Zieljahres.
      expect(overview.data.entlastungsbetrag45b.carryoverExpiresAt).toBe(EXPIRES_AT);
    });
  });
});
