/**
 * Task #954 — §45a statutorischer Default-Cap: Anzeige == Buchung.
 *
 * Bug: §45a Umwandlungsanspruch wurde in der Budget-Overview mit 0 angezeigt,
 * sobald ein anspruchsberechtigter Kunde (Pflegegrad ≥ 2) §45a aktiviert, aber
 * KEINEN expliziten `monthlyLimitCents` hinterlegt hatte. Der gesetzliche
 * Default (Umwandlungsanspruch nach Pflegegrad) muss greifen.
 *
 * Drift-Garantie: Der Default fließt durch den Cap-SSoT
 * (`resolve45aMonthlyLimitCents` → `computeCapRemaining` + `getCustomerBudgetAmounts`),
 * damit Overview (Anzeige) und Cost-Estimate/Cascade (Buchung) denselben Wert
 * sehen — kein „Anzeige vs. Buchung"-Drift. Genau das prüfen die Tests, indem
 * sie `overview.umwandlung45a.currentMonthAvailableCents` 1:1 gegen
 * `cost-estimate.availableCents` stellen.
 *
 * Done-Kriterien:
 *  - PG2 defaulted: ohne expliziten Wert greift der statutorische Default.
 *  - Explicit-Override: ein expliziter Wert hat Vorrang vor dem Default.
 * (PG<2-inaktiv wird im reinen Resolver-Unit-Test abgedeckt — der API-Pfad
 *  lehnt §45a-Aktivierung für PG<2 grundsätzlich mit 400 ab.)
 */
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { apiGet, getAuthCookie, runCleanup } from "../test-utils";
import {
  setupBudgetScenario,
  type BudgetScenarioHandle,
} from "../helpers/budget-scenarios";
import { BUDGET_45A_MAX_BY_PFLEGEGRAD } from "@shared/domain/budgets";

beforeAll(async () => {
  await getAuthCookie();
});

afterAll(async () => {
  await runCleanup();
});

interface OverviewResponse {
  umwandlung45a: {
    currentMonthAvailableCents: number;
    currentMonthAllocatedCents: number;
    currentMonthUsedCents: number;
    monthlyLimitCents: number | null;
    isCurrentlyActive: boolean;
  };
}

interface CostEstimateResponse {
  availableCents: number;
  isHardBlock: boolean;
}

function firstOfCurrentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
}

