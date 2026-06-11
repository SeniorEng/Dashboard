/**
 * Task #705 — Equality §39/§42a (Verhinderungspflege): Jahres-Topf mit
 * initial_balance + yearlyLimitCents gleichzeitig gesetzt darf NICHT die
 * Jahresaufstockung doppelt anrechnen.
 *
 * Reproducer aus Bug-Report 2026-05-27: Wenn ein Admin ein
 * initial_balance von 1.612 € (= Jahresbetrag) anlegt UND gleichzeitig
 * `yearlyLimitCents=161200` setzt, zeigte das Overview 3.224 € verfügbar
 * statt 1.612 €. Dedup in `calculateAllocated39` muss für Jahre mit
 * initial_balance den `yearlyAlloc`-Beitrag überspringen.
 */
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import {
  apiGet,
  getAuthCookie,
  runCleanup,
} from "../test-utils";
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
  ersatzpflege39_42a: { currentYearAvailableCents: number };
}

describe("Equality §39/§42a — initial_balance + yearlyLimitCents Dedup (Task #705)", () => {
  it("§39_42a Jahres-IB 1.612 € + yearlyLimit 1.612 € → verfügbar bleibt 1.612 € (KEINE Verdopplung)", async () => {
    const startOfYear = `${new Date().getFullYear()}-01-01`;

    const scenario: BudgetScenarioHandle = await setupBudgetScenario({
      customerNamePrefix: "T705-3942A",
      pflegegrad: 3,
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: false,
      pflegegradSeit: startOfYear,
      types: [
        { type: "entlastungsbetrag_45b", priority: 1, enabled: false },
        { type: "umwandlung_45a", priority: 2, enabled: false },
        // 161200 ct = 1.612 € (Verhinderungspflege gesetzlicher Jahresbetrag).
        // Beide Quellen (IB + yearlyLimit) wollen den Jahrestopf befüllen.
        { type: "ersatzpflege_39_42a", priority: 3, enabled: true, yearlyLimitCents: 161200 },
      ],
      initialBalance: { type: "ersatzpflege_39_42a", amountCents: 161200, validFrom: startOfYear },
      appointments: [],
    });
    try {
      const overview = await apiGet<OverviewResponse>(
        `/api/budget/${scenario.customerId}/overview`,
      );
      const available = overview.data.ersatzpflege39_42a.currentYearAvailableCents;
      // Ohne Dedup wären es 2 × 161200 = 322400 ct.
      expect(
        available,
        `§39_42a available=${available} (erwartet 161200 — IB für das Jahr ` +
        `REPRÄSENTIERT die Jahres-Aufstockung, nicht zusätzlich zu ihr).`,
      ).toBe(161200);
    } finally {
      await scenario.cleanup();
    }
  }, 120_000);
});
