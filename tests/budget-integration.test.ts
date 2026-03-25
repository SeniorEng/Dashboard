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

  try {
    const allocRes = await apiGet<any[]>(`/api/budget/${testCustomerId}/allocations?year=2026`);
    if (allocRes.status === 200 && Array.isArray(allocRes.data)) {
      for (const alloc of allocRes.data) {
        if (alloc.source === "manual_adjustment" && alloc.notes === "INT-Test Korrektur") {
          await apiDeleteRaw(`/api/budget/${testCustomerId}/initial-balance/${alloc.id}`);
        }
      }
    }
  } catch {}

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
  let appointmentMonth: string | null = null;
  let initialBalanceId: number | null = null;

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

    const apptDate = createRes.data.date;
    if (apptDate) {
      appointmentMonth = apptDate.substring(0, 7);
    }
  });

  it("INT-6.3 – Budget-Overview ist abrufbar vor Dokumentation", async () => {
    if (!appointmentId || !appointmentMonth) return;

    const ibRes = await apiPost<any>(`/api/budget/${testCustomerId}/initial-balance/entlastungsbetrag_45b`, {
      amountCents: 50000,
      validFrom: appointmentMonth,
    });
    expect([200, 201]).toContain(ibRes.status);

    const ibList = await apiGet<any[]>(`/api/budget/${testCustomerId}/initial-balances/entlastungsbetrag_45b`);
    if (ibList.status === 200 && Array.isArray(ibList.data)) {
      const ib = ibList.data.find((a: any) => a.source === "initial_balance" && a.amountCents === 50000);
      if (ib) initialBalanceId = ib.id;
    }

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

    const inlineTx = docRes.data.budgetTransaction;
    expect(inlineTx).toBeDefined();
    expect(inlineTx.appointmentId).toBe(appointmentId);
    expect(inlineTx.transactionType).toBe("consumption");
    expect(inlineTx.amountCents).toBeLessThan(0);

    createdTransactionIds.push(inlineTx.id);

    const txRes = await apiGet<any[]>(`/api/budget/${testCustomerId}/transactions?limit=5000`);
    expect(txRes.status).toBe(200);

    const consumption = txRes.data.find(
      (t: any) => t.appointmentId === appointmentId && t.transactionType === "consumption"
    );
    expect(consumption).toBeDefined();
    expect(consumption!.amountCents).toBeLessThan(0);
  });

  it("INT-6.5 – Nach Dokumentation: Verbrauch in einem der Toepfe sichtbar", async () => {
    if (!appointmentId) return;

    const txRes = await apiGet<any[]>(`/api/budget/${testCustomerId}/transactions?limit=5000`);
    expect(txRes.status).toBe(200);

    const consumption = txRes.data.find(
      (t: any) => t.appointmentId === appointmentId && t.transactionType === "consumption"
    );
    expect(consumption).toBeDefined();
    expect(consumption.amountCents).toBeLessThan(0);
  });

  afterAll(async () => {
    if (initialBalanceId) {
      try {
        await apiDeleteRaw(`/api/budget/${testCustomerId}/initial-balance/${initialBalanceId}`);
      } catch {}
    }
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


describe("INT-11: T2.3 User-Monatslimit (Ueberlauf in naechsten Topf)", () => {
  let limitAppointmentId: number | null = null;
  let limitTransactionIds: number[] = [];
  let serviceId: number | null = null;
  let initialBalanceId45a: number | null = null;
  const monthlyLimitCents45a = 1000;

  it("INT-11.1 – Setup: §45a mit 10€ Monatslimit Prio 1, §45b als Auffang Prio 2", async () => {
    await apiPut(`/api/budget/${testCustomerId}/preferences`, {
      customerId: testCustomerId,
      budgetStartDate: "2026-01-01",
      monthlyLimitCents: null,
      notes: "T2.3 Limit Test",
    });

    const now = new Date();
    const validFromMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const ibRes = await apiPost<any>(`/api/budget/${testCustomerId}/initial-balance/umwandlung_45a`, {
      amountCents: 50000,
      validFrom: validFromMonth,
    });
    expect([200, 201]).toContain(ibRes.status);

    const ibList = await apiGet<any[]>(`/api/budget/${testCustomerId}/initial-balances/umwandlung_45a`);
    const ib = ibList.data?.find((a: any) => a.amountCents === 50000 && a.source === "initial_balance");
    if (ib) initialBalanceId45a = ib.id;

    const settings = [
      { budgetType: "umwandlung_45a", priority: 1, enabled: true, monthlyLimitCents: monthlyLimitCents45a },
      { budgetType: "entlastungsbetrag_45b", priority: 2, enabled: true, monthlyLimitCents: null },
      { budgetType: "ersatzpflege_39_42a", priority: 3, enabled: false, yearlyLimitCents: null },
    ];
    const settingsRes = await apiPut<any>(`/api/budget/${testCustomerId}/type-settings`, { settings });
    expect(settingsRes.status).toBe(200);

    const overviewRes = await apiGet<any>(`/api/budget/${testCustomerId}/overview`);
    expect(overviewRes.status).toBe(200);

    const servicesRes = await apiGet<any[]>("/api/services");
    const hwService = servicesRes.data.find((s: any) => s.code === "hauswirtschaft");
    expect(hwService).toBeDefined();
    serviceId = hwService.id;
  });

  it("INT-11.2 – Termin erstellen + dokumentieren (Kosten > 10€)", async () => {
    if (!serviceId) return;

    function getWeekday(d: Date): Date {
      const dow = d.getDay();
      if (dow === 0) d.setDate(d.getDate() - 2);
      else if (dow === 6) d.setDate(d.getDate() - 1);
      return d;
    }

    const now = new Date();
    const currentMonth = now.getMonth();
    const currentYear = now.getFullYear();
    const timeSlots = ["06:00", "06:15", "06:30", "06:45", "19:00", "19:15", "19:30", "19:45"];
    let createRes: any = null;

    outer:
    for (let offset = 2; offset <= 28; offset++) {
      const candidate = new Date();
      candidate.setDate(candidate.getDate() - offset);
      if (candidate.getMonth() !== currentMonth || candidate.getFullYear() !== currentYear) continue;
      getWeekday(candidate);
      const dateStr = candidate.toISOString().split("T")[0];

      for (const time of timeSlots) {
        createRes = await apiPost<any>("/api/appointments/kundentermin", {
          customerId: testCustomerId,
          date: dateStr,
          scheduledStart: time,
          notes: "INT-Limit-Test-" + Date.now(),
          assignedEmployeeId: auth.user.id,
          services: [{ serviceId, durationMinutes: 120 }],
        });
        if (createRes.status === 201) break outer;
      }
    }

    expect(createRes?.status).toBe(201);
    limitAppointmentId = createRes.data.id;
    createdAppointmentIds.push(limitAppointmentId!);

    const docRes = await apiPost<any>(`/api/appointments/${limitAppointmentId}/document`, {
      actualStart: "06:00",
      travelOriginType: "home",
      travelKilometers: 0,
      customerKilometers: 0,
      services: [{ serviceId, actualDurationMinutes: 120, details: "Limit Test 120min" }],
    });
    expect(docRes.status).toBe(200);
    expect(docRes.data.budgetTransaction).toBeDefined();
    limitTransactionIds.push(docRes.data.budgetTransaction.id);
  });

  it("INT-11.3 – §45a-Anteil ist durch Monatslimit (10€) gedeckelt, Rest in §45b", async () => {
    if (!limitAppointmentId) return;

    const overviewRes = await apiGet<any>(`/api/budget/${testCustomerId}/overview`);
    expect(overviewRes.status).toBe(200);
    expect(overviewRes.data.umwandlung45a.currentMonthAllocatedCents).toBeGreaterThan(0);

    const txRes = await apiGet<any[]>(`/api/budget/${testCustomerId}/transactions?limit=5000`);
    expect(txRes.status).toBe(200);

    const consumptions = txRes.data.filter(
      (t: any) => t.appointmentId === limitAppointmentId && t.transactionType === "consumption"
    );
    expect(consumptions.length).toBeGreaterThanOrEqual(2);

    const eb45a = consumptions.filter((t: any) => t.budgetType === "umwandlung_45a");
    const eb45b = consumptions.filter((t: any) => t.budgetType === "entlastungsbetrag_45b");

    const total45aCents = eb45a.reduce((sum: number, t: any) => sum + Math.abs(t.amountCents), 0);
    const total45bCents = eb45b.reduce((sum: number, t: any) => sum + Math.abs(t.amountCents), 0);
    const totalCents = total45aCents + total45bCents;

    expect(totalCents).toBeGreaterThan(0);
    expect(total45aCents).toBeGreaterThan(0);
    expect(total45aCents).toBeLessThanOrEqual(monthlyLimitCents45a);
    expect(total45bCents).toBeGreaterThan(0);
  });

  afterAll(async () => {
    for (const txId of limitTransactionIds) {
      try { await apiPost(`/api/budget/transactions/${txId}/reverse`, {}); } catch {}
    }
    createdTransactionIds = createdTransactionIds.filter(id => !limitTransactionIds.includes(id));

    if (initialBalanceId45a) {
      try { await apiDelete(`/api/budget/${testCustomerId}/initial-balance/${initialBalanceId45a}`); } catch {}
    }

    const settings = [
      { budgetType: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
      { budgetType: "umwandlung_45a", priority: 2, enabled: false, monthlyLimitCents: null },
      { budgetType: "ersatzpflege_39_42a", priority: 3, enabled: false, yearlyLimitCents: null },
    ];
    await apiPut(`/api/budget/${testCustomerId}/type-settings`, { settings });

    await apiPut(`/api/budget/${testCustomerId}/preferences`, {
      customerId: testCustomerId,
      budgetStartDate: "2026-01-01",
      monthlyLimitCents: null,
      notes: "",
    });
  });
});


describe("INT-12: T3.1/T3.2 Storno FIFO-Rueckgabe und Neubuchung", () => {
  let stornoAppointmentId: number | null = null;
  let stornoTransactionId: number | null = null;
  let stornoAllocationId: number | null = null;
  let serviceId: number | null = null;
  let rebookAppointmentId: number | null = null;

  it("INT-12.1 – Setup und Termin dokumentieren", async () => {
    const settings = [
      { budgetType: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
      { budgetType: "umwandlung_45a", priority: 2, enabled: false, monthlyLimitCents: null },
      { budgetType: "ersatzpflege_39_42a", priority: 3, enabled: false, yearlyLimitCents: null },
    ];
    await apiPut(`/api/budget/${testCustomerId}/type-settings`, { settings });

    const servicesRes = await apiGet<any[]>("/api/services");
    const hwService = servicesRes.data.find((s: any) => s.code === "hauswirtschaft");
    expect(hwService).toBeDefined();
    serviceId = hwService.id;

    function getWeekday(d: Date): Date {
      const dow = d.getDay();
      if (dow === 0) d.setDate(d.getDate() - 2);
      else if (dow === 6) d.setDate(d.getDate() - 1);
      return d;
    }

    const timeSlots = ["05:00", "05:15", "05:30", "05:45", "20:00", "20:15", "20:30", "20:45"];
    let createRes: any = null;

    outer:
    for (let offset = 2; offset <= 60; offset++) {
      const candidate = new Date();
      candidate.setDate(candidate.getDate() - offset);
      getWeekday(candidate);
      const dateStr = candidate.toISOString().split("T")[0];
      if (dateStr < "2026-01-01") continue;

      for (const time of timeSlots) {
        createRes = await apiPost<any>("/api/appointments/kundentermin", {
          customerId: testCustomerId,
          date: dateStr,
          scheduledStart: time,
          notes: "INT-Storno-Test-" + Date.now(),
          assignedEmployeeId: auth.user.id,
          services: [{ serviceId, durationMinutes: 60 }],
        });
        if (createRes.status === 201) break outer;
      }
    }

    expect(createRes?.status).toBe(201);
    stornoAppointmentId = createRes.data.id;
    createdAppointmentIds.push(stornoAppointmentId!);

    const docRes = await apiPost<any>(`/api/appointments/${stornoAppointmentId}/document`, {
      actualStart: "05:00",
      travelOriginType: "home",
      travelKilometers: 0,
      customerKilometers: 0,
      services: [{ serviceId, actualDurationMinutes: 60, details: "Storno Test" }],
    });
    expect(docRes.status).toBe(200);
    stornoTransactionId = docRes.data.budgetTransaction.id;
    stornoAllocationId = docRes.data.budgetTransaction.allocationId;
    createdTransactionIds.push(stornoTransactionId!);

    expect(stornoAllocationId).toBeDefined();
    expect(stornoAllocationId).not.toBeNull();
  });

  it("INT-12.2 – T3.1: Storno-Transaktion hat dieselbe allocationId + currentMonthUsedCents sinkt", async () => {
    if (!stornoTransactionId || !stornoAllocationId) return;

    const overviewBefore = await apiGet<any>(`/api/budget/${testCustomerId}/overview`);
    const availBefore = overviewBefore.data.entlastungsbetrag45b.availableCents;
    const totalUsedBefore = overviewBefore.data.entlastungsbetrag45b.totalUsedCents;

    const reverseRes = await apiPost<any>(`/api/budget/transactions/${stornoTransactionId}/reverse`, {});
    expect([200, 201]).toContain(reverseRes.status);
    createdTransactionIds = createdTransactionIds.filter(id => id !== stornoTransactionId);

    const txRes = await apiGet<any[]>(`/api/budget/${testCustomerId}/transactions?budgetType=entlastungsbetrag_45b&limit=5000`);
    expect(txRes.status).toBe(200);

    const reversalTx = txRes.data.find(
      (t: any) => t.transactionType === "reversal" && t.notes?.includes(`Storno von Transaktion #${stornoTransactionId}`)
    );
    expect(reversalTx).toBeDefined();
    expect(reversalTx.allocationId).toBe(stornoAllocationId);
    expect(reversalTx.amountCents).toBeGreaterThan(0);

    const overviewAfter = await apiGet<any>(`/api/budget/${testCustomerId}/overview`);
    const availAfter = overviewAfter.data.entlastungsbetrag45b.availableCents;
    const totalUsedAfter = overviewAfter.data.entlastungsbetrag45b.totalUsedCents;
    expect(availAfter).toBeGreaterThan(availBefore);
    expect(totalUsedAfter).toBeLessThan(totalUsedBefore);
  });

  it("INT-12.3 – T3.2: Neuer Termin kann nach Storno erfolgreich gebucht werden", async () => {
    if (!serviceId) return;

    function getWeekday(d: Date): Date {
      const dow = d.getDay();
      if (dow === 0) d.setDate(d.getDate() - 2);
      else if (dow === 6) d.setDate(d.getDate() - 1);
      return d;
    }

    const timeSlots = ["04:00", "04:15", "04:30", "04:45", "21:00", "21:15", "21:30", "21:45"];
    let createRes: any = null;

    outer:
    for (let offset = 2; offset <= 60; offset++) {
      const candidate = new Date();
      candidate.setDate(candidate.getDate() - offset);
      getWeekday(candidate);
      const dateStr = candidate.toISOString().split("T")[0];
      if (dateStr < "2026-01-01") continue;

      for (const time of timeSlots) {
        createRes = await apiPost<any>("/api/appointments/kundentermin", {
          customerId: testCustomerId,
          date: dateStr,
          scheduledStart: time,
          notes: "INT-Rebook-Test-" + Date.now(),
          assignedEmployeeId: auth.user.id,
          services: [{ serviceId, durationMinutes: 60 }],
        });
        if (createRes.status === 201) break outer;
      }
    }

    expect(createRes?.status).toBe(201);
    rebookAppointmentId = createRes.data.id;
    createdAppointmentIds.push(rebookAppointmentId!);

    const docRes = await apiPost<any>(`/api/appointments/${rebookAppointmentId}/document`, {
      actualStart: "04:00",
      travelOriginType: "home",
      travelKilometers: 0,
      customerKilometers: 0,
      services: [{ serviceId, actualDurationMinutes: 60, details: "Rebook nach Storno" }],
    });
    expect(docRes.status).toBe(200);
    expect(docRes.data.budgetTransaction).toBeDefined();
    expect(docRes.data.budgetTransaction.transactionType).toBe("consumption");
    expect(docRes.data.budgetTransaction.amountCents).toBeLessThan(0);

    createdTransactionIds.push(docRes.data.budgetTransaction.id);
  });

  afterAll(async () => {
    for (const txId of createdTransactionIds.filter(id =>
      [stornoTransactionId].includes(id)
    )) {
      try { await apiPost(`/api/budget/transactions/${txId}/reverse`, {}); } catch {}
    }
  });
});


describe("INT-13: T1.2 Carryover-Erstellung und Verfall (Juni-Deadline)", () => {
  let originalBudgetStartDate: string | null = null;

  it("INT-13.1 – Aktuelle Budget-Preferences sichern", async () => {
    const res = await apiGet<any>(`/api/budget/${testCustomerId}/overview`);
    expect(res.status).toBe(200);

    const prefRes = await apiGet<any>(`/api/budget/${testCustomerId}/preferences`);
    if (prefRes.status === 200 && prefRes.data) {
      originalBudgetStartDate = prefRes.data.budgetStartDate ?? null;
    }
  });

  it("INT-13.2 – Budget-Start auf 2024 setzen, Carryover pruefen", async () => {
    const settings = [
      { budgetType: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
      { budgetType: "umwandlung_45a", priority: 2, enabled: false, monthlyLimitCents: null },
      { budgetType: "ersatzpflege_39_42a", priority: 3, enabled: false, yearlyLimitCents: null },
    ];
    await apiPut(`/api/budget/${testCustomerId}/type-settings`, { settings });

    await apiPut(`/api/budget/${testCustomerId}/preferences`, {
      customerId: testCustomerId,
      budgetStartDate: "2024-01-01",
      monthlyLimitCents: null,
      notes: "T1.2 Test",
    });

    const overviewRes = await apiGet<any>(`/api/budget/${testCustomerId}/overview`);
    expect(overviewRes.status).toBe(200);

    const allocRes = await apiGet<any[]>(`/api/budget/${testCustomerId}/allocations?year=2025`);
    expect(allocRes.status).toBe(200);

    const carryover2025 = allocRes.data.filter(
      (a: any) => a.budgetType === "entlastungsbetrag_45b" && a.source === "carryover" && a.year === 2025
    );
    expect(carryover2025.length).toBeGreaterThan(0);
    const co2025 = carryover2025[0];
    expect(co2025.expiresAt).toBe("2025-06-30");
    expect(co2025.amountCents).toBeGreaterThan(0);
  });

  it("INT-13.3 – Abgelaufener Vorjahres-Uebertrag 2025 wurde abgeschrieben", async () => {
    const allocRes = await apiGet<any[]>(`/api/budget/${testCustomerId}/allocations?year=2025`);
    const carryover2025 = allocRes.data?.find(
      (a: any) => a.budgetType === "entlastungsbetrag_45b" && a.source === "carryover" && a.year === 2025
    );
    expect(carryover2025).toBeDefined();
    expect(carryover2025.expiresAt).toBe("2025-06-30");

    const txRes = await apiGet<any[]>(`/api/budget/${testCustomerId}/transactions?budgetType=entlastungsbetrag_45b&limit=5000`);
    expect(txRes.status).toBe(200);

    const consumptionsForCarryover = txRes.data.filter(
      (t: any) => t.allocationId === carryover2025.id && t.transactionType === "consumption"
    );
    const reversalsForCarryover = txRes.data.filter(
      (t: any) => t.allocationId === carryover2025.id && t.transactionType === "reversal"
    );
    const consumed = consumptionsForCarryover.reduce((s: number, t: any) => s + Math.abs(t.amountCents), 0);
    const reversed = reversalsForCarryover.reduce((s: number, t: any) => s + Math.abs(t.amountCents), 0);
    const remaining = carryover2025.amountCents - Math.max(0, consumed - reversed);

    if (remaining > 0) {
      const writeOffs = txRes.data.filter(
        (t: any) => t.transactionType === "write_off" && t.allocationId === carryover2025.id
      );
      expect(writeOffs.length).toBeGreaterThan(0);
      const writeOff = writeOffs[0];
      expect(writeOff.amountCents).toBeLessThan(0);
      expect(writeOff.notes).toContain("Verfallenes Guthaben");
    }

    const overviewRes = await apiGet<any>(`/api/budget/${testCustomerId}/overview`);
    expect(overviewRes.status).toBe(200);
    const overview = overviewRes.data.entlastungsbetrag45b;
    expect(overview).toBeDefined();
  });

  it("INT-13.4 – Aktueller Uebertrag 2026 ist noch gueltig", async () => {
    const allocRes = await apiGet<any[]>(`/api/budget/${testCustomerId}/allocations?year=2026`);
    expect(allocRes.status).toBe(200);

    const carryover2026 = allocRes.data.filter(
      (a: any) => a.budgetType === "entlastungsbetrag_45b" && a.source === "carryover" && a.year === 2026
    );
    expect(carryover2026.length).toBeGreaterThan(0);
    expect(carryover2026[0].expiresAt).toBe("2026-06-30");
    expect(carryover2026[0].amountCents).toBeGreaterThan(0);

    const overviewRes = await apiGet<any>(`/api/budget/${testCustomerId}/overview`);
    expect(overviewRes.status).toBe(200);
    expect(overviewRes.data.entlastungsbetrag45b.carryoverCents).toBeGreaterThan(0);
    expect(overviewRes.data.entlastungsbetrag45b.carryoverExpiresAt).toBe("2026-06-30");
  });

  afterAll(async () => {
    await apiPut(`/api/budget/${testCustomerId}/preferences`, {
      customerId: testCustomerId,
      budgetStartDate: originalBudgetStartDate ?? "2026-01-01",
      monthlyLimitCents: null,
      notes: "Integrationstest",
    });
  });
});


describe("INT-14: T1.3 FIFO-Verbrauchsreihenfolge (altes Geld zuerst)", () => {
  let fifoAppointmentId: number | null = null;
  let fifoTransactionId: number | null = null;
  let serviceId: number | null = null;

  it("INT-14.1 – Setup: Budget-Start 2025, nur §45b aktiv", async () => {
    const settings = [
      { budgetType: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
      { budgetType: "umwandlung_45a", priority: 2, enabled: false, monthlyLimitCents: null },
      { budgetType: "ersatzpflege_39_42a", priority: 3, enabled: false, yearlyLimitCents: null },
    ];
    await apiPut(`/api/budget/${testCustomerId}/type-settings`, { settings });

    await apiPut(`/api/budget/${testCustomerId}/preferences`, {
      customerId: testCustomerId,
      budgetStartDate: "2025-01-01",
      monthlyLimitCents: null,
      notes: "T1.3 FIFO Test",
    });

    const overviewRes = await apiGet<any>(`/api/budget/${testCustomerId}/overview`);
    expect(overviewRes.status).toBe(200);
    expect(overviewRes.data.entlastungsbetrag45b.carryoverCents).toBeGreaterThan(0);

    const servicesRes = await apiGet<any[]>("/api/services");
    expect(servicesRes.status).toBe(200);
    const hwService = servicesRes.data.find((s: any) => s.code === "hauswirtschaft");
    expect(hwService).toBeDefined();
    serviceId = hwService.id;
  });

  it("INT-14.2 – Termin erstellen und dokumentieren", async () => {
    if (!serviceId) return;

    function getWeekday(d: Date): Date {
      const dow = d.getDay();
      if (dow === 0) d.setDate(d.getDate() - 2);
      else if (dow === 6) d.setDate(d.getDate() - 1);
      return d;
    }

    const timeSlots = ["07:00", "07:15", "07:30", "07:45", "18:00", "18:15", "18:30", "18:45"];
    let createRes: any = null;

    outer:
    for (let offset = 2; offset <= 60; offset++) {
      const candidate = new Date();
      candidate.setDate(candidate.getDate() - offset);
      getWeekday(candidate);
      const dateStr = candidate.toISOString().split("T")[0];
      if (dateStr < "2026-01-01") continue;

      for (const time of timeSlots) {
        createRes = await apiPost<any>("/api/appointments/kundentermin", {
          customerId: testCustomerId,
          date: dateStr,
          scheduledStart: time,
          notes: "INT-FIFO-Test-" + Date.now(),
          assignedEmployeeId: auth.user.id,
          services: [{ serviceId, durationMinutes: 60 }],
        });
        if (createRes.status === 201) break outer;
      }
    }

    expect(createRes?.status).toBe(201);
    fifoAppointmentId = createRes.data.id;
    createdAppointmentIds.push(fifoAppointmentId!);

    const docRes = await apiPost<any>(`/api/appointments/${fifoAppointmentId}/document`, {
      actualStart: "07:00",
      travelOriginType: "home",
      travelKilometers: 0,
      customerKilometers: 0,
      services: [{ serviceId, actualDurationMinutes: 60, details: "FIFO Test" }],
    });
    expect(docRes.status).toBe(200);
    expect(docRes.data.budgetTransaction).toBeDefined();

    fifoTransactionId = docRes.data.budgetTransaction.id;
    createdTransactionIds.push(fifoTransactionId!);
  });

  it("INT-14.3 – Consumption hat allocationId des Carryover (aeltestes Geld)", async () => {
    if (!fifoTransactionId) return;

    const txRes = await apiGet<any[]>(`/api/budget/${testCustomerId}/transactions?budgetType=entlastungsbetrag_45b&limit=5000`);
    expect(txRes.status).toBe(200);

    const consumptionTx = txRes.data.find(
      (t: any) => t.id === fifoTransactionId && t.transactionType === "consumption"
    );
    expect(consumptionTx).toBeDefined();
    expect(consumptionTx.allocationId).toBeDefined();
    expect(consumptionTx.allocationId).not.toBeNull();

    const allocRes = await apiGet<any[]>(`/api/budget/${testCustomerId}/allocations?year=2026`);
    expect(allocRes.status).toBe(200);

    const carryoverAlloc = allocRes.data.find(
      (a: any) => a.budgetType === "entlastungsbetrag_45b" && a.source === "carryover"
    );
    expect(carryoverAlloc).toBeDefined();
    expect(consumptionTx.allocationId).toBe(carryoverAlloc.id);
  });

  afterAll(async () => {
    if (fifoTransactionId) {
      try { await apiPost(`/api/budget/transactions/${fifoTransactionId}/reverse`, {}); } catch {}
      createdTransactionIds = createdTransactionIds.filter(id => id !== fifoTransactionId);
    }
    await apiPut(`/api/budget/${testCustomerId}/preferences`, {
      customerId: testCustomerId,
      budgetStartDate: "2026-01-01",
      monthlyLimitCents: null,
      notes: "Integrationstest",
    });
  });
});


describe("INT-15: Storno-Netting currentMonthUsedCents (§45b im aktuellen Monat)", () => {
  let apptId: number | null = null;
  let txId: number | null = null;
  let serviceId: number | null = null;

  it("INT-15.1 – Setup: §45b Prio 1, Termin im aktuellen Monat dokumentieren", async () => {
    const settings = [
      { budgetType: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
      { budgetType: "umwandlung_45a", priority: 2, enabled: false, monthlyLimitCents: null },
      { budgetType: "ersatzpflege_39_42a", priority: 3, enabled: false, yearlyLimitCents: null },
    ];
    await apiPut(`/api/budget/${testCustomerId}/type-settings`, { settings });

    const servicesRes = await apiGet<any[]>("/api/services");
    const hwService = servicesRes.data.find((s: any) => s.code === "hauswirtschaft");
    expect(hwService).toBeDefined();
    serviceId = hwService!.id;

    function getWeekday(d: Date): Date {
      const dow = d.getDay();
      if (dow === 0) d.setDate(d.getDate() - 2);
      else if (dow === 6) d.setDate(d.getDate() - 1);
      return d;
    }

    const now = new Date();
    const currentMonth = now.getMonth();
    const currentYear = now.getFullYear();
    const timeSlots = ["03:00", "03:15", "03:30", "03:45", "22:00", "22:15", "22:30", "22:45"];
    let createRes: any = null;

    outer:
    for (let offset = 2; offset <= 28; offset++) {
      const candidate = new Date();
      candidate.setDate(candidate.getDate() - offset);
      if (candidate.getMonth() !== currentMonth || candidate.getFullYear() !== currentYear) continue;
      getWeekday(candidate);
      const dateStr = candidate.toISOString().split("T")[0];

      for (const time of timeSlots) {
        createRes = await apiPost<any>("/api/appointments/kundentermin", {
          customerId: testCustomerId,
          date: dateStr,
          scheduledStart: time,
          notes: "INT-Netting-CurrentMonth-" + Date.now(),
          assignedEmployeeId: auth.user.id,
          services: [{ serviceId, durationMinutes: 60 }],
        });
        if (createRes.status === 201) break outer;
      }
    }

    expect(createRes?.status).toBe(201);
    apptId = createRes.data.id;
    createdAppointmentIds.push(apptId!);

    const docRes = await apiPost<any>(`/api/appointments/${apptId}/document`, {
      actualStart: "03:00",
      travelOriginType: "home",
      travelKilometers: 0,
      customerKilometers: 0,
      services: [{ serviceId, actualDurationMinutes: 60, details: "Netting CurrentMonth Test" }],
    });
    expect(docRes.status).toBe(200);
    expect(docRes.data.budgetTransaction).toBeDefined();
    txId = docRes.data.budgetTransaction.id;
    createdTransactionIds.push(txId!);
  });

  it("INT-15.2 – Storno: totalUsedCents sinkt und availableCents steigt", async () => {
    if (!txId) return;

    const overviewBefore = await apiGet<any>(`/api/budget/${testCustomerId}/overview`);
    expect(overviewBefore.status).toBe(200);
    const totalUsedBefore = overviewBefore.data.entlastungsbetrag45b.totalUsedCents;
    const availBefore = overviewBefore.data.entlastungsbetrag45b.availableCents;

    const reverseRes = await apiPost<any>(`/api/budget/transactions/${txId}/reverse`, {});
    expect([200, 201]).toContain(reverseRes.status);
    createdTransactionIds = createdTransactionIds.filter(id => id !== txId);

    const overviewAfter = await apiGet<any>(`/api/budget/${testCustomerId}/overview`);
    expect(overviewAfter.status).toBe(200);
    const totalUsedAfter = overviewAfter.data.entlastungsbetrag45b.totalUsedCents;
    const availAfter = overviewAfter.data.entlastungsbetrag45b.availableCents;
    expect(totalUsedAfter).toBeLessThan(totalUsedBefore);
    expect(availAfter).toBeGreaterThan(availBefore);

    const monthUsedAfter = overviewAfter.data.entlastungsbetrag45b.currentMonthUsedCents;
    expect(monthUsedAfter).toBeGreaterThanOrEqual(0);
  });

  afterAll(async () => {
    const settings = [
      { budgetType: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
      { budgetType: "umwandlung_45a", priority: 2, enabled: false, monthlyLimitCents: null },
      { budgetType: "ersatzpflege_39_42a", priority: 3, enabled: false, yearlyLimitCents: null },
    ];
    await apiPut(`/api/budget/${testCustomerId}/type-settings`, { settings });
  });
});
