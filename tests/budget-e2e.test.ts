import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  getAuthCookie,
  apiGet,
  apiPost,
  apiPut,
  apiDelete,
  getTodayDate,
  runCleanup,
} from "./test-utils";
import {
  setupBudgetScenario,
  type BudgetScenarioHandle,
} from "./helpers/budget-scenarios";

beforeAll(async () => {
  await getAuthCookie();
});

afterAll(async () => {
  await runCleanup();
});

/**
 * Picks the most recent past weekday (Mon–Fri). Falls back to the next
 * weekday if no past weekday exists in the lookup window. The returned
 * date is suitable for documenting an appointment in the past.
 */
function pastWeekday(daysBack = 7): string {
  const today = new Date();
  for (let offset = daysBack; offset <= daysBack + 14; offset++) {
    const d = new Date(today);
    d.setDate(today.getDate() - offset);
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue;
    return d.toISOString().split("T")[0];
  }
  throw new Error("Kein Werktag im Lookup-Fenster gefunden");
}

/**
 * Picks the most recent weekday inside the current calendar month. Falls
 * back to a future weekday inside the same month if no past one exists.
 */
function weekdayInCurrentMonth(): string {
  const today = new Date();
  const month = today.getMonth();
  const year = today.getFullYear();
  for (let offset = 0; offset <= 28; offset++) {
    const d = new Date(today);
    d.setDate(today.getDate() - offset);
    if (d.getMonth() !== month || d.getFullYear() !== year) break;
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue;
    return d.toISOString().split("T")[0];
  }
  for (let offset = 1; offset <= 28; offset++) {
    const d = new Date(today);
    d.setDate(today.getDate() + offset);
    if (d.getMonth() !== month || d.getFullYear() !== year) break;
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue;
    return d.toISOString().split("T")[0];
  }
  throw new Error("Kein Werktag im aktuellen Monat gefunden");
}


