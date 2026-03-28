import { describe, it, expect, beforeAll } from "vitest";
import {
  apiGet,
  apiPost,
  apiPut,
  apiPatch,
  apiDelete,
  getAuthCookie,
  uniqueId,
} from "./test-utils";

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
let testCustomerId: number;

beforeAll(async () => {
  auth = await getAuthCookie();

  const custRes = await apiGet<{ data: any[] }>("/api/admin/customers?limit=50");
  expect(custRes.status).toBe(200);
  const testCust = custRes.data.data.find((c: any) => c.nachname === "Budget-Business-Test");

  if (testCust) {
    testCustomerId = testCust.id;
  } else {
    const createRes = await apiPost<any>("/api/admin/customers", {
      vorname: "Budget",
      nachname: "Budget-Business-Test",
      geburtsdatum: "1940-01-15",
      strasse: "Teststraße",
      nr: "1",
      plz: "12345",
      stadt: "Teststadt",
      pflegegrad: 3,
      billingType: "pflegekasse_gesetzlich",
    });
    expect(createRes.status).toBe(201);
    testCustomerId = createRes.data.id;
  }

  await apiPatch(`/api/admin/customers/${testCustomerId}/assign`, {
    primaryEmployeeId: auth.user.id,
    backupEmployeeId: null,
    backupEmployeeId2: null,
  });
});

