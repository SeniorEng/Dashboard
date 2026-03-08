import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  getAuthCookie,
  apiGet,
  apiPost,
  apiPut,
  apiPatch,
  apiDelete,
  getTodayDate,
  getFutureDate,
  trackCleanup,
  runCleanup,
} from "./test-utils";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
let testCustomerId: number;
let createdAppointmentIds: number[] = [];
let createdTransactionIds: number[] = [];

async function apiDeleteRaw(path: string): Promise<{ status: number; data: any }> {
  const cookieHeader = `${auth.cookie}; careconnect_csrf=${auth.csrfToken}`;
  const response = await fetch(`${BASE_URL}${path}`, {
    method: "DELETE",
    headers: {
      Cookie: cookieHeader,
      "x-csrf-token": auth.csrfToken,
    },
  });
  const data = await response.json().catch(() => null);
  return { status: response.status, data };
}

beforeAll(async () => {
  auth = await getAuthCookie();

  const custRes = await apiGet<{ data: any[] }>("/api/admin/customers?limit=50");
  expect(custRes.status).toBe(200);

  const testCust = custRes.data.data.find((c: any) =>
    c.nachname === "Budget-Integrationstest"
  );

  if (testCust) {
    testCustomerId = testCust.id;
  } else {
    const createRes = await apiPost<any>("/api/admin/customers", {
      vorname: "Lina",
      nachname: "Budget-Integrationstest",
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

afterAll(async () => {
  for (const txId of createdTransactionIds) {
    try {
      await apiPost(`/api/budget/transactions/${txId}/reverse`, {});
    } catch {}
  }

  for (const apptId of createdAppointmentIds) {
    try {
      await apiDeleteRaw(`/api/appointments/${apptId}`);
    } catch {}
  }

  await runCleanup();
});


describe("INT-1: §45b Allokation und Summary", () => {

  it("INT-1.1 – Budget-Typ §45b aktivieren und Allokationen pruefen", async () => {
    const settings = [
      { budgetType: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
      { budgetType: "umwandlung_45a", priority: 2, enabled: false, monthlyLimitCents: null },
      { budgetType: "ersatzpflege_39_42a", priority: 3, enabled: false, yearlyLimitCents: null },
    ];
    const res = await apiPut<any>(`/api/budget/${testCustomerId}/type-settings`, { settings });
    expect(res.status).toBe(200);
  });

  it("INT-1.2 – Budget-Startdatum setzen und Preferences pruefen", async () => {
    const prefRes = await apiPut<any>(`/api/budget/${testCustomerId}/preferences`, {
      customerId: testCustomerId,
      budgetStartDate: "2026-01-01",
      monthlyLimitCents: null,
      notes: "Integrationstest",
    });
    expect(prefRes.status).toBe(200);
  });

  it("INT-1.3 – Overview enthält §45b mit korrektem totalAllocatedCents", async () => {
    const res = await apiGet<any>(`/api/budget/${testCustomerId}/overview`);
    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty("entlastungsbetrag45b");

    const s45b = res.data.entlastungsbetrag45b;
    expect(s45b.totalAllocatedCents).toBeGreaterThanOrEqual(13100);

    const today = new Date();
    const startDate = new Date("2026-01-01");
    const expectedMonths = (today.getFullYear() - startDate.getFullYear()) * 12
      + (today.getMonth() + 1) - (startDate.getMonth() + 1) + 1;

    if (expectedMonths > 0) {
      const expectedBase = expectedMonths * 13100;
      const totalWithCarryover = s45b.totalAllocatedCents;
      expect(totalWithCarryover).toBeGreaterThanOrEqual(expectedBase);
      expect(totalWithCarryover % 100).toBe(0);
    }
  });

  it("INT-1.4 – Allokationen haben source=monthly_auto und expiresAt=null", async () => {
    const res = await apiGet<any[]>(`/api/budget/${testCustomerId}/allocations?year=2026`);
    expect(res.status).toBe(200);

    const monthlyAuto = res.data.filter(
      (a: any) => a.budgetType === "entlastungsbetrag_45b" && a.source === "monthly_auto"
    );
    expect(monthlyAuto.length).toBeGreaterThan(0);

    for (const alloc of monthlyAuto) {
      expect(alloc.expiresAt).toBeNull();
      expect(alloc.amountCents).toBe(13100);
    }
  });

  it("INT-1.5 – §45b Overview enthält carryoverCents und carryoverExpiresAt", async () => {
    const res = await apiGet<any>(`/api/budget/${testCustomerId}/overview`);
    expect(res.status).toBe(200);
    const s45b = res.data.entlastungsbetrag45b;
    expect(s45b).toHaveProperty("carryoverCents");
    expect(s45b).toHaveProperty("carryoverExpiresAt");
    expect(s45b).toHaveProperty("currentYearAllocatedCents");
    expect(s45b).toHaveProperty("currentMonthUsedCents");
    expect(s45b).toHaveProperty("plannedCents");
    expect(s45b).toHaveProperty("availableAfterPlannedCents");
  });
});


describe("INT-2: §45a Allokation und Summary", () => {

  it("INT-2.1 – §45a aktivieren mit PG3-Betrag", async () => {
    const settings = [
      { budgetType: "entlastungsbetrag_45b", priority: 2, enabled: true, monthlyLimitCents: null },
      { budgetType: "umwandlung_45a", priority: 1, enabled: true, monthlyLimitCents: 59880 },
      { budgetType: "ersatzpflege_39_42a", priority: 3, enabled: false, yearlyLimitCents: null },
    ];
    const res = await apiPut<any>(`/api/budget/${testCustomerId}/type-settings`, { settings });
    expect(res.status).toBe(200);
  });

  it("INT-2.2 – Overview zeigt §45a mit currentMonthAllocatedCents > 0", async () => {
    const res = await apiGet<any>(`/api/budget/${testCustomerId}/overview`);
    expect(res.status).toBe(200);

    const s45a = res.data.umwandlung45a;
    expect(s45a).toHaveProperty("monthlyBudgetCents");
    expect(s45a).toHaveProperty("currentMonthAllocatedCents");
    expect(s45a).toHaveProperty("currentMonthUsedCents");
    expect(s45a).toHaveProperty("currentMonthAvailableCents");
    expect(s45a.monthlyBudgetCents).toBe(59880);
    expect(s45a.currentMonthAllocatedCents).toBe(59880);
  });

  it("INT-2.3 – §45a Allokationen haben expiresAt = letzter Tag des Monats", async () => {
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


describe("INT-3: §39/42a Allokation und Summary", () => {

  it("INT-3.1 – §39/42a aktivieren mit Jahresbetrag", async () => {
    const settings = [
      { budgetType: "entlastungsbetrag_45b", priority: 2, enabled: true, monthlyLimitCents: null },
      { budgetType: "umwandlung_45a", priority: 1, enabled: true, monthlyLimitCents: 59880 },
      { budgetType: "ersatzpflege_39_42a", priority: 3, enabled: true, yearlyLimitCents: 353900 },
    ];
    const res = await apiPut<any>(`/api/budget/${testCustomerId}/type-settings`, { settings });
    expect(res.status).toBe(200);
  });

  it("INT-3.2 – Overview zeigt §39/42a mit currentYearAllocatedCents", async () => {
    const res = await apiGet<any>(`/api/budget/${testCustomerId}/overview`);
    expect(res.status).toBe(200);

    const s42a = res.data.ersatzpflege39_42a;
    expect(s42a).toHaveProperty("yearlyBudgetCents");
    expect(s42a).toHaveProperty("currentYearAllocatedCents");
    expect(s42a).toHaveProperty("currentYearUsedCents");
    expect(s42a).toHaveProperty("currentYearAvailableCents");
    expect(s42a.yearlyBudgetCents).toBe(353900);
    expect(s42a.currentYearAllocatedCents).toBe(353900);
  });

  it("INT-3.3 – §39/42a Allokation hat expiresAt = 31.12.", async () => {
    const res = await apiGet<any[]>(`/api/budget/${testCustomerId}/allocations?year=2026`);
    expect(res.status).toBe(200);

    const a42a = res.data.filter(
      (a: any) => a.budgetType === "ersatzpflege_39_42a" && a.source === "yearly_auto"
    );
    expect(a42a.length).toBe(1);
    expect(a42a[0].expiresAt).toBe("2026-12-31");
    expect(a42a[0].month).toBeNull();
  });
});


describe("INT-4: Manuelle Korrektur und Storno", () => {
  let adjustmentTxId: number | null = null;

  it("INT-4.1 – Manuelle Korrektur erstellen", async () => {
    const res = await apiPost<any>(`/api/budget/${testCustomerId}/manual-adjustment`, {
      budgetType: "entlastungsbetrag_45b",
      amountCents: 500,
      notes: "INT-Test Korrektur",
    });
    expect(res.status).toBe(201);
    expect(res.data).toHaveProperty("type");
    if (res.data.type === "transaction" && res.data.data?.id) {
      adjustmentTxId = res.data.data.id;
    }
  });

  it("INT-4.2 – Korrektur erscheint in Transaktionsliste", async () => {
    const res = await apiGet<any[]>(`/api/budget/${testCustomerId}/transactions?budgetType=entlastungsbetrag_45b&limit=5`);
    expect(res.status).toBe(200);

    if (adjustmentTxId) {
      const found = res.data.find((t: any) => t.id === adjustmentTxId);
      expect(found).toBeDefined();
      expect(found.transactionType).toBe("manual_adjustment");
    }
  });

  it("INT-4.3 – Korrektur reduziert availableCents", async () => {
    const overviewBefore = await apiGet<any>(`/api/budget/${testCustomerId}/overview`);
    const availBefore = overviewBefore.data.entlastungsbetrag45b.availableCents;

    if (adjustmentTxId) {
      await apiPost(`/api/budget/transactions/${adjustmentTxId}/reverse`, {});
      createdTransactionIds = createdTransactionIds.filter(id => id !== adjustmentTxId);
    }

    const overviewAfter = await apiGet<any>(`/api/budget/${testCustomerId}/overview`);
    const availAfter = overviewAfter.data.entlastungsbetrag45b.availableCents;
    expect(availAfter).toBeGreaterThanOrEqual(availBefore);
  });
});


describe("INT-5: Kostenschaetzung", () => {

  it("INT-5.1 – Kostenschätzung fuer 60 Min HW liefert totalCents > 0", async () => {
    const today = getTodayDate();
    const res = await apiGet<any>(
      `/api/budget/${testCustomerId}/cost-estimate?date=${today}&hauswirtschaftMinutes=60&alltagsbegleitungMinutes=0&travelKilometers=0&customerKilometers=0`
    );
    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty("totalCents");
    expect(res.data.totalCents).toBeGreaterThan(0);
  });

  it("INT-5.2 – Kostenschaetzung fuer 0 Min liefert totalCents = 0", async () => {
    const today = getTodayDate();
    const res = await apiGet<any>(
      `/api/budget/${testCustomerId}/cost-estimate?date=${today}&hauswirtschaftMinutes=0&alltagsbegleitungMinutes=0&travelKilometers=0&customerKilometers=0`
    );
    expect(res.status).toBe(200);
    expect(res.data.totalCents).toBe(0);
  });
});


describe("INT-6: Kaskadenverbrauch ueber Termin-Dokumentation", () => {
  let appointmentId: number | null = null;
  let serviceId: number | null = null;

  it("INT-6.1 – Hauswirtschaft-Service ermitteln", async () => {
    const servicesRes = await apiGet<any[]>("/api/services");
    expect(servicesRes.status).toBe(200);
    const hwService = servicesRes.data.find((s: any) => s.code === "hauswirtschaft");
    expect(hwService).toBeDefined();
    serviceId = hwService.id;
  });

  it("INT-6.2 – Kundentermin erstellen", async () => {
    if (!serviceId) return;

    function getWeekday(d: Date): Date {
      const dow = d.getDay();
      if (dow === 0) d.setDate(d.getDate() - 2);
      else if (dow === 6) d.setDate(d.getDate() - 1);
      return d;
    }

    const timeSlots = ["08:00", "09:15", "10:30", "11:45", "13:00", "14:15", "15:30", "16:45"];

    let createRes: any = null;
    outer:
    for (let offset = 2; offset <= 60; offset++) {
      const candidate = new Date();
      candidate.setDate(candidate.getDate() - offset);
      getWeekday(candidate);
      const dateStr = candidate.toISOString().split("T")[0];

      for (const time of timeSlots) {
        createRes = await apiPost<any>("/api/appointments/kundentermin", {
          customerId: testCustomerId,
          date: dateStr,
          scheduledStart: time,
          notes: "INT-Budget-Test-" + Date.now(),
          assignedEmployeeId: auth.user.id,
          services: [{ serviceId, durationMinutes: 60 }],
        });

        if (createRes.status === 201) break outer;
      }
    }

    expect(createRes?.status).toBe(201);
    appointmentId = createRes.data.id;
    createdAppointmentIds.push(appointmentId!);
  });

  it("INT-6.3 – Budget-Overview ist abrufbar vor Dokumentation", async () => {
    if (!appointmentId) return;

    const res = await apiGet<any>(`/api/budget/${testCustomerId}/overview`);
    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty("entlastungsbetrag45b");
  });

  it("INT-6.4 – Termin dokumentieren erzeugt Budget-Transaktion", async () => {
    if (!appointmentId || !serviceId) return;

    const docRes = await apiPost<any>(`/api/appointments/${appointmentId}/document`, {
      actualStart: "09:00",
      travelOriginType: "home",
      travelKilometers: 0,
      customerKilometers: 0,
      services: [{ serviceId, actualDurationMinutes: 60, details: "INT-Test HW" }],
    });
    expect(docRes.status).toBe(200);

    const txRes = await apiGet<any[]>(`/api/budget/${testCustomerId}/transactions?limit=10`);
    expect(txRes.status).toBe(200);

    const consumption = txRes.data.find(
      (t: any) => t.appointmentId === appointmentId && t.transactionType === "consumption"
    );
    expect(consumption).toBeDefined();
    expect(consumption.amountCents).toBeLessThan(0);

    if (consumption) {
      createdTransactionIds.push(consumption.id);
    }
  });

  it("INT-6.5 – Nach Dokumentation: Verbrauch in einem der Toepfe sichtbar", async () => {
    const res = await apiGet<any>(`/api/budget/${testCustomerId}/overview`);
    expect(res.status).toBe(200);

    const totalUsed =
      (res.data.entlastungsbetrag45b?.totalUsedCents || 0) +
      (res.data.umwandlung45a?.currentMonthUsedCents || 0) +
      (res.data.ersatzpflege39_42a?.currentYearUsedCents || 0);
    expect(totalUsed).toBeGreaterThan(0);
  });
});


describe("INT-7: Doppelbuchungsschutz", () => {

  it("INT-7.1 – Zweite Dokumentation desselben Termins wird abgelehnt (ALREADY_COMPLETED)", async () => {
    const apptId = createdAppointmentIds[0];
    if (!apptId) return;

    const servicesRes = await apiGet<any[]>("/api/services");
    const hwService = servicesRes.data.find((s: any) => s.code === "hauswirtschaft");
    if (!hwService) return;

    const docRes = await apiPost<any>(`/api/appointments/${apptId}/document`, {
      actualStart: "09:00",
      travelOriginType: "home",
      travelKilometers: 0,
      services: [{ serviceId: hwService.id, actualDurationMinutes: 30, details: "Doppeltest" }],
    });

    expect(docRes.status).toBe(403);
    expect(docRes.data.error).toBe("ALREADY_COMPLETED");
  });
});


describe("INT-8: Budget-Typ Deaktivierung", () => {

  it("INT-8.1 – Deaktivierter Topf zeigt 0 im Overview", async () => {
    const settings = [
      { budgetType: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
      { budgetType: "umwandlung_45a", priority: 2, enabled: false, monthlyLimitCents: null },
      { budgetType: "ersatzpflege_39_42a", priority: 3, enabled: false, yearlyLimitCents: null },
    ];
    await apiPut(`/api/budget/${testCustomerId}/type-settings`, { settings });

    const res = await apiGet<any>(`/api/budget/${testCustomerId}/overview`);
    expect(res.status).toBe(200);
    expect(res.data.umwandlung45a.monthlyBudgetCents).toBe(0);
  });
});


describe("INT-9: Initiale Startwerte (initial_balance)", () => {

  it("INT-9.1 – Bestehende Startwerte aufraeumen und neuen setzen", async () => {
    const settings = [
      { budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1, monthlyLimitCents: 12500 },
    ];
    await apiPut(`/api/budget/${testCustomerId}/type-settings`, { settings });

    const existingRes = await apiGet<any[]>(`/api/budget/${testCustomerId}/initial-balances/entlastungsbetrag_45b`);
    if (existingRes.status === 200 && Array.isArray(existingRes.data)) {
      for (const ib of existingRes.data) {
        if (ib.source === "initial_balance") {
          await apiDeleteRaw(`/api/budget/${testCustomerId}/initial-balance/${ib.id}`);
        }
      }
    }

    const res = await apiPost<any>(`/api/budget/${testCustomerId}/initial-balance/entlastungsbetrag_45b`, {
      amountCents: 50000,
      validFrom: "2025-11",
    });
    expect([200, 201]).toContain(res.status);
  });

  it("INT-9.2 – Startwert erscheint in initial-balances Liste", async () => {
    const res = await apiGet<any[]>(`/api/budget/${testCustomerId}/initial-balances/entlastungsbetrag_45b`);
    expect(res.status).toBe(200);

    const ib = res.data.find(
      (a: any) => a.source === "initial_balance" && a.amountCents === 50000
    );
    expect(ib).toBeDefined();
    expect(ib.amountCents).toBe(50000);
  });

  it("INT-9.3 – Startwert loeschen (Aufraeumen)", async () => {
    const allocRes = await apiGet<any[]>(`/api/budget/${testCustomerId}/initial-balances/entlastungsbetrag_45b`);
    if (allocRes.status === 200 && Array.isArray(allocRes.data)) {
      for (const ib of allocRes.data) {
        if (ib.source === "initial_balance") {
          await apiDeleteRaw(`/api/budget/${testCustomerId}/initial-balance/${ib.id}`);
        }
      }
    }
  });
});


describe("INT-10: Alle drei Toepfe zusammen (vollstaendige Kaskade)", () => {

  it("INT-10.1 – Alle Toepfe aktivieren", async () => {
    const settings = [
      { budgetType: "umwandlung_45a", priority: 1, enabled: true, monthlyLimitCents: 59880 },
      { budgetType: "entlastungsbetrag_45b", priority: 2, enabled: true, monthlyLimitCents: null },
      { budgetType: "ersatzpflege_39_42a", priority: 3, enabled: true, yearlyLimitCents: 353900 },
    ];
    const res = await apiPut<any>(`/api/budget/${testCustomerId}/type-settings`, { settings });
    expect(res.status).toBe(200);
  });

  it("INT-10.2 – Overview zeigt alle drei Toepfe mit Daten", async () => {
    const res = await apiGet<any>(`/api/budget/${testCustomerId}/overview`);
    expect(res.status).toBe(200);

    expect(res.data.entlastungsbetrag45b.totalAllocatedCents).toBeGreaterThan(0);
    expect(res.data.umwandlung45a.currentMonthAllocatedCents).toBeGreaterThan(0);
    expect(res.data.ersatzpflege39_42a.currentYearAllocatedCents).toBeGreaterThan(0);
  });

  it("INT-10.3 – Typ-Einstellungen korrekte Prioritaeten", async () => {
    const res = await apiGet<any[]>(`/api/budget/${testCustomerId}/type-settings`);
    expect(res.status).toBe(200);

    const s45a = res.data.find((s: any) => s.budgetType === "umwandlung_45a");
    const s45b = res.data.find((s: any) => s.budgetType === "entlastungsbetrag_45b");
    const s42a = res.data.find((s: any) => s.budgetType === "ersatzpflege_39_42a");

    expect(s45a?.priority).toBeLessThan(s45b?.priority);
    expect(s45b?.priority).toBeLessThan(s42a?.priority);
  });
});
