/**
 * Phase-1.2-Drift-Folge — §45a Overview-Header darf NIE mehr „verfügbar"
 * zeigen, als laut statutorischem Pflegegrad-Cap tatsächlich buchbar wäre.
 *
 * Vor der computeCapSlot-Umstellung (siehe `docs/budget-ssot-inventory.md`
 * Drift Nr. 6) rechnete `getBudgetSummary45a` ihre eigene Window-Net-Mathe:
 * `currentMonthAvailable = currentMonthAllocated - currentMonthUsed`. Wenn
 * `monthlyLimitCents` in `customer_budget_type_settings` über dem gesetzlichen
 * Maximum lag (z.B. fehlerhafter Backfill, manueller SQL-Eingriff), zeigte
 * die Overview einen Wert, den der Buchungspfad anschließend gar nicht buchen
 * konnte — der `computeCapSlot`-Pfad in `createCascadeConsumption` klemmt
 * gegen `BUDGET_45A_MAX_BY_PFLEGEGRAD`.
 *
 * Test pflanzt PG2 + monthlyLimit deutlich über dem gesetzlichen Max
 * (PG2 = 12,40 €/Mo statutorisch, hier 100 € als Override) und erwartet,
 * dass der Overview-Header NICHT den überhöhten Wert zeigt, sondern auf
 * den statutorischen Cap herunterklemmt.
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
    currentMonthUsedCents: number;
    currentMonthAllocatedCents: number;
    isCurrentlyActive: boolean;
  };
}

describe("Equality §45a Overview — statutorischer Cap greift in der Anzeige", () => {
  it("monthlyLimit > BUDGET_45A_MAX_BY_PFLEGEGRAD ⇒ Overview-currentMonthAvailable ≤ statutorischer Cap", async () => {
    const now = new Date();
    const firstOfMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
    const pflegegrad = 2;
    const statutoryMax = BUDGET_45A_MAX_BY_PFLEGEGRAD[pflegegrad] ?? 0;
    // Bewusst über dem gesetzlichen Max: simuliert verunreinigte Settings-Daten.
    const overshootMonthlyLimit = statutoryMax + 100_00; // +100 €

    const scenario: BudgetScenarioHandle = await setupBudgetScenario({
      customerNamePrefix: "PHASE12-45A-CLAMP",
      pflegegrad,
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: false,
      pflegegradSeit: firstOfMonth,
      types: [
        { type: "entlastungsbetrag_45b", priority: 1, enabled: false },
        { type: "umwandlung_45a", priority: 2, enabled: true, monthlyLimitCents: overshootMonthlyLimit },
        { type: "ersatzpflege_39_42a", priority: 3, enabled: false },
      ],
      appointments: [],
    });
    try {
      const overview = await apiGet<OverviewResponse>(
        `/api/budget/${scenario.customerId}/overview`,
      );
      const v = overview.data.umwandlung45a;
      expect(v.isCurrentlyActive).toBe(true);
      expect(
        v.currentMonthAvailableCents,
        `Overview-currentMonthAvailable=${v.currentMonthAvailableCents} darf den ` +
          `statutorischen PG${pflegegrad}-Cap (${statutoryMax} ct) nicht überschreiten, ` +
          `auch wenn monthlyLimit=${overshootMonthlyLimit} ct in den Settings hinterlegt ist. ` +
          `Sonst driftet die Anzeige vom Buchungs-Cap (createCascadeConsumption → computeCapSlot).`,
      ).toBeLessThanOrEqual(statutoryMax);
    } finally {
      await scenario.cleanup();
    }
  }, 120_000);
});
