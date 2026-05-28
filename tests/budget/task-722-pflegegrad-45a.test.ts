/**
 * Task #722 — §45a Umwandlungsanspruch ist erst ab Pflegegrad 2 verfügbar.
 *
 * Re-Test Reproducer (2026-05-28): PG1-Kunde konnte über
 * `POST /api/budget/:cid/initial-budget` mit `budgetType=umwandlung_45a`
 * eine §45a-Allokation über 318,40 € anlegen (Status 201). Compliance-Risiko:
 * GoBD-Buchungen ohne fachliche Anspruchsgrundlage.
 *
 * Erwartung nach #722:
 *   - PG1 + §45a + initial-budget       → 409 BUDGET_NOT_AVAILABLE_FOR_PFLEGEGRAD
 *   - PG1 + §45a + type-settings(enabled=true) → 409 BUDGET_NOT_AVAILABLE_FOR_PFLEGEGRAD
 *   - PG2 + §45a + initial-budget       → 201
 *   - PG1 + §45b + initial-budget       → 201 (Pflegegrad-Regel greift nur für §45a)
 */
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import {
  apiPost,
  apiPut,
  cleanupCustomer,
  createTestCustomer,
  getAuthCookie,
  runCleanup,
} from "../test-utils";

beforeAll(async () => {
  await getAuthCookie();
});

afterAll(async () => {
  await runCleanup();
});

describe("Task #722 — §45a nur ab Pflegegrad 2", () => {
  it("PG1 + §45a + initial-budget → 409 BUDGET_NOT_AVAILABLE_FOR_PFLEGEGRAD", async () => {
    const c = await createTestCustomer({
      vorname: "T722-PG1",
      pflegegrad: 1,
      pflegegradSeit: "2024-01-01",
      billingType: "pflegekasse_gesetzlich",
    });
    const customerId = c.id as number;
    try {
      const res = await apiPost<any>(`/api/budget/${customerId}/initial-budget`, {
        budgetType: "umwandlung_45a",
        currentMonthAmountCents: 31840,
        carryoverAmountCents: 0,
        budgetStartDate: "2026-01-01",
      });
      expect(res.status, `expected 409, got ${res.status} ${JSON.stringify(res.data)}`).toBe(409);
      expect(res.data?.code).toBe("BUDGET_NOT_AVAILABLE_FOR_PFLEGEGRAD");
      expect(res.data?.error).toBe("BUDGET_NOT_AVAILABLE_FOR_PFLEGEGRAD");
      expect(typeof res.data?.message).toBe("string");
      expect(res.data.message).toMatch(/Pflegegrad\s*2/);
    } finally {
      await cleanupCustomer(customerId);
    }
  }, 60_000);

  it("PG1 + §45a + type-settings(enabled=true) → 409 BUDGET_NOT_AVAILABLE_FOR_PFLEGEGRAD", async () => {
    const c = await createTestCustomer({
      vorname: "T722-PG1-TS",
      pflegegrad: 1,
      pflegegradSeit: "2024-01-01",
      billingType: "pflegekasse_gesetzlich",
    });
    const customerId = c.id as number;
    try {
      const res = await apiPut<any>(`/api/budget/${customerId}/type-settings`, {
        settings: [
          { budgetType: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
          { budgetType: "umwandlung_45a", priority: 2, enabled: true, monthlyLimitCents: 31840 },
          { budgetType: "ersatzpflege_39_42a", priority: 3, enabled: false, yearlyLimitCents: null },
        ],
      });
      expect(res.status, `expected 409, got ${res.status} ${JSON.stringify(res.data)}`).toBe(409);
      expect(res.data?.code).toBe("BUDGET_NOT_AVAILABLE_FOR_PFLEGEGRAD");
    } finally {
      await cleanupCustomer(customerId);
    }
  }, 60_000);

  it("PG2 + §45a + initial-budget → 201 (Anspruchsgrundlage erfüllt)", async () => {
    const c = await createTestCustomer({
      vorname: "T722-PG2",
      pflegegrad: 2,
      pflegegradSeit: "2024-01-01",
      billingType: "pflegekasse_gesetzlich",
    });
    const customerId = c.id as number;
    try {
      const res = await apiPost<any>(`/api/budget/${customerId}/initial-budget`, {
        budgetType: "umwandlung_45a",
        currentMonthAmountCents: 31840,
        carryoverAmountCents: 0,
        budgetStartDate: "2026-01-01",
      });
      expect(res.status, `expected 201, got ${res.status} ${JSON.stringify(res.data)}`).toBe(201);
    } finally {
      await cleanupCustomer(customerId);
    }
  }, 60_000);

  it("PG1 + §45b + initial-budget → 201 (Pflegegrad-Regel betrifft nur §45a)", async () => {
    const c = await createTestCustomer({
      vorname: "T722-PG1-45b",
      pflegegrad: 1,
      pflegegradSeit: "2024-01-01",
      billingType: "pflegekasse_gesetzlich",
    });
    const customerId = c.id as number;
    try {
      const res = await apiPost<any>(`/api/budget/${customerId}/initial-budget`, {
        budgetType: "entlastungsbetrag_45b",
        currentMonthAmountCents: 13100,
        carryoverAmountCents: 0,
        budgetStartDate: "2026-01-01",
      });
      expect(res.status, `expected 201, got ${res.status} ${JSON.stringify(res.data)}`).toBe(201);
    } finally {
      await cleanupCustomer(customerId);
    }
  }, 60_000);
});
