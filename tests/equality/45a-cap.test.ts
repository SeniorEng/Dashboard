/**
 * Task #705 — Equality §45a: initial_balance + monthlyLimitCents Dedup.
 *
 * Reproducer aus Bug-Report 2026-05-27: §45a wird mit monatlich 743,60 €
 * (`monthlyLimitCents`) konfiguriert UND zusätzlich ein initial_balance
 * von 743,60 € für den laufenden Monat angelegt. Erwartet wird der
 * tatsächliche Monatsbetrag (= 743,60 €, NICHT 1.487,20 €) — der
 * initial_balance REPRÄSENTIERT die Monats-Aufstockung, nicht zusätzlich
 * zu ihr (`calculateAllocated45a` muss den IB-Monat skippen).
 */
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { apiGet, getAuthCookie, runCleanup } from "../test-utils";
import {
  setupBudgetScenario,
  type BudgetScenarioHandle,
} from "../helpers/budget-scenarios";

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
  };
}

describe("Equality §45a — initial_balance + monthlyLimitCents Dedup (Task #705)", () => {
  it("§45a Monats-IB 743,60 € + monthlyLimit 743,60 € → Allocated bleibt 743,60 € (KEINE Verdopplung)", async () => {
    const now = new Date();
    const firstOfMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;

    const scenario: BudgetScenarioHandle = await setupBudgetScenario({
      customerNamePrefix: "T705-45A",
      pflegegrad: 3,
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: false,
      preferences: { budgetStartDate: firstOfMonth },
      types: [
        { type: "entlastungsbetrag_45b", priority: 1, enabled: false },
        { type: "umwandlung_45a", priority: 2, enabled: true, monthlyLimitCents: 74360 },
        { type: "ersatzpflege_39_42a", priority: 3, enabled: false },
      ],
      initialBalance: { type: "umwandlung_45a", amountCents: 74360, validFrom: firstOfMonth },
      appointments: [],
    });
    try {
      const overview = await apiGet<OverviewResponse>(
        `/api/budget/${scenario.customerId}/overview`,
      );
      const allocated = overview.data.umwandlung45a.currentMonthAllocatedCents;
      // Ohne Dedup wären es 2 × 74360 = 148720 ct. Mit Dedup exakt 74360 ct.
      expect(
        allocated,
        `§45a currentMonthAllocated=${allocated} (erwartet 74360 — IB für ` +
        `den laufenden Monat REPRÄSENTIERT die Monats-Aufstockung, nicht ` +
        `zusätzlich zu ihr).`,
      ).toBe(74360);
    } finally {
      await scenario.cleanup();
    }
  }, 120_000);
});