describe("BB-1: §45b Entlastungsbetrag", () => {
  it("BB-1.1 – §45b aktivieren und monatlichen Betrag prüfen (131,00 €)", async () => {
    const settings = [
      { budgetType: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
      { budgetType: "umwandlung_45a", priority: 2, enabled: false, monthlyLimitCents: null },
      { budgetType: "ersatzpflege_39_42a", priority: 3, enabled: false, yearlyLimitCents: null },
    ];
    const settingsRes = await apiPut<any>(`/api/budget/${testCustomerId}/type-settings`, { settings });
    expect(settingsRes.status).toBe(200);

    const prefRes = await apiPut<any>(`/api/budget/${testCustomerId}/preferences`, {
      customerId: testCustomerId,
      budgetStartDate: "2026-01-01",
    });
    expect([200, 201]).toContain(prefRes.status);

    const res = await apiGet<any>(`/api/budget/${testCustomerId}/overview`);
    expect(res.status).toBe(200);
    const s45b = res.data.entlastungsbetrag45b;
    expect(s45b).toBeDefined();
    expect(s45b.totalAllocatedCents).toBeGreaterThanOrEqual(13100);
    expect(s45b.totalAllocatedCents % 100).toBe(0);
  });

  it("BB-1.2 – §45b Allokationen haben source=monthly_auto und 131,00€", async () => {
    const res = await apiGet<any[]>(`/api/budget/${testCustomerId}/allocations?year=2026`);
    expect(res.status).toBe(200);
    const monthly = res.data.filter(
      (a: any) => a.budgetType === "entlastungsbetrag_45b" && a.source === "monthly_auto"
    );
    expect(monthly.length).toBeGreaterThan(0);
    for (const alloc of monthly) {
      expect(alloc.amountCents).toBe(13100);
    }
  });

  it("BB-1.3 – §45b Übertrag (Carryover) wird angezeigt", async () => {
    const res = await apiGet<any>(`/api/budget/${testCustomerId}/overview`);
    expect(res.status).toBe(200);
    const s45b = res.data.entlastungsbetrag45b;
    expect(s45b).toHaveProperty("carryoverCents");
    expect(s45b).toHaveProperty("carryoverExpiresAt");
  });
});

describe("BB-2: §45a Umwandlung", () => {
  it("BB-2.1 – §45a aktivieren mit PG3-Limit (598,80 €)", async () => {
    const settings = [
      { budgetType: "entlastungsbetrag_45b", priority: 2, enabled: true, monthlyLimitCents: null },
      { budgetType: "umwandlung_45a", priority: 1, enabled: true, monthlyLimitCents: 59880 },
      { budgetType: "ersatzpflege_39_42a", priority: 3, enabled: false, yearlyLimitCents: null },
    ];
    const res = await apiPut<any>(`/api/budget/${testCustomerId}/type-settings`, { settings });
    expect(res.status).toBe(200);
  });

  it("BB-2.2 – §45a Overview zeigt monatliches Budget", async () => {
    const res = await apiGet<any>(`/api/budget/${testCustomerId}/overview`);
    expect(res.status).toBe(200);
    const s45a = res.data.umwandlung45a;
    expect(s45a).toBeDefined();
    expect(s45a.monthlyBudgetCents).toBe(59880);
    expect(s45a.currentMonthAllocatedCents).toBe(59880);
  });

  it("BB-2.3 – §45a Allokationen verfallen am Monatsende", async () => {
    const res = await apiGet<any[]>(`/api/budget/${testCustomerId}/allocations?year=2026`);
    expect(res.status).toBe(200);
    const a45a = res.data.filter(
      (a: any) => a.budgetType === "umwandlung_45a" && a.source === "monthly_auto"
    );
    expect(a45a.length).toBeGreaterThan(0);
    for (const alloc of a45a) {
      expect(alloc.expiresAt).not.toBeNull();
      const expiresDate = new Date(alloc.expiresAt + "T00:00:00");
      const nextDay = new Date(expiresDate);
      nextDay.setDate(nextDay.getDate() + 1);
      expect(nextDay.getDate()).toBe(1);
    }
  });
});

describe("BB-3: §39/42a Ersatzpflege", () => {
  it("BB-3.1 – §39/42a aktivieren mit Jahresbudget (3.539,00 €)", async () => {
    const settings = [
      { budgetType: "entlastungsbetrag_45b", priority: 2, enabled: true, monthlyLimitCents: null },
      { budgetType: "umwandlung_45a", priority: 1, enabled: true, monthlyLimitCents: 59880 },
      { budgetType: "ersatzpflege_39_42a", priority: 3, enabled: true, yearlyLimitCents: 353900 },
    ];
    const res = await apiPut<any>(`/api/budget/${testCustomerId}/type-settings`, { settings });
    expect(res.status).toBe(200);
  });

  it("BB-3.2 – §39/42a Overview zeigt Jahresbudget", async () => {
    const res = await apiGet<any>(`/api/budget/${testCustomerId}/overview`);
    expect(res.status).toBe(200);
    const s42a = res.data.ersatzpflege39_42a;
    expect(s42a).toBeDefined();
    expect(s42a.yearlyBudgetCents).toBe(353900);
    expect(s42a.currentYearAllocatedCents).toBe(353900);
  });

  it("BB-3.3 – §39/42a Allokation verfällt am 31.12.", async () => {
    const res = await apiGet<any[]>(`/api/budget/${testCustomerId}/allocations?year=2026`);
    expect(res.status).toBe(200);
    const a42a = res.data.filter(
      (a: any) => a.budgetType === "ersatzpflege_39_42a" && a.source === "yearly_auto"
    );
    expect(a42a.length).toBe(1);
    expect(a42a[0].expiresAt).toBe("2026-12-31");
  });
});

describe("BB-4: Manuelle Korrektur & Storno", () => {
  let txId: number | null = null;

  it("BB-4.1 – Positive manuelle Korrektur erstellt Allocation", async () => {
    const res = await apiPost<any>(`/api/budget/${testCustomerId}/manual-adjustment`, {
      budgetType: "entlastungsbetrag_45b",
      amountCents: 2500,
      notes: "BB-Test Korrektur positiv",
    });
    expect(res.status).toBe(201);
    expect(res.data.type).toBe("allocation");
    expect(res.data.data).toHaveProperty("id");
    expect(res.data.data.amountCents).toBe(2500);
    expect(res.data.data.source).toBe("manual_adjustment");
  });

  it("BB-4.2 – Negative manuelle Korrektur erstellt Transaction", async () => {
    const res = await apiPost<any>(`/api/budget/${testCustomerId}/manual-adjustment`, {
      budgetType: "entlastungsbetrag_45b",
      amountCents: -500,
      notes: "BB-Test Korrektur negativ",
    });
    expect(res.status).toBe(201);
    expect(res.data.type).toBe("transaction");
    expect(res.data.data).toHaveProperty("id");
    txId = res.data.data.id;
  });

  it("BB-4.3 – Korrektur-Transaktion in Liste sichtbar", async () => {
    expect(txId, "txId muss aus BB-4.2 gesetzt sein").toBeTruthy();
    const res = await apiGet<any[]>(`/api/budget/${testCustomerId}/transactions?budgetType=entlastungsbetrag_45b&limit=10`);
    expect(res.status).toBe(200);
    const found = res.data.find((t: any) => t.id === txId);
    expect(found, "Korrektur-Transaktion muss in Liste sichtbar sein").toBeDefined();
    expect(found.transactionType).toBe("manual_adjustment");
  });

  it("BB-4.4 – Korrektur-Transaktion stornieren", async () => {
    expect(txId, "txId muss aus BB-4.2 gesetzt sein").toBeTruthy();
    const res = await apiPost<any>(`/api/budget/transactions/${txId}/reverse`, {});
    expect([200, 201]).toContain(res.status);
  });

  it("BB-4.5 – Storno-Transaktion erneut stornieren erzeugt weitere Gegenbuchung", async () => {
    expect(txId, "txId muss aus BB-4.2 gesetzt sein").toBeTruthy();
    const res = await apiPost<any>(`/api/budget/transactions/${txId}/reverse`, {});
    expect([200, 201]).toContain(res.status);
    expect(res.data).toBeDefined();
  });
});

describe("BB-5: Prioritätsreihenfolge", () => {
  it("BB-5.1 – Prioritätsreihenfolge ändern (§45a zuerst)", async () => {
    const settings = [
      { budgetType: "umwandlung_45a", priority: 1, enabled: true, monthlyLimitCents: 59880 },
      { budgetType: "entlastungsbetrag_45b", priority: 2, enabled: true, monthlyLimitCents: null },
      { budgetType: "ersatzpflege_39_42a", priority: 3, enabled: true, yearlyLimitCents: 353900 },
    ];
    const res = await apiPut<any>(`/api/budget/${testCustomerId}/type-settings`, { settings });
    expect(res.status).toBe(200);
  });

  it("BB-5.2 – Einstellungen spiegeln neue Prioritätsreihenfolge wider", async () => {
    const res = await apiGet<any[]>(`/api/budget/${testCustomerId}/type-settings`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data)).toBe(true);

    const sorted = [...res.data].sort((a: any, b: any) => a.priority - b.priority);
    expect(sorted[0].budgetType).toBe("umwandlung_45a");
    expect(sorted[1].budgetType).toBe("entlastungsbetrag_45b");
    expect(sorted[2].budgetType).toBe("ersatzpflege_39_42a");
  });
});