describe("Equality §45a statutorischer Default (Task #954)", () => {
  it("PG2 defaulted: §45a aktiviert ohne expliziten monthlyLimit ⇒ Overview UND Cost-Estimate zeigen statutorischen PG2-Cap", async () => {
    const pflegegrad = 2;
    const statutory = BUDGET_45A_MAX_BY_PFLEGEGRAD[pflegegrad];
    expect(statutory).toBeGreaterThan(0);

    const scenario: BudgetScenarioHandle = await setupBudgetScenario({
      customerNamePrefix: "T954-45A-DEFAULT",
      pflegegrad,
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: false,
      preferences: { budgetStartDate: firstOfCurrentMonth() },
      types: [
        { type: "entlastungsbetrag_45b", priority: 1, enabled: false },
        // monthlyLimitCents EXPLIZIT null = aktiviert, aber unkonfiguriert.
        // (undefined würde vom Helper auf den PG-Default vorbefüllt — das
        //  würde genau den zu testenden Default-Pfad umgehen.)
        { type: "umwandlung_45a", priority: 2, enabled: true, monthlyLimitCents: null },
        { type: "ersatzpflege_39_42a", priority: 3, enabled: false },
      ],
      appointments: [],
    });
    try {
      const overview = await apiGet<OverviewResponse>(
        `/api/budget/${scenario.customerId}/overview`,
      );
      expect(overview.status).toBe(200);
      const v = overview.data.umwandlung45a;

      expect(v.isCurrentlyActive).toBe(true);
      // Kern des Bugfixes: ohne expliziten Wert NICHT mehr 0, sondern der
      // gesetzliche Umwandlungsanspruch nach Pflegegrad.
      expect(
        v.currentMonthAllocatedCents,
        `§45a currentMonthAllocated=${v.currentMonthAllocatedCents}, erwartet statutorischer PG${pflegegrad}-Default ${statutory}`,
      ).toBe(statutory);
      expect(v.currentMonthUsedCents).toBe(0);
      expect(v.currentMonthAvailableCents).toBe(statutory);

      // Anzeige == Buchung: der Buchungspfad (Cost-Estimate → Cascade →
      // computeCapRemaining) muss exakt denselben Default sehen.
      const today = new Date().toISOString().slice(0, 10);
      const estimate = await apiGet<CostEstimateResponse>(
        `/api/budget/${scenario.customerId}/cost-estimate?date=${today}` +
          `&hauswirtschaftMinutes=60&alltagsbegleitungMinutes=0&travelKilometers=0&customerKilometers=0`,
      );
      expect(estimate.status).toBe(200);
      expect(
        estimate.data.availableCents,
        `Cost-Estimate availableCents=${estimate.data.availableCents} muss der Overview ` +
          `currentMonthAvailable=${v.currentMonthAvailableCents} entsprechen (kein Anzeige-vs-Buchung-Drift).`,
      ).toBe(v.currentMonthAvailableCents);
      // Ein 60-min-HW-Termin passt locker in den Default-Cap → kein Hard-Block.
      expect(estimate.data.isHardBlock).toBe(false);
    } finally {
      await scenario.cleanup();
    }
  }, 120_000);

  it("Explicit-Override: expliziter monthlyLimit < Default ⇒ Overview UND Cost-Estimate nutzen den expliziten Wert, nicht den Default", async () => {
    const pflegegrad = 2;
    const statutory = BUDGET_45A_MAX_BY_PFLEGEGRAD[pflegegrad];
    const explicit = 20000; // 200 € — bewusst unter dem statutorischen PG2-Default
    expect(explicit).toBeLessThan(statutory);

    const scenario: BudgetScenarioHandle = await setupBudgetScenario({
      customerNamePrefix: "T954-45A-OVERRIDE",
      pflegegrad,
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: false,
      preferences: { budgetStartDate: firstOfCurrentMonth() },
      types: [
        { type: "entlastungsbetrag_45b", priority: 1, enabled: false },
        { type: "umwandlung_45a", priority: 2, enabled: true, monthlyLimitCents: explicit },
        { type: "ersatzpflege_39_42a", priority: 3, enabled: false },
      ],
      appointments: [],
    });
    try {
      const overview = await apiGet<OverviewResponse>(
        `/api/budget/${scenario.customerId}/overview`,
      );
      expect(overview.status).toBe(200);
      const v = overview.data.umwandlung45a;

      expect(v.isCurrentlyActive).toBe(true);
      // Override gewinnt: NICHT der statutorische Default.
      expect(
        v.currentMonthAllocatedCents,
        `§45a currentMonthAllocated=${v.currentMonthAllocatedCents}, erwartet expliziter Override ${explicit} (nicht Default ${statutory})`,
      ).toBe(explicit);
      expect(v.currentMonthAvailableCents).toBe(explicit);
      expect(v.currentMonthAvailableCents).not.toBe(statutory);

      const today = new Date().toISOString().slice(0, 10);
      const estimate = await apiGet<CostEstimateResponse>(
        `/api/budget/${scenario.customerId}/cost-estimate?date=${today}` +
          `&hauswirtschaftMinutes=60&alltagsbegleitungMinutes=0&travelKilometers=0&customerKilometers=0`,
      );
      expect(estimate.status).toBe(200);
      expect(
        estimate.data.availableCents,
        `Cost-Estimate availableCents=${estimate.data.availableCents} muss dem expliziten ` +
          `Override (Overview currentMonthAvailable=${v.currentMonthAvailableCents}) entsprechen.`,
      ).toBe(v.currentMonthAvailableCents);
    } finally {
      await scenario.cleanup();
    }
  }, 120_000);
});
