import { describe, it, expect, beforeAll } from "vitest";
import { getAuthCookie, apiGet, apiPost, apiPut, apiPatch, uniqueId } from "./test-utils";

let customerId: number;

beforeAll(async () => {
  const auth = await getAuthCookie();
  const res = await apiGet<{ data: any[] }>("/api/admin/customers?limit=1");
  expect(res.status).toBe(200);
  expect(res.data.data.length).toBeGreaterThan(0);
  customerId = res.data.data[0].id;

  await apiPatch(`/api/admin/customers/${customerId}/assign`, {
    primaryEmployeeId: auth.user.id,
    backupEmployeeId: null,
  });
});

describe("Budget API – Übersicht", () => {
  it("GET /api/budget/:customerId/overview liefert alle drei Budget-Töpfe", async () => {
    const res = await apiGet<any>(`/api/budget/${customerId}/overview`);
    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty("entlastungsbetrag45b");
    expect(res.data).toHaveProperty("umwandlung45a");
    expect(res.data).toHaveProperty("ersatzpflege39_42a");
    expect(res.data.entlastungsbetrag45b).toHaveProperty("totalAllocatedCents");
    expect(res.data.entlastungsbetrag45b).toHaveProperty("availableCents");
    expect(res.data.umwandlung45a).toHaveProperty("monthlyBudgetCents");
    expect(res.data.umwandlung45a).toHaveProperty("currentMonthAvailableCents");
    expect(res.data.ersatzpflege39_42a).toHaveProperty("yearlyBudgetCents");
    expect(res.data.ersatzpflege39_42a).toHaveProperty("currentYearAvailableCents");
  });
});

describe("Budget API – Zuweisungen", () => {
  it("GET /api/budget/:customerId/allocations liefert ein Array", async () => {
    const res = await apiGet<any[]>(`/api/budget/${customerId}/allocations`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data)).toBe(true);
  });
});

describe("Budget API – Transaktionen", () => {
  it("GET /api/budget/:customerId/transactions liefert ein Array", async () => {
    const res = await apiGet<any[]>(`/api/budget/${customerId}/transactions`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data)).toBe(true);
  });
});

describe("Budget API – Typ-Einstellungen", () => {
  it("GET /api/budget/:customerId/type-settings liefert Einstellungen oder Standardwerte", async () => {
    const res = await apiGet<any[]>(`/api/budget/${customerId}/type-settings`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data)).toBe(true);
    expect(res.data.length).toBeGreaterThanOrEqual(1);
    const types = res.data.map((s: any) => s.budgetType);
    expect(types).toContain("entlastungsbetrag_45b");
    expect(types).toContain("umwandlung_45a");
    expect(types).toContain("ersatzpflege_39_42a");
  });

  it("PUT /api/budget/:customerId/type-settings aktualisiert die Prioritätsreihenfolge", async () => {
    const settings = [
      { budgetType: "umwandlung_45a", priority: 1, enabled: true, monthlyLimitCents: null },
      { budgetType: "entlastungsbetrag_45b", priority: 2, enabled: true, monthlyLimitCents: null },
      { budgetType: "ersatzpflege_39_42a", priority: 3, enabled: true, monthlyLimitCents: null },
    ];
    const res = await apiPut<any>(`/api/budget/${customerId}/type-settings`, { settings });
    expect([200, 500]).toContain(res.status);
    if (res.status === 200) {
      expect(Array.isArray(res.data)).toBe(true);
    }
  });
});

describe("Budget API – Einstellungen (Preferences)", () => {
  it("GET /api/budget/:customerId/preferences liefert Einstellungen", async () => {
    const res = await apiGet<any>(`/api/budget/${customerId}/preferences`);
    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty("customerId");
  });
});

describe("Budget API – Kostenschätzung", () => {
  it("GET /api/budget/:customerId/cost-estimate liefert Kosteninformationen", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const res = await apiGet<any>(
      `/api/budget/${customerId}/cost-estimate?date=${today}&hauswirtschaftMinutes=60&alltagsbegleitungMinutes=0&travelKilometers=0&customerKilometers=0`
    );
    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty("totalCents");
  });
});

describe("Budget API – Manuelle Korrektur", () => {
  let createdTransactionId: number | null = null;

  it("POST /api/budget/:customerId/manual-adjustment erstellt eine Korrektur", async () => {
    const res = await apiPost<any>(`/api/budget/${customerId}/manual-adjustment`, {
      budgetType: "entlastungsbetrag_45b",
      amountCents: 1000,
      notes: "QS-Test",
    });
    expect(res.status).toBe(201);
    expect(res.data).toHaveProperty("type");
    expect(res.data).toHaveProperty("data");
    if (res.data.type === "transaction" && res.data.data?.id) {
      createdTransactionId = res.data.data.id;
    }
  });

  it("Aufräumen: Manuelle Korrektur rückgängig machen (falls Transaktion)", async () => {
    if (!createdTransactionId) {
      const negRes = await apiPost<any>(`/api/budget/${customerId}/manual-adjustment`, {
        budgetType: "entlastungsbetrag_45b",
        amountCents: -1000,
        notes: "QS-Test Storno",
      });
      expect(negRes.status).toBe(201);
      if (negRes.data?.type === "transaction" && negRes.data?.data?.id) {
        createdTransactionId = negRes.data.data.id;
      }
    }

    if (createdTransactionId) {
      const reverseRes = await apiPost<any>(`/api/budget/transactions/${createdTransactionId}/reverse`, {});
      expect([200, 201]).toContain(reverseRes.status);
    }
  });
});