describe("BB-6: Deaktivierter Topf", () => {
  it("BB-6.1 – Deaktivierter Topf zeigt 0 im Overview", async () => {
    const settings = [
      { budgetType: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
      { budgetType: "umwandlung_45a", priority: 2, enabled: false, monthlyLimitCents: null },
      { budgetType: "ersatzpflege_39_42a", priority: 3, enabled: false, yearlyLimitCents: null },
    ];
    const setRes = await apiPut<any>(`/api/budget/${testCustomerId}/type-settings`, { settings });
    expect(setRes.status).toBe(200);

    const res = await apiGet<any>(`/api/budget/${testCustomerId}/overview`);
    expect(res.status).toBe(200);
    expect(res.data.umwandlung45a.monthlyBudgetCents).toBe(0);
  });
});

describe("BB-7: Kostenvoranschlag (cost-estimate)", () => {
  it("BB-7.1 – cost-estimate liefert Budget-Informationen", async () => {
    const servicesRes = await apiGet<any[]>("/api/services/all");
    const hwId = servicesRes.data.find((s: any) => s.code === "hauswirtschaft")?.id;
    expect(hwId, "hauswirtschaft Service muss existieren").toBeTruthy();

    const res = await apiGet<any>(
      `/api/budget/${testCustomerId}/cost-estimate?serviceId=${hwId}&durationMinutes=60`
    );
    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty("totalCents");
    expect(res.data).toHaveProperty("availableCents");
    expect(typeof res.data.totalCents).toBe("number");
    expect(typeof res.data.availableCents).toBe("number");
  });
});

describe("BB-8: Budget-Summary Gesamtübersicht", () => {
  it("BB-8.1 – Summary zeigt alle drei Budgettypen", async () => {
    const settings = [
      { budgetType: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
      { budgetType: "umwandlung_45a", priority: 2, enabled: true, monthlyLimitCents: 59880 },
      { budgetType: "ersatzpflege_39_42a", priority: 3, enabled: true, yearlyLimitCents: 353900 },
    ];
    await apiPut(`/api/budget/${testCustomerId}/type-settings`, { settings });

    const res = await apiGet<any>(`/api/budget/${testCustomerId}/overview`);
    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty("entlastungsbetrag45b");
    expect(res.data).toHaveProperty("umwandlung45a");
    expect(res.data).toHaveProperty("ersatzpflege39_42a");

    expect(typeof res.data.entlastungsbetrag45b.totalAllocatedCents).toBe("number");
    expect(typeof res.data.entlastungsbetrag45b.totalUsedCents).toBe("number");
    expect(typeof res.data.umwandlung45a.monthlyBudgetCents).toBe("number");
    expect(typeof res.data.ersatzpflege39_42a.yearlyBudgetCents).toBe("number");
  });

  it("BB-8.2 – Transaktionsliste filtert nach budgetType", async () => {
    const res = await apiGet<any[]>(`/api/budget/${testCustomerId}/transactions?budgetType=entlastungsbetrag_45b&limit=5`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data)).toBe(true);
    for (const tx of res.data) {
      expect(tx.budgetType).toBe("entlastungsbetrag_45b");
    }
  });
});