describe("INT-1: §45b Allokation und Summary", () => {
  let scenario: BudgetScenarioHandle;

  beforeAll(async () => {
    scenario = await setupBudgetScenario({
      customerNamePrefix: "INT-1",
      preferences: { budgetStartDate: "2026-01-01", notes: "Integrationstest" },
      types: [
        { type: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
        { type: "umwandlung_45a", priority: 2, enabled: false, monthlyLimitCents: null },
        { type: "ersatzpflege_39_42a", priority: 3, enabled: false, yearlyLimitCents: null },
      ],
    });
  });

  afterAll(async () => {
    await scenario.cleanup();
  });

  it("INT-1.1 – Budget-Typ §45b ist aktiv mit Prio 1", async () => {
    const res = await apiGet<any[]>(`/api/budget/${scenario.customerId}/type-settings`);
    expect(res.status).toBe(200);
    const s45b = res.data.find((s: any) => s.budgetType === "entlastungsbetrag_45b");
    expect(s45b).toBeDefined();
    expect(s45b.enabled).toBe(true);
    expect(s45b.priority).toBe(1);
  });

  it("INT-1.2 – Budget-Startdatum 2026-01-01 ist gesetzt", async () => {
    const prefRes = await apiGet<any>(`/api/budget/${scenario.customerId}/preferences`);
    expect(prefRes.status).toBe(200);
    expect(prefRes.data.budgetStartDate).toBe("2026-01-01");
  });

  it("INT-1.3 – Overview enthält §45b mit korrektem totalAllocatedCents", async () => {
    const res = await apiGet<any>(`/api/budget/${scenario.customerId}/overview`);
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

  it("INT-1.4 – §45b monatlicher Anspruch ist 131,00€ (virtuelle Allokation)", async () => {
    // Architektur-Drift: §45b "monthly_auto"-Allokationen werden virtuell in
    // server/storage/budget/summary-queries.ts berechnet (siehe BB-1.2). Der
    // monatliche Anspruch wird über totalAllocatedCents % 13100 == 0 verifiziert.
    const res = await apiGet<any>(`/api/budget/${scenario.customerId}/overview`);
    expect(res.status).toBe(200);
    const s45b = res.data.entlastungsbetrag45b;
    const today = new Date();
    const startDate = new Date("2026-01-01");
    const expectedMonths = (today.getFullYear() - startDate.getFullYear()) * 12
      + (today.getMonth() + 1) - (startDate.getMonth() + 1) + 1;
    expect(s45b.totalAllocatedCents).toBeGreaterThanOrEqual(13100 * Math.max(1, expectedMonths));
    expect(s45b.totalAllocatedCents % 13100).toBe(0);
  });

  it("INT-1.5 – §45b Overview enthält carryoverCents und carryoverExpiresAt", async () => {
    const res = await apiGet<any>(`/api/budget/${scenario.customerId}/overview`);
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
  let scenario: BudgetScenarioHandle;

  beforeAll(async () => {
    scenario = await setupBudgetScenario({
      customerNamePrefix: "INT-2",
      pflegegrad: 3,
      types: [
        { type: "entlastungsbetrag_45b", priority: 2, enabled: true, monthlyLimitCents: null },
        { type: "umwandlung_45a", priority: 1, enabled: true, monthlyLimitCents: 59880 },
        { type: "ersatzpflege_39_42a", priority: 3, enabled: false, yearlyLimitCents: null },
      ],
    });
  });

  afterAll(async () => {
    await scenario.cleanup();
  });

  it("INT-2.1 – §45a ist aktiv mit PG3-Betrag", async () => {
    const res = await apiGet<any[]>(`/api/budget/${scenario.customerId}/type-settings`);
    expect(res.status).toBe(200);
    const s45a = res.data.find((s: any) => s.budgetType === "umwandlung_45a");
    expect(s45a).toBeDefined();
    expect(s45a.enabled).toBe(true);
    expect(s45a.monthlyLimitCents).toBe(59880);
  });

  it("INT-2.2 – Overview zeigt §45a mit currentMonthAllocatedCents > 0", async () => {
    const res = await apiGet<any>(`/api/budget/${scenario.customerId}/overview`);
    expect(res.status).toBe(200);

    const s45a = res.data.umwandlung45a;
    expect(s45a).toHaveProperty("monthlyBudgetCents");
    expect(s45a).toHaveProperty("currentMonthAllocatedCents");
    expect(s45a).toHaveProperty("currentMonthUsedCents");
    expect(s45a).toHaveProperty("currentMonthAvailableCents");
    expect(s45a.monthlyBudgetCents).toBe(59880);
    expect(s45a.currentMonthAllocatedCents).toBe(59880);
  });

  it("INT-2.3 – §45a Anspruch ist auf den aktuellen Monat begrenzt", async () => {
    // Architektur-Drift: §45a "monthly_auto"-Allokationen werden virtuell in
    // server/storage/budget/summary-queries.ts berechnet, nicht als Zeilen in
    // budget_allocations geschrieben. Die Monats-Begrenzung wird über
    // currentMonthAllocatedCents im Overview ausgedrückt.
    const res = await apiGet<any>(`/api/budget/${scenario.customerId}/overview`);
    expect(res.status).toBe(200);
    const s45a = res.data.umwandlung45a;
    expect(s45a.monthlyBudgetCents).toBe(59880);
    expect(s45a.currentMonthAllocatedCents).toBe(59880);
  });
});


describe("INT-3: §39/42a Allokation und Summary", () => {
  let scenario: BudgetScenarioHandle;

  beforeAll(async () => {
    scenario = await setupBudgetScenario({
      customerNamePrefix: "INT-3",
      pflegegrad: 3,
      types: [
        { type: "entlastungsbetrag_45b", priority: 2, enabled: true, monthlyLimitCents: null },
        { type: "umwandlung_45a", priority: 1, enabled: true, monthlyLimitCents: 59880 },
        { type: "ersatzpflege_39_42a", priority: 3, enabled: true, yearlyLimitCents: 353900 },
      ],
    });
  });

  afterAll(async () => {
    await scenario.cleanup();
  });

  it("INT-3.1 – §39/42a ist aktiv mit Jahresbetrag", async () => {
    const res = await apiGet<any[]>(`/api/budget/${scenario.customerId}/type-settings`);
    expect(res.status).toBe(200);
    const s42a = res.data.find((s: any) => s.budgetType === "ersatzpflege_39_42a");
    expect(s42a).toBeDefined();
    expect(s42a.enabled).toBe(true);
    expect(s42a.yearlyLimitCents).toBe(353900);
  });

  it("INT-3.2 – Overview zeigt §39/42a mit currentYearAllocatedCents", async () => {
    const res = await apiGet<any>(`/api/budget/${scenario.customerId}/overview`);
    expect(res.status).toBe(200);

    const s42a = res.data.ersatzpflege39_42a;
    expect(s42a).toHaveProperty("yearlyBudgetCents");
    expect(s42a).toHaveProperty("currentYearAllocatedCents");
    expect(s42a).toHaveProperty("currentYearUsedCents");
    expect(s42a).toHaveProperty("currentYearAvailableCents");
    expect(s42a.yearlyBudgetCents).toBe(353900);
    expect(s42a.currentYearAllocatedCents).toBe(353900);
  });

  it("INT-3.3 – §39/42a Anspruch ist auf das aktuelle Jahr begrenzt", async () => {
    // Architektur-Drift: §39/42a "yearly_auto"-Allokation wird virtuell aus
    // den Type-Settings (yearlyLimitCents) berechnet, nicht als Zeile mit
    // expiresAt = 31.12. geschrieben. Die Jahres-Begrenzung wird über
    // currentYearAllocatedCents (= yearlyBudgetCents) im Overview ausgedrückt.
    const res = await apiGet<any>(`/api/budget/${scenario.customerId}/overview`);
    expect(res.status).toBe(200);
    const s42a = res.data.ersatzpflege39_42a;
    expect(s42a.yearlyBudgetCents).toBe(353900);
    expect(s42a.currentYearAllocatedCents).toBe(353900);
  });
});


describe("INT-4: Manuelle Korrektur und Storno", () => {
  let scenario: BudgetScenarioHandle;
  let adjustmentTxId: number | null = null;

  beforeAll(async () => {
    scenario = await setupBudgetScenario({
      customerNamePrefix: "INT-4",
      preferences: { budgetStartDate: "2026-01-01" },
      types: [
        { type: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
        { type: "umwandlung_45a", priority: 2, enabled: false, monthlyLimitCents: null },
        { type: "ersatzpflege_39_42a", priority: 3, enabled: false, yearlyLimitCents: null },
      ],
    });
  });

  afterAll(async () => {
    await scenario.cleanup();
  });

  it("INT-4.1 – Manuelle Korrektur erstellen", async () => {
    const res = await apiPost<any>(`/api/budget/${scenario.customerId}/manual-adjustment`, {
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
    const res = await apiGet<any[]>(`/api/budget/${scenario.customerId}/transactions?budgetType=entlastungsbetrag_45b&limit=5`);
    expect(res.status).toBe(200);

    if (adjustmentTxId) {
      const found = res.data.find((t: any) => t.id === adjustmentTxId);
      expect(found).toBeDefined();
      expect(found.transactionType).toBe("manual_adjustment");
    }
  });

  it("INT-4.3 – Korrektur reduziert availableCents", async () => {
    const overviewBefore = await apiGet<any>(`/api/budget/${scenario.customerId}/overview`);
    const availBefore = overviewBefore.data.entlastungsbetrag45b.availableCents;

    if (adjustmentTxId) {
      await apiPost(`/api/budget/transactions/${adjustmentTxId}/reverse`, {});
      adjustmentTxId = null;
    }

    const overviewAfter = await apiGet<any>(`/api/budget/${scenario.customerId}/overview`);
    const availAfter = overviewAfter.data.entlastungsbetrag45b.availableCents;
    expect(availAfter).toBeGreaterThanOrEqual(availBefore);
  });
});


describe("INT-5: Kostenschaetzung", () => {
  let scenario: BudgetScenarioHandle;

  beforeAll(async () => {
    scenario = await setupBudgetScenario({
      customerNamePrefix: "INT-5",
      preferences: { budgetStartDate: "2026-01-01" },
      types: [
        { type: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
        { type: "umwandlung_45a", priority: 2, enabled: false, monthlyLimitCents: null },
        { type: "ersatzpflege_39_42a", priority: 3, enabled: false, yearlyLimitCents: null },
      ],
    });
  });

  afterAll(async () => {
    await scenario.cleanup();
  });

  it("INT-5.1 – Kostenschätzung fuer 60 Min HW liefert totalCents > 0", async () => {
    const today = getTodayDate();
    const res = await apiGet<any>(
      `/api/budget/${scenario.customerId}/cost-estimate?date=${today}&hauswirtschaftMinutes=60&alltagsbegleitungMinutes=0&travelKilometers=0&customerKilometers=0`
    );
    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty("totalCents");
    expect(res.data.totalCents).toBeGreaterThan(0);
  });

  it("INT-5.2 – Kostenschaetzung fuer 0 Min liefert totalCents = 0", async () => {
    const today = getTodayDate();
    const res = await apiGet<any>(
      `/api/budget/${scenario.customerId}/cost-estimate?date=${today}&hauswirtschaftMinutes=0&alltagsbegleitungMinutes=0&travelKilometers=0&customerKilometers=0`
    );
    expect(res.status).toBe(200);
    expect(res.data.totalCents).toBe(0);
  });
});


describe("INT-6: Kaskadenverbrauch ueber Termin-Dokumentation", () => {
  let scenario: BudgetScenarioHandle;

  beforeAll(async () => {
    scenario = await setupBudgetScenario({
      customerNamePrefix: "INT-6",
      preferences: { budgetStartDate: "2026-01-01" },
      types: [
        { type: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
        { type: "umwandlung_45a", priority: 2, enabled: false, monthlyLimitCents: null },
        { type: "ersatzpflege_39_42a", priority: 3, enabled: false, yearlyLimitCents: null },
      ],
      initialBalance: {
        type: "entlastungsbetrag_45b",
        amountCents: 50000,
        validFrom: "2026-01-01",
      },
      appointments: [
        {
          date: pastWeekday(),
          scheduledStart: "09:00",
          services: [{ code: "hauswirtschaft", durationMinutes: 60 }],
          document: true,
          notes: "INT-6 HW Termin",
        },
      ],
    });
  });

  afterAll(async () => {
    await scenario.cleanup();
  });

  it("INT-6.1 – Hauswirtschaft-Service ist im Katalog vorhanden", async () => {
    const servicesRes = await apiGet<any[]>("/api/services");
    expect(servicesRes.status).toBe(200);
    const hwService = servicesRes.data.find((s: any) => s.code === "hauswirtschaft");
    expect(hwService).toBeDefined();
  });

  it("INT-6.2 – Kundentermin wurde erstellt", async () => {
    expect(scenario.appointmentIds.length).toBe(1);
    expect(scenario.appointmentIds[0]).toBeGreaterThan(0);
  });

  it("INT-6.3 – Budget-Overview enthält §45b mit Initial-Balance", async () => {
    const res = await apiGet<any>(`/api/budget/${scenario.customerId}/overview`);
    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty("entlastungsbetrag45b");
  });

  it("INT-6.4 – Termin-Dokumentation hat Budget-Transaktion erzeugt", async () => {
    expect(scenario.transactions.length).toBeGreaterThanOrEqual(1);
    const tx = scenario.transactions[0];
    expect(tx.appointmentId).toBe(scenario.appointmentIds[0]);
    expect(tx.amountCents).toBeLessThan(0);

    const txRes = await apiGet<any[]>(`/api/budget/${scenario.customerId}/transactions?limit=5000`);
    expect(txRes.status).toBe(200);
    const consumption = txRes.data.find(
      (t: any) => t.id === tx.id && t.transactionType === "consumption"
    );
    expect(consumption).toBeDefined();
    expect(consumption!.amountCents).toBeLessThan(0);
  });

  it("INT-6.5 – Nach Dokumentation: Verbrauch in einem der Toepfe sichtbar", async () => {
    const apptId = scenario.appointmentIds[0];
    const txRes = await apiGet<any[]>(`/api/budget/${scenario.customerId}/transactions?limit=5000`);
    expect(txRes.status).toBe(200);

    const consumption = txRes.data.find(
      (t: any) => t.appointmentId === apptId && t.transactionType === "consumption"
    );
    expect(consumption).toBeDefined();
    expect(consumption.amountCents).toBeLessThan(0);
  });
});


describe("INT-7: Doppelbuchungsschutz", () => {
  let scenario: BudgetScenarioHandle;

  beforeAll(async () => {
    scenario = await setupBudgetScenario({
      customerNamePrefix: "INT-7",
      preferences: { budgetStartDate: "2026-01-01" },
      types: [
        { type: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
        { type: "umwandlung_45a", priority: 2, enabled: false, monthlyLimitCents: null },
        { type: "ersatzpflege_39_42a", priority: 3, enabled: false, yearlyLimitCents: null },
      ],
      initialBalance: {
        type: "entlastungsbetrag_45b",
        amountCents: 50000,
        validFrom: "2026-01-01",
      },
      appointments: [
        {
          date: pastWeekday(),
          scheduledStart: "10:00",
          services: [{ code: "hauswirtschaft", durationMinutes: 60 }],
          document: true,
          notes: "INT-7 bereits dokumentiert",
        },
      ],
    });
  });

  afterAll(async () => {
    await scenario.cleanup();
  });

  it("INT-7.1 – Zweite Dokumentation desselben Termins wird abgelehnt (ALREADY_COMPLETED)", async () => {
    const apptId = scenario.appointmentIds[0];
    expect(apptId).toBeGreaterThan(0);

    const servicesRes = await apiGet<any[]>("/api/services");
    const hwService = servicesRes.data.find((s: any) => s.code === "hauswirtschaft");
    expect(hwService).toBeDefined();

    const docRes = await apiPost<any>(`/api/appointments/${apptId}/document`, {
      actualStart: "10:00",
      travelOriginType: "home",
      travelKilometers: 0,
      services: [{ serviceId: hwService!.id, actualDurationMinutes: 30, details: "Doppeltest" }],
    });

    expect(docRes.status).toBe(403);
    expect(docRes.data.error).toBe("ALREADY_COMPLETED");
  });
});


describe("INT-9: Initiale Startwerte (initial_balance)", () => {
  let scenario: BudgetScenarioHandle;

  beforeAll(async () => {
    scenario = await setupBudgetScenario({
      customerNamePrefix: "INT-9",
      types: [
        { type: "entlastungsbetrag_45b", enabled: true, priority: 1, monthlyLimitCents: 12500 },
        { type: "umwandlung_45a", enabled: false, priority: 2, monthlyLimitCents: null },
        { type: "ersatzpflege_39_42a", enabled: false, priority: 3, yearlyLimitCents: null },
      ],
    });
  });

  afterAll(async () => {
    await scenario.cleanup();
  });

  it("INT-9.1 – Bestehende Startwerte aufraeumen und neuen setzen", async () => {
    const res = await apiPost<any>(`/api/budget/${scenario.customerId}/initial-balance/entlastungsbetrag_45b`, {
      amountCents: 50000,
      validFrom: "2025-11",
    });
    expect([200, 201]).toContain(res.status);
  });

  it("INT-9.2 – Startwert erscheint in initial-balances Liste", async () => {
    const res = await apiGet<any[]>(`/api/budget/${scenario.customerId}/initial-balances/entlastungsbetrag_45b`);
    expect(res.status).toBe(200);

    const ib = res.data.find(
      (a: any) => a.source === "initial_balance" && a.amountCents === 50000
    );
    expect(ib).toBeDefined();
    expect(ib.amountCents).toBe(50000);
  });

  it("INT-9.3 – Startwert loeschen (Aufraeumen)", async () => {
    const allocRes = await apiGet<any[]>(`/api/budget/${scenario.customerId}/initial-balances/entlastungsbetrag_45b`);
    if (allocRes.status === 200 && Array.isArray(allocRes.data)) {
      for (const ib of allocRes.data) {
        if (ib.source === "initial_balance") {
          await apiDelete(`/api/budget/${scenario.customerId}/initial-balance/${ib.id}`);
        }
      }
    }
  });
});


describe("INT-10: Alle drei Toepfe zusammen (vollstaendige Kaskade)", () => {
  let scenario: BudgetScenarioHandle;

  beforeAll(async () => {
    scenario = await setupBudgetScenario({
      customerNamePrefix: "INT-10",
      preferences: { budgetStartDate: "2026-01-01" },
      types: [
        { type: "umwandlung_45a", priority: 1, enabled: true, monthlyLimitCents: 59880 },
        { type: "entlastungsbetrag_45b", priority: 2, enabled: true, monthlyLimitCents: null },
        { type: "ersatzpflege_39_42a", priority: 3, enabled: true, yearlyLimitCents: 353900 },
      ],
    });
  });

  afterAll(async () => {
    await scenario.cleanup();
  });

  it("INT-10.1 – Alle Toepfe sind aktiv", async () => {
    const res = await apiGet<any[]>(`/api/budget/${scenario.customerId}/type-settings`);
    expect(res.status).toBe(200);
    const enabled = res.data.filter((s: any) => s.enabled);
    expect(enabled.length).toBe(3);
  });

  it("INT-10.2 – Overview zeigt alle drei Toepfe mit Daten", async () => {
    const res = await apiGet<any>(`/api/budget/${scenario.customerId}/overview`);
    expect(res.status).toBe(200);

    expect(res.data.entlastungsbetrag45b.totalAllocatedCents).toBeGreaterThan(0);
    expect(res.data.umwandlung45a.currentMonthAllocatedCents).toBeGreaterThan(0);
    expect(res.data.ersatzpflege39_42a.currentYearAllocatedCents).toBeGreaterThan(0);
  });

  it("INT-10.3 – Typ-Einstellungen korrekte Prioritaeten", async () => {
    const res = await apiGet<any[]>(`/api/budget/${scenario.customerId}/type-settings`);
    expect(res.status).toBe(200);

    const s45a = res.data.find((s: any) => s.budgetType === "umwandlung_45a");
    const s45b = res.data.find((s: any) => s.budgetType === "entlastungsbetrag_45b");
    const s42a = res.data.find((s: any) => s.budgetType === "ersatzpflege_39_42a");

    expect(s45a?.priority).toBeLessThan(s45b?.priority);
    expect(s45b?.priority).toBeLessThan(s42a?.priority);
  });
});


describe("INT-11: T2.3 User-Monatslimit EB (Ueberlauf in naechsten Topf)", () => {
  let scenario: BudgetScenarioHandle;
  let limitAppointmentId: number | null = null;
  let limitTransactionIds: number[] = [];
  let serviceId: number | null = null;
  let effectiveLimitCents = 0;
  const monthlyLimitCentsEB = 5000;

  beforeAll(async () => {
    const now = new Date();
    const validFromMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    scenario = await setupBudgetScenario({
      customerNamePrefix: "INT-11",
      preferences: { budgetStartDate: "2026-01-01", notes: "T2.3 EB Limit Test" },
      initialBalance: {
        type: "umwandlung_45a",
        amountCents: 50000,
        validFrom: validFromMonth,
      },
      types: [
        { type: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: monthlyLimitCentsEB },
        { type: "umwandlung_45a", priority: 2, enabled: true, monthlyLimitCents: null },
        { type: "ersatzpflege_39_42a", priority: 3, enabled: false, yearlyLimitCents: null },
      ],
    });
  });

  afterAll(async () => {
    for (const txId of limitTransactionIds) {
      try { await apiPost(`/api/budget/transactions/${txId}/reverse`, {}); } catch {}
    }
    await scenario.cleanup();
  });

  it("INT-11.1 – Setup: §45b mit 50€ Monatslimit Prio 1, §45a als Auffang Prio 2", async () => {
    const overviewRes = await apiGet<any>(`/api/budget/${scenario.customerId}/overview`);
    expect(overviewRes.status).toBe(200);
    expect(overviewRes.data.entlastungsbetrag45b.totalAllocatedCents).toBeGreaterThan(0);
    expect(overviewRes.data.umwandlung45a.currentMonthAllocatedCents).toBeGreaterThan(0);

    const carryoverCents = overviewRes.data.entlastungsbetrag45b.carryoverCents ?? 0;
    effectiveLimitCents = monthlyLimitCentsEB + carryoverCents;

    const servicesRes = await apiGet<any[]>("/api/services");
    const hwService = servicesRes.data.find((s: any) => s.code === "hauswirtschaft");
    expect(hwService).toBeDefined();
    serviceId = hwService.id;
  });

  it("INT-11.2 – Termin erstellen + dokumentieren (Kosten > 10€)", async () => {
    if (!serviceId) return;

    const dateStr = weekdayInCurrentMonth();
    const createRes = await apiPost<any>("/api/appointments/kundentermin", {
      customerId: scenario.customerId,
      date: dateStr,
      scheduledStart: "06:00",
      notes: "INT-EB-Limit-Test-" + Date.now(),
      assignedEmployeeId: scenario.employeeId,
      services: [{ serviceId, durationMinutes: 120 }],
    });

    expect(createRes?.status).toBe(201);
    limitAppointmentId = createRes.data.id;

    const docRes = await apiPost<any>(`/api/appointments/${limitAppointmentId}/document`, {
      actualStart: "06:00",
      travelOriginType: "home",
      travelKilometers: 0,
      customerKilometers: 0,
      services: [{ serviceId, actualDurationMinutes: 120, details: "EB Limit Test 120min" }],
    });
    expect(docRes.status).toBe(200);
    expect(docRes.data.budgetTransaction).toBeDefined();
    limitTransactionIds.push(docRes.data.budgetTransaction.id);
  });

  it("INT-11.3 – §45b-Anteil wird durch effektives Monatslimit gedeckelt", async () => {
    if (!limitAppointmentId) return;

    const txRes = await apiGet<any[]>(`/api/budget/${scenario.customerId}/transactions?limit=5000`);
    expect(txRes.status).toBe(200);

    const consumptions = txRes.data.filter(
      (t: any) => t.appointmentId === limitAppointmentId && t.transactionType === "consumption"
    );
    expect(consumptions.length).toBeGreaterThanOrEqual(1);

    const eb45b = consumptions.filter((t: any) => t.budgetType === "entlastungsbetrag_45b");
    const eb45a = consumptions.filter((t: any) => t.budgetType === "umwandlung_45a");

    const total45bCents = eb45b.reduce((sum: number, t: any) => sum + Math.abs(t.amountCents), 0);
    const total45aCents = eb45a.reduce((sum: number, t: any) => sum + Math.abs(t.amountCents), 0);
    const totalCents = total45bCents + total45aCents;

    expect(totalCents).toBeGreaterThan(0);
    expect(total45bCents).toBeGreaterThan(0);
    expect(total45bCents).toBeLessThanOrEqual(effectiveLimitCents);

    if (totalCents > effectiveLimitCents) {
      expect(total45aCents).toBeGreaterThan(0);
    }
  });
});


describe("INT-12: T3.1/T3.2 Storno FIFO-Rueckgabe und Neubuchung", () => {
  let scenario: BudgetScenarioHandle;
  let stornoTransactionId: number | null = null;
  let stornoAllocationId: number | null = null;
  let rebookTransactionId: number | null = null;

  beforeAll(async () => {
    scenario = await setupBudgetScenario({
      customerNamePrefix: "INT-12",
      preferences: { budgetStartDate: "2026-01-01" },
      types: [
        { type: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
        { type: "umwandlung_45a", priority: 2, enabled: false, monthlyLimitCents: null },
        { type: "ersatzpflege_39_42a", priority: 3, enabled: false, yearlyLimitCents: null },
      ],
      initialBalance: {
        type: "entlastungsbetrag_45b",
        amountCents: 50000,
        validFrom: "2026-01-01",
      },
      appointments: [
        {
          date: pastWeekday(7),
          scheduledStart: "05:00",
          services: [{ code: "hauswirtschaft", durationMinutes: 60 }],
          document: true,
          notes: "INT-12 Storno",
        },
      ],
    });

    const tx = scenario.transactions[0];
    stornoTransactionId = tx.id;
    stornoAllocationId = tx.allocationId;
  });

  afterAll(async () => {
    if (rebookTransactionId !== null) {
      try { await apiPost(`/api/budget/transactions/${rebookTransactionId}/reverse`, {}); } catch {}
    }
    await scenario.cleanup();
  });

  it("INT-12.1 – Setup-Termin ist dokumentiert mit allocationId", async () => {
    expect(stornoTransactionId).not.toBeNull();
    expect(stornoAllocationId).not.toBeNull();
  });

  it("INT-12.2 – T3.1: Storno-Transaktion hat dieselbe allocationId + currentMonthUsedCents sinkt", async () => {
    if (!stornoTransactionId || !stornoAllocationId) return;

    const overviewBefore = await apiGet<any>(`/api/budget/${scenario.customerId}/overview`);
    const availBefore = overviewBefore.data.entlastungsbetrag45b.availableCents;
    const totalUsedBefore = overviewBefore.data.entlastungsbetrag45b.totalUsedCents;

    const reverseRes = await apiPost<any>(`/api/budget/transactions/${stornoTransactionId}/reverse`, {});
    expect([200, 201]).toContain(reverseRes.status);

    const txRes = await apiGet<any[]>(`/api/budget/${scenario.customerId}/transactions?budgetType=entlastungsbetrag_45b&limit=5000`);
    expect(txRes.status).toBe(200);

    const reversalTx = txRes.data.find(
      (t: any) => t.transactionType === "reversal" && t.notes?.includes(`Storno von Transaktion #${stornoTransactionId}`)
    );
    expect(reversalTx).toBeDefined();
    expect(reversalTx.allocationId).toBe(stornoAllocationId);
    expect(reversalTx.amountCents).toBeGreaterThan(0);

    const overviewAfter = await apiGet<any>(`/api/budget/${scenario.customerId}/overview`);
    const availAfter = overviewAfter.data.entlastungsbetrag45b.availableCents;
    const totalUsedAfter = overviewAfter.data.entlastungsbetrag45b.totalUsedCents;
    expect(availAfter).toBeGreaterThan(availBefore);
    expect(totalUsedAfter).toBeLessThan(totalUsedBefore);
  });

  it("INT-12.3 – T3.2: Neuer Termin kann nach Storno erfolgreich gebucht werden", async () => {
    const servicesRes = await apiGet<any[]>("/api/services");
    const hwService = servicesRes.data.find((s: any) => s.code === "hauswirtschaft");
    expect(hwService).toBeDefined();
    const serviceId = hwService!.id;

    const dateStr = pastWeekday(14);
    const createRes = await apiPost<any>("/api/appointments/kundentermin", {
      customerId: scenario.customerId,
      date: dateStr,
      scheduledStart: "04:00",
      notes: "INT-Rebook-Test-" + Date.now(),
      assignedEmployeeId: scenario.employeeId,
      services: [{ serviceId, durationMinutes: 60 }],
    });
    expect(createRes?.status).toBe(201);
    const rebookAppointmentId = createRes.data.id;

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
    rebookTransactionId = docRes.data.budgetTransaction.id;
  });
});


describe("INT-13: T1.2 Carryover-Erstellung und Verfall (Juni-Deadline)", () => {
  let scenario: BudgetScenarioHandle;

  beforeAll(async () => {
    scenario = await setupBudgetScenario({
      customerNamePrefix: "INT-13",
      preferences: { budgetStartDate: "2024-01-01", notes: "T1.2 Test" },
      types: [
        { type: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
        { type: "umwandlung_45a", priority: 2, enabled: false, monthlyLimitCents: null },
        { type: "ersatzpflege_39_42a", priority: 3, enabled: false, yearlyLimitCents: null },
      ],
    });
  });

  afterAll(async () => {
    await scenario.cleanup();
  });

  it("INT-13.1 – Aktuelle Budget-Preferences sichern", async () => {
    const res = await apiGet<any>(`/api/budget/${scenario.customerId}/overview`);
    expect(res.status).toBe(200);

    const prefRes = await apiGet<any>(`/api/budget/${scenario.customerId}/preferences`);
    expect(prefRes.status).toBe(200);
  });

  it("INT-13.2 – Budget-Start auf 2024 setzen, Carryover pruefen", async () => {
    const overviewRes = await apiGet<any>(`/api/budget/${scenario.customerId}/overview`);
    expect(overviewRes.status).toBe(200);

    const allocRes = await apiGet<any[]>(`/api/budget/${scenario.customerId}/allocations?year=2025`);
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
    const allocRes = await apiGet<any[]>(`/api/budget/${scenario.customerId}/allocations?year=2025`);
    const carryover2025 = allocRes.data?.find(
      (a: any) => a.budgetType === "entlastungsbetrag_45b" && a.source === "carryover" && a.year === 2025
    );
    expect(carryover2025).toBeDefined();
    expect(carryover2025.expiresAt).toBe("2025-06-30");

    const txRes = await apiGet<any[]>(`/api/budget/${scenario.customerId}/transactions?budgetType=entlastungsbetrag_45b&limit=5000`);
    expect(txRes.status).toBe(200);

    const consumptionsForCarryover = txRes.data.filter(
      (t: any) => t.allocationId === carryover2025.id && t.transactionType === "consumption"
    );
    const reversalsForCarryover = txRes.data.filter(
      (t: any) => t.allocationId === carryover2025.id && t.transactionType === "reversal"
    );
    const writeOffs = txRes.data.filter(
      (t: any) => t.transactionType === "write_off" && t.allocationId === carryover2025.id
    );
    expect(writeOffs.length).toBeGreaterThan(0);
    const writeOff = writeOffs[0];
    expect(writeOff.amountCents).toBeLessThan(0);
    expect(writeOff.notes).toContain("Verfallenes Guthaben");

    const consumed = consumptionsForCarryover.reduce((s: number, t: any) => s + Math.abs(t.amountCents), 0);
    const reversed = reversalsForCarryover.reduce((s: number, t: any) => s + Math.abs(t.amountCents), 0);
    const writeOffTotal = writeOffs.reduce((s: number, t: any) => s + Math.abs(t.amountCents), 0);
    const netConsumed = Math.max(0, consumed - reversed);
    expect(writeOffTotal + netConsumed).toBe(carryover2025.amountCents);

    const overviewRes = await apiGet<any>(`/api/budget/${scenario.customerId}/overview`);
    expect(overviewRes.status).toBe(200);
    const overview = overviewRes.data.entlastungsbetrag45b;
    expect(overview).toBeDefined();

    const alloc2025 = await apiGet<any[]>(`/api/budget/${scenario.customerId}/allocations?year=2025`);
    const activeCarryover2025 = alloc2025.data?.filter(
      (a: any) => a.budgetType === "entlastungsbetrag_45b" && a.source === "carryover" && a.year === 2025 && !a.deletedAt
    ) ?? [];
    for (const co of activeCarryover2025) {
      const coWriteOffs = txRes.data.filter(
        (t: any) => t.transactionType === "write_off" && t.allocationId === co.id
      );
      const coConsumed = txRes.data.filter(
        (t: any) => t.allocationId === co.id && t.transactionType === "consumption"
      ).reduce((s: number, t: any) => s + Math.abs(t.amountCents), 0);
      const coReversed = txRes.data.filter(
        (t: any) => t.allocationId === co.id && t.transactionType === "reversal"
      ).reduce((s: number, t: any) => s + Math.abs(t.amountCents), 0);
      const coWriteOffTotal = coWriteOffs.reduce((s: number, t: any) => s + Math.abs(t.amountCents), 0);
      const coNet = Math.max(0, coConsumed - coReversed);
      expect(coWriteOffTotal + coNet).toBe(co.amountCents);
    }
  });

  it("INT-13.4 – Aktueller Uebertrag 2026 ist noch gueltig", async () => {
    const allocRes = await apiGet<any[]>(`/api/budget/${scenario.customerId}/allocations?year=2026`);
    expect(allocRes.status).toBe(200);

    const carryover2026 = allocRes.data.filter(
      (a: any) => a.budgetType === "entlastungsbetrag_45b" && a.source === "carryover" && a.year === 2026
    );
    expect(carryover2026.length).toBeGreaterThan(0);
    expect(carryover2026[0].expiresAt).toBe("2026-06-30");
    expect(carryover2026[0].amountCents).toBeGreaterThan(0);

    const overviewRes = await apiGet<any>(`/api/budget/${scenario.customerId}/overview`);
    expect(overviewRes.status).toBe(200);
    expect(overviewRes.data.entlastungsbetrag45b.carryoverCents).toBeGreaterThan(0);
    expect(overviewRes.data.entlastungsbetrag45b.carryoverExpiresAt).toBe("2026-06-30");
  });
});


describe("INT-14: T1.3 FIFO-Verbrauchsreihenfolge (altes Geld zuerst)", () => {
  let scenario: BudgetScenarioHandle;
  let fifoTransactionId: number | null = null;
  let fifoAppointmentId: number | null = null;
  let carryoverAllocationId: number | null = null;

  beforeAll(async () => {
    scenario = await setupBudgetScenario({
      customerNamePrefix: "INT-14",
      preferences: { budgetStartDate: "2025-01-01", notes: "T1.3 FIFO Test" },
      types: [
        { type: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
        { type: "umwandlung_45a", priority: 2, enabled: false, monthlyLimitCents: null },
        { type: "ersatzpflege_39_42a", priority: 3, enabled: false, yearlyLimitCents: null },
      ],
      appointments: [
        {
          date: pastWeekday(),
          scheduledStart: "07:00",
          services: [{ code: "hauswirtschaft", durationMinutes: 60 }],
          document: true,
          notes: "INT-14 FIFO Termin",
        },
      ],
    });

    const tx = scenario.transactions[0];
    fifoTransactionId = tx.id;
    fifoAppointmentId = tx.appointmentId;

    const allocRes = await apiGet<any[]>(`/api/budget/${scenario.customerId}/allocations?year=2026`);
    const carryoverAlloc = allocRes.data.find(
      (a: any) => a.budgetType === "entlastungsbetrag_45b" && a.source === "carryover"
    );
    carryoverAllocationId = carryoverAlloc?.id ?? null;
  });

  afterAll(async () => {
    await scenario.cleanup();
  });

  it("INT-14.1 – Setup: Budget-Start 2025, nur §45b aktiv, Carryover vorhanden", async () => {
    const overviewRes = await apiGet<any>(`/api/budget/${scenario.customerId}/overview`);
    expect(overviewRes.status).toBe(200);
    expect(overviewRes.data.entlastungsbetrag45b.carryoverCents).toBeGreaterThan(0);

    expect(carryoverAllocationId).not.toBeNull();
  });

  it("INT-14.2 – Termin wurde erstellt und dokumentiert", async () => {
    expect(fifoAppointmentId).not.toBeNull();
    expect(fifoTransactionId).not.toBeNull();
  });

  it("INT-14.3 – Consumption hat allocationId des Carryover (aeltestes Geld)", async () => {
    if (!fifoTransactionId) return;

    const txRes = await apiGet<any[]>(`/api/budget/${scenario.customerId}/transactions?budgetType=entlastungsbetrag_45b&limit=5000`);
    expect(txRes.status).toBe(200);

    const consumptionTx = txRes.data.find(
      (t: any) => t.id === fifoTransactionId && t.transactionType === "consumption"
    );
    expect(consumptionTx).toBeDefined();
    expect(consumptionTx.allocationId).toBeDefined();
    expect(consumptionTx.allocationId).not.toBeNull();
    expect(consumptionTx.allocationId).toBe(carryoverAllocationId);
  });
});


describe("INT-15: Storno-Netting currentMonthUsedCents (§45b im aktuellen Monat)", () => {
  let scenario: BudgetScenarioHandle;
  let txId: number | null = null;

  beforeAll(async () => {
    scenario = await setupBudgetScenario({
      customerNamePrefix: "INT-15",
      preferences: { budgetStartDate: "2026-01-01" },
      types: [
        { type: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
        { type: "umwandlung_45a", priority: 2, enabled: false, monthlyLimitCents: null },
        { type: "ersatzpflege_39_42a", priority: 3, enabled: false, yearlyLimitCents: null },
      ],
      manualAdjustments: [
        {
          type: "entlastungsbetrag_45b",
          amountCents: 200000,
          notes: "INT-15 Setup: Budget-Topup",
        },
      ],
      appointments: [
        {
          date: weekdayInCurrentMonth(),
          scheduledStart: "03:00",
          services: [{ code: "hauswirtschaft", durationMinutes: 60 }],
          document: true,
          notes: "INT-Netting-CurrentMonth",
        },
      ],
    });

    txId = scenario.transactions[0]?.id ?? null;
  });

  afterAll(async () => {
    await scenario.cleanup();
  });

  it("INT-15.1 – Setup: §45b Prio 1, Termin im aktuellen Monat dokumentiert", async () => {
    expect(txId).not.toBeNull();
    expect(scenario.appointmentIds.length).toBe(1);
  });

  it("INT-15.2 – Storno: totalUsedCents sinkt und availableCents steigt", async () => {
    if (!txId) return;

    const overviewBefore = await apiGet<any>(`/api/budget/${scenario.customerId}/overview`);
    expect(overviewBefore.status).toBe(200);
    const totalUsedBefore = overviewBefore.data.entlastungsbetrag45b.totalUsedCents;
    const availBefore = overviewBefore.data.entlastungsbetrag45b.availableCents;

    const reverseRes = await apiPost<any>(`/api/budget/transactions/${txId}/reverse`, {});
    expect([200, 201]).toContain(reverseRes.status);

    const overviewAfter = await apiGet<any>(`/api/budget/${scenario.customerId}/overview`);
    expect(overviewAfter.status).toBe(200);
    const totalUsedAfter = overviewAfter.data.entlastungsbetrag45b.totalUsedCents;
    const availAfter = overviewAfter.data.entlastungsbetrag45b.availableCents;
    expect(totalUsedAfter).toBeLessThan(totalUsedBefore);
    expect(availAfter).toBeGreaterThan(availBefore);

    const monthUsedAfter = overviewAfter.data.entlastungsbetrag45b.currentMonthUsedCents;
    expect(monthUsedAfter).toBeGreaterThanOrEqual(0);
  });
});


describe("INT-16: Selbstzahler-Kostenvorschau (cost-estimate)", () => {
  let scenario: BudgetScenarioHandle;

  beforeAll(async () => {
    scenario = await setupBudgetScenario({
      customerNamePrefix: "INT-16",
      billingType: "selbstzahler",
      acceptsPrivatePayment: true,
      types: [
        { type: "entlastungsbetrag_45b", priority: 1, enabled: false, monthlyLimitCents: null },
        { type: "umwandlung_45a", priority: 2, enabled: false, monthlyLimitCents: null },
        { type: "ersatzpflege_39_42a", priority: 3, enabled: false, yearlyLimitCents: null },
      ],
    });
  });

  afterAll(async () => {
    await scenario.cleanup();
  });

  it("INT-16.1 – Selbstzahler-Flag und Brutto-Berechnung bei 60 Min HW", async () => {
    const today = getTodayDate();
    const res = await apiGet<any>(
      `/api/budget/${scenario.customerId}/cost-estimate?date=${today}&hauswirtschaftMinutes=60&alltagsbegleitungMinutes=0&travelKilometers=0&customerKilometers=0`
    );
    expect(res.status).toBe(200);
    const d = res.data;

    expect(d.isSelbstzahler).toBe(true);
    expect(d.totalCents).toBeGreaterThan(0);
    expect(d.vatCents).toBeGreaterThan(0);
    expect(d.bruttoCents).toBe(d.totalCents + d.vatCents);
    expect(d.warning).toBeNull();
    expect(d.isHardBlock).toBe(false);
    expect(d.privateCents).toBe(0);
  });

  it("INT-16.2 – Keine Budget-Felder und Budget-Queries übersprungen", async () => {
    const today = getTodayDate();
    const res = await apiGet<any>(
      `/api/budget/${scenario.customerId}/cost-estimate?date=${today}&hauswirtschaftMinutes=60&alltagsbegleitungMinutes=0&travelKilometers=0&customerKilometers=0`
    );
    expect(res.status).toBe(200);
    const d = res.data;

    expect(d).not.toHaveProperty("availableCents");
    expect(d).not.toHaveProperty("currentMonthUsedCents");
    expect(d).not.toHaveProperty("monthlyLimitCents");

    expect(d._testBudgetQueriesExecuted).toBe(false);
  });

  it("INT-16.3 – 0 Minuten liefert bruttoCents = 0 und Selbstzahler-Shape", async () => {
    const today = getTodayDate();
    const res = await apiGet<any>(
      `/api/budget/${scenario.customerId}/cost-estimate?date=${today}&hauswirtschaftMinutes=0&alltagsbegleitungMinutes=0&travelKilometers=0&customerKilometers=0`
    );
    expect(res.status).toBe(200);
    const d = res.data;

    expect(d.isSelbstzahler).toBe(true);
    expect(d.totalCents).toBe(0);
    expect(d.bruttoCents).toBe(0);
    expect(d.vatCents).toBe(0);
    expect(d.warning).toBeNull();
    expect(d.isHardBlock).toBe(false);
  });

  it("INT-16.4 – Selbstzahler-Antwort bei serviceIds-Parametern", async () => {
    const servicesRes = await apiGet<any[]>("/api/services");
    expect(servicesRes.status).toBe(200);
    const hwService = servicesRes.data.find((s: any) => s.code === "hauswirtschaft");
    expect(hwService).toBeDefined();

    const today = getTodayDate();
    const res = await apiGet<any>(
      `/api/budget/${scenario.customerId}/cost-estimate?date=${today}&serviceIds=${hwService!.id}&serviceDurations=60`
    );
    expect(res.status).toBe(200);
    const d = res.data;

    expect(d.isSelbstzahler).toBe(true);
    expect(d.totalCents).toBeGreaterThan(0);
    expect(d.bruttoCents).toBe(d.totalCents + d.vatCents);
    expect(d.warning).toBeNull();
    expect(d.isHardBlock).toBe(false);
    expect(d).not.toHaveProperty("availableCents");
    expect(d).not.toHaveProperty("currentMonthUsedCents");
    expect(d).not.toHaveProperty("monthlyLimitCents");
  });

  it("INT-16.5 – vatRate ist 19 (Standard-MwSt)", async () => {
    const today = getTodayDate();
    const res = await apiGet<any>(
      `/api/budget/${scenario.customerId}/cost-estimate?date=${today}&hauswirtschaftMinutes=60&alltagsbegleitungMinutes=0&travelKilometers=0&customerKilometers=0`
    );
    expect(res.status).toBe(200);
    expect(res.data.vatRate).toBe(19);
  });

  it("INT-16.6 – Gemischte Services (HW + AB + km) liefern korrekte gewichtete MwSt und Brutto", async () => {
    const today = getTodayDate();

    const servicesRes = await apiGet<any[]>("/api/services");
    expect(servicesRes.status).toBe(200);
    const hwService = servicesRes.data.find((s: any) => s.code === "hauswirtschaft");
    const abService = servicesRes.data.find((s: any) => s.code === "alltagsbegleitung");
    const travelKmService = servicesRes.data.find((s: any) => s.code === "travel_km");
    const customerKmService = servicesRes.data.find((s: any) => s.code === "customer_km");
    expect(hwService).toBeDefined();
    expect(abService).toBeDefined();
    expect(travelKmService).toBeDefined();
    expect(customerKmService).toBeDefined();
    const hwVat = hwService!.vatRate;
    const abVat = abService!.vatRate;
    const travelKmVat = travelKmService!.vatRate;
    const customerKmVat = customerKmService!.vatRate;

    const hwOnly = await apiGet<any>(
      `/api/budget/${scenario.customerId}/cost-estimate?date=${today}&hauswirtschaftMinutes=60&alltagsbegleitungMinutes=0&travelKilometers=0&customerKilometers=0`
    );
    const abOnly = await apiGet<any>(
      `/api/budget/${scenario.customerId}/cost-estimate?date=${today}&hauswirtschaftMinutes=0&alltagsbegleitungMinutes=45&travelKilometers=0&customerKilometers=0`
    );
    const travelKmOnly = await apiGet<any>(
      `/api/budget/${scenario.customerId}/cost-estimate?date=${today}&hauswirtschaftMinutes=0&alltagsbegleitungMinutes=0&travelKilometers=10&customerKilometers=0`
    );
    const customerKmOnly = await apiGet<any>(
      `/api/budget/${scenario.customerId}/cost-estimate?date=${today}&hauswirtschaftMinutes=0&alltagsbegleitungMinutes=0&travelKilometers=0&customerKilometers=5`
    );
    expect(hwOnly.status).toBe(200);
    expect(abOnly.status).toBe(200);
    expect(travelKmOnly.status).toBe(200);
    expect(customerKmOnly.status).toBe(200);
    expect(hwOnly.data.totalCents).toBeGreaterThan(0);
    expect(abOnly.data.totalCents).toBeGreaterThan(0);
    expect(travelKmOnly.data.totalCents).toBeGreaterThan(0);
    expect(customerKmOnly.data.totalCents).toBeGreaterThan(0);

    const hwCents = hwOnly.data.totalCents;
    const abCents = abOnly.data.totalCents;
    const travelKmCents = travelKmOnly.data.totalCents;
    const customerKmCents = customerKmOnly.data.totalCents;
    const expectedTotalCents = hwCents + abCents + travelKmCents + customerKmCents;

    const mixed = await apiGet<any>(
      `/api/budget/${scenario.customerId}/cost-estimate?date=${today}&hauswirtschaftMinutes=60&alltagsbegleitungMinutes=45&travelKilometers=10&customerKilometers=5`
    );
    expect(mixed.status).toBe(200);
    const d = mixed.data;

    expect(d.isSelbstzahler).toBe(true);
    expect(d.warning).toBeNull();
    expect(d.isHardBlock).toBe(false);
    expect(d.privateCents).toBe(0);
    expect(d).not.toHaveProperty("availableCents");
    expect(d).not.toHaveProperty("currentMonthUsedCents");
    expect(d).not.toHaveProperty("monthlyLimitCents");

    expect(d.totalCents).toBe(expectedTotalCents);

    // Reproduziere die gewichtete MwSt-Berechnung aus server/routes/budget.ts:
    // weightedVatRate = sum(vatRate * costCents) / sum(costCents) über alle
    // costDetails (HW, AB, Anfahrts-km, Kunden-km).
    const weightedNumerator =
      hwVat * hwCents + abVat * abCents + travelKmVat * travelKmCents + customerKmVat * customerKmCents;
    const weightedDenominator = hwCents + abCents + travelKmCents + customerKmCents;
    const expectedWeightedVatRate = weightedNumerator / weightedDenominator;
    expect(d.vatRate).toBe(Math.round(expectedWeightedVatRate));

    const expectedVatCents = Math.round(d.totalCents * (expectedWeightedVatRate / 100));
    expect(d.vatCents).toBe(expectedVatCents);
    expect(d.bruttoCents).toBe(d.totalCents + d.vatCents);

    // Wenn alle beteiligten MwSt-Sätze gleich sind, muss die gewichtete MwSt
    // exakt diesem Satz entsprechen — unabhängig von den Mengenverhältnissen.
    const allVatsEqual =
      hwVat === abVat && abVat === travelKmVat && travelKmVat === customerKmVat;
    if (allVatsEqual) {
      expect(d.vatRate).toBe(hwVat);
      expect(d.vatCents).toBe(Math.round(d.totalCents * (hwVat / 100)));
    }
  });

  it("INT-16.7 – Gemischte Services über serviceIds liefern korrekte gewichtete MwSt", async () => {
    const servicesRes = await apiGet<any[]>("/api/services");
    expect(servicesRes.status).toBe(200);
    const hwService = servicesRes.data.find((s: any) => s.code === "hauswirtschaft");
    const abService = servicesRes.data.find((s: any) => s.code === "alltagsbegleitung");
    expect(hwService).toBeDefined();
    expect(abService).toBeDefined();
    const hwVat = hwService!.vatRate;
    const abVat = abService!.vatRate;

    const today = getTodayDate();

    // Einzelne Service-Estimates, um die erwarteten netto-Anteile zu erhalten.
    const hwSolo = await apiGet<any>(
      `/api/budget/${scenario.customerId}/cost-estimate?date=${today}&serviceIds=${hwService!.id}&serviceDurations=60`
    );
    const abSolo = await apiGet<any>(
      `/api/budget/${scenario.customerId}/cost-estimate?date=${today}&serviceIds=${abService!.id}&serviceDurations=45`
    );
    expect(hwSolo.status).toBe(200);
    expect(abSolo.status).toBe(200);
    const hwCents = hwSolo.data.totalCents;
    const abCents = abSolo.data.totalCents;
    expect(hwCents).toBeGreaterThan(0);
    expect(abCents).toBeGreaterThan(0);

    const ids = `${hwService!.id},${abService!.id}`;
    const durations = `60,45`;
    const res = await apiGet<any>(
      `/api/budget/${scenario.customerId}/cost-estimate?date=${today}&serviceIds=${ids}&serviceDurations=${durations}`
    );
    expect(res.status).toBe(200);
    const d = res.data;

    expect(d.isSelbstzahler).toBe(true);
    expect(d.warning).toBeNull();
    expect(d.isHardBlock).toBe(false);
    expect(d.totalCents).toBe(hwCents + abCents);

    const expectedWeightedVatRate = (hwVat * hwCents + abVat * abCents) / (hwCents + abCents);
    expect(d.vatRate).toBe(Math.round(expectedWeightedVatRate));

    const expectedVatCents = Math.round(d.totalCents * (expectedWeightedVatRate / 100));
    expect(d.vatCents).toBe(expectedVatCents);
    expect(d.bruttoCents).toBe(d.totalCents + d.vatCents);

    if (hwVat === abVat) {
      expect(d.vatRate).toBe(hwVat);
    }
  });
});
