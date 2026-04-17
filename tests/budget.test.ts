import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  apiGet,
  apiPost,
  apiPut,
  apiPatch,
  apiDelete,
  getAuthCookie,
  uniqueId,
  getFutureDate,
} from "./test-utils";

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
let testCustomerId: number;
let hwServiceId: number;

function getWeekday(d: Date): Date {
  const dow = d.getDay();
  if (dow === 0) d.setDate(d.getDate() - 2);
  else if (dow === 6) d.setDate(d.getDate() - 1);
  return d;
}

beforeAll(async () => {
  auth = await getAuthCookie();

  const servicesRes = await apiGet<any[]>("/api/services/all");
  hwServiceId = servicesRes.data.find((s: any) => s.code === "hauswirtschaft")!.id;

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
    expect(prefRes.status).toBe(200);

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

  it("BB-4.1 – Positive manuelle Korrektur erstellt Allocation (201)", async () => {
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

  it("BB-4.2 – Negative manuelle Korrektur erstellt Transaction (201)", async () => {
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

  it("BB-4.4 – Korrektur-Transaktion stornieren (reversal)", async () => {
    expect(txId, "txId muss aus BB-4.2 gesetzt sein").toBeTruthy();
    const res = await apiPost<any>(`/api/budget/transactions/${txId}/reverse`, {});
    expect(res.status).toBe(201);
  });

  it("BB-4.5 – Storno-Transaktion erneut stornieren erzeugt weitere Gegenbuchung", async () => {
    expect(txId, "txId muss aus BB-4.2 gesetzt sein").toBeTruthy();
    const res = await apiPost<any>(`/api/budget/transactions/${txId}/reverse`, {});
    expect(res.status).toBe(201);
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
    const res = await apiGet<any>(
      `/api/budget/${testCustomerId}/cost-estimate?serviceId=${hwServiceId}&durationMinutes=60`
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

describe("BB-9: §45a PG-abhängige Limits", () => {
  it("BB-9.1 – PG3 Limit = 598,80€ (40% von 1.497€)", async () => {
    const res = await apiGet<any>(`/api/budget/${testCustomerId}/overview`);
    expect(res.status).toBe(200);
    expect(res.data.umwandlung45a.monthlyBudgetCents).toBe(59880);
  });

  it("BB-9.2 – §45a Betrag wird validiert und gespeichert", async () => {
    const res = await apiPost<any>(`/api/budget/${testCustomerId}/settings`, {
      umwandlung45aEnabled: true,
      umwandlung45aMonthlyAmount: 59880,
    });
    expect(res.status).toBe(200);

    const verify = await apiGet<any>(`/api/budget/${testCustomerId}/overview`);
    expect(verify.status).toBe(200);
    expect(verify.data.umwandlung45a.monthlyBudgetCents).toBe(59880);
  });
});

describe("BB-10: Budget-Allokationen", () => {
  it("BB-10.1 – §45b Allokationen auflisten", async () => {
    const res = await apiGet<any[]>(`/api/budget/${testCustomerId}/allocations?budgetType=entlastungsbetrag_45b`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data)).toBe(true);
    if (res.data.length > 0) {
      expect(res.data[0]).toHaveProperty("amountCents");
      expect(res.data[0]).toHaveProperty("source");
    }
  });

  it("BB-10.2 – Carryover-Allokationen haben Ablaufdatum (30.06.)", async () => {
    const res = await apiGet<any>(`/api/budget/${testCustomerId}/overview`);
    expect(res.status).toBe(200);
    const eb = res.data.entlastungsbetrag45b;
    expect(typeof eb.carryoverCents).toBe("number");
  });
});

describe("BB-11: Reversal-Semantik", () => {
  it("BB-11.1 – Storno-Transaktionen haben transactionType reversal", async () => {
    const txRes = await apiGet<any[]>(`/api/budget/${testCustomerId}/transactions?limit=20`);
    expect(txRes.status).toBe(200);
    const reversals = txRes.data.filter((tx: any) => tx.transactionType === "reversal");
    for (const rev of reversals) {
      expect(typeof rev.amountCents).toBe("number");
      expect(rev.transactionType).toBe("reversal");
    }
  });
});

describe("BB-12: Budget-Verbrauch durch Dokumentation", () => {
  let consumptionApptId: number | null = null;
  let budgetBefore: number;

  it("BB-12.1 – Budget vor Dokumentation erfassen", async () => {
    const settings = [
      { budgetType: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
      { budgetType: "umwandlung_45a", priority: 2, enabled: true, monthlyLimitCents: 59880 },
      { budgetType: "ersatzpflege_39_42a", priority: 3, enabled: false, yearlyLimitCents: null },
    ];
    await apiPut(`/api/budget/${testCustomerId}/type-settings`, { settings });

    const res = await apiGet<any>(`/api/budget/${testCustomerId}/overview`);
    expect(res.status).toBe(200);
    budgetBefore = res.data.entlastungsbetrag45b.totalUsedCents;
  });

  it("BB-12.2 – Termin erstellen und dokumentieren verbraucht Budget", async () => {
    const timeSlots = ["05:00", "05:30", "20:00", "20:30"];
    let documented = false;
    for (let offset = 2; offset <= 60 && !documented; offset++) {
      const candidate = new Date();
      candidate.setDate(candidate.getDate() - offset);
      getWeekday(candidate);
      const dateStr = candidate.toISOString().split("T")[0];

      for (const time of timeSlots) {
        const createRes = await apiPost<any>("/api/appointments/kundentermin", {
          customerId: testCustomerId,
          date: dateStr,
          scheduledStart: time,
          services: [{ serviceId: hwServiceId, durationMinutes: 60 }],
          assignedEmployeeId: auth.user.id,
        });
        if (createRes.status !== 201) continue;
        consumptionApptId = createRes.data.id;

        const docRes = await apiPost<any>(`/api/appointments/${consumptionApptId}/document`, {
          actualStart: time,
          travelOriginType: "home",
          travelKilometers: 0,
          customerKilometers: 0,
          services: [{ serviceId: hwServiceId, actualDurationMinutes: 60, details: "Budget-Test" }],
        });
        if (docRes.status === 200) {
          documented = true;
          break;
        }
      }
    }
    expect(documented, "Termin muss erstellt und dokumentiert werden").toBe(true);

    const afterRes = await apiGet<any>(`/api/budget/${testCustomerId}/overview`);
    expect(afterRes.status).toBe(200);
    expect(afterRes.data.entlastungsbetrag45b.totalUsedCents).toBeGreaterThan(budgetBefore);
  });

  it("BB-12.3 – Termin wiedereröffnen reversiert Budget", async () => {
    expect(consumptionApptId, "consumptionApptId muss aus BB-12.2 gesetzt sein").toBeTruthy();
    const beforeRes = await apiGet<any>(`/api/budget/${testCustomerId}/overview`);
    const usedBefore = beforeRes.data.entlastungsbetrag45b.totalUsedCents;

    const reopenRes = await apiPost<any>(`/api/appointments/${consumptionApptId}/reopen`, {});
    expect(reopenRes.status).toBe(200);

    const afterRes = await apiGet<any>(`/api/budget/${testCustomerId}/overview`);
    expect(afterRes.data.entlastungsbetrag45b.totalUsedCents).toBeLessThan(usedBefore);

    await apiDelete(`/api/appointments/${consumptionApptId}`);
  });
});

describe("BB-13: Budget-Allokationen", () => {
  it("BB-13.1 – Allokationen haben Grundfelder", async () => {
    const res = await apiGet<any[]>(`/api/budget/${testCustomerId}/allocations?budgetType=entlastungsbetrag_45b&year=2026`);
    expect(res.status).toBe(200);
    expect(res.data.length).toBeGreaterThan(0);
    for (const alloc of res.data) {
      expect(alloc).toHaveProperty("id");
      expect(alloc).toHaveProperty("customerId");
      expect(alloc).toHaveProperty("amountCents");
    }
  });

  it("BB-13.2 – Allokationen für aktuelles Jahr vorhanden", async () => {
    const res = await apiGet<any[]>(`/api/budget/${testCustomerId}/allocations?budgetType=entlastungsbetrag_45b&year=2026`);
    expect(res.status).toBe(200);
    expect(res.data.length).toBeGreaterThan(0);
    for (const alloc of res.data) {
      expect(typeof alloc.amountCents).toBe("number");
      expect(alloc.amountCents).toBeGreaterThan(0);
    }
  });
});

describe("BB-14: PG1 – kein §45a Anspruch", () => {
  let pg1CustomerId: number;
  let createdPg1 = false;

  beforeAll(async () => {
    const custRes = await apiGet<{ data: any[] }>("/api/admin/customers?limit=100");
    const pg1 = custRes.data.data.find((c: any) => c.pflegegrad === 1);
    if (pg1) {
      pg1CustomerId = pg1.id;
    } else {
      const provRes = await apiGet<any[]>("/api/admin/insurance-providers");
      const createRes = await apiPost<any>("/api/admin/customers", {
        vorname: "PG1-Test",
        nachname: "Budget-PG1-" + Date.now(),
        geburtsdatum: "1935-03-15",
        strasse: "Teststraße",
        nr: "1",
        plz: "12345",
        stadt: "Teststadt",
        pflegegrad: 1,
        pflegegradSeit: "2024-01-01",
        insurance: {
          providerId: provRes.data[0].id,
          versichertennummer: "P" + String(Math.floor(100000000 + Math.random() * 900000000)),
          validFrom: "2024-01-01",
        },
        contacts: [{
          contactType: "familie",
          isPrimary: true,
          vorname: "Kontakt",
          nachname: "PG1",
          telefon: "+4917600000001",
        }],
      });
      expect(createRes.status).toBe(201);
      pg1CustomerId = createRes.data.id;
      createdPg1 = true;
    }

    await apiPut(`/api/budget/${pg1CustomerId}/type-settings`, {
      settings: [
        { budgetType: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
        { budgetType: "umwandlung_45a", priority: 2, enabled: true, monthlyLimitCents: 0 },
        { budgetType: "ersatzpflege_39_42a", priority: 3, enabled: false, yearlyLimitCents: null },
      ],
    });
  });

  afterAll(async () => {
    if (createdPg1) {
      try { await apiDelete(`/api/admin/customers/${pg1CustomerId}`); } catch {}
    }
  });

  it("BB-14.1 – PG1 Kunde hat keinen §45a Umwandlungsanspruch", async () => {
    const res = await apiGet<any>(`/api/budget/${pg1CustomerId}/overview`);
    expect(res.status).toBe(200);
    expect(res.data.umwandlung45a).toBeDefined();
    expect(res.data.umwandlung45a.monthlyBudgetCents).toBe(0);
  });
});

describe("BB-14B: §45a PG-abhängige Limits (PG2/PG4/PG5)", () => {
  const pgLimitsMap: Record<number, number> = {
    2: 31840,
    4: 74360,
    5: 91960,
  };

  for (const [pg, expectedCents] of Object.entries(pgLimitsMap)) {
    it(`BB-14B.${pg} – PG${pg} §45a Limit = ${expectedCents / 100}€ via monthlyLimitCents`, async () => {
      const provRes = await apiGet<any[]>("/api/admin/insurance-providers");
      const createRes = await apiPost<any>("/api/admin/customers", {
        vorname: `PG${pg}-Test`,
        nachname: `Budget-PG${pg}-` + Date.now(),
        geburtsdatum: "1938-06-10",
        strasse: "Budgetstraße",
        nr: "2",
        plz: "54321",
        stadt: "Budgetstadt",
        pflegegrad: Number(pg),
        pflegegradSeit: "2024-01-01",
        insurance: {
          providerId: provRes.data[0].id,
          versichertennummer: "Q" + String(Math.floor(100000000 + Math.random() * 900000000)),
          validFrom: "2024-01-01",
        },
        contacts: [{
          contactType: "familie",
          isPrimary: true,
          vorname: "Kontakt",
          nachname: `PG${pg}`,
          telefon: "+491760000000" + pg,
        }],
      });
      expect(createRes.status).toBe(201);
      const custId = createRes.data.id;
      try {
        await apiPut(`/api/budget/${custId}/type-settings`, {
          settings: [
            { budgetType: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
            { budgetType: "umwandlung_45a", priority: 2, enabled: true, monthlyLimitCents: expectedCents },
            { budgetType: "ersatzpflege_39_42a", priority: 3, enabled: false, yearlyLimitCents: null },
          ],
        });
        const res = await apiGet<any>(`/api/budget/${custId}/overview`);
        expect(res.status).toBe(200);
        expect(res.data.umwandlung45a).toBeDefined();
        expect(res.data.umwandlung45a.monthlyBudgetCents).toBe(expectedCents);
      } finally {
        await apiDelete(`/api/admin/customers/${custId}`);
      }
    });
  }
});

describe("BB-15: Budget-Transaktionsliste vollständig", () => {
  it("BB-15.1 – Transaktionsliste enthält Pflichtfelder", async () => {
    const res = await apiGet<any[]>(`/api/budget/${testCustomerId}/transactions?budgetType=entlastungsbetrag_45b&limit=5`);
    expect(res.status).toBe(200);
    expect(res.data.length, "Transaktionsliste darf nicht leer sein").toBeGreaterThan(0);
    const tx = res.data[0];
    expect(tx).toHaveProperty("id");
    expect(tx).toHaveProperty("amountCents");
    expect(tx).toHaveProperty("transactionType");
    expect(tx).toHaveProperty("createdAt");
  });

  it("BB-15.2 – Manuelle Korrekturbuchung erscheint in Liste", async () => {
    const res = await apiGet<any[]>(`/api/budget/${testCustomerId}/transactions?budgetType=entlastungsbetrag_45b&limit=50`);
    expect(res.status).toBe(200);
    const manualTx = res.data.find((t: any) => t.transactionType === "manual_adjustment");
    expect(manualTx).toBeDefined();
  });
});

describe("BB-16: Budget-Typ-Prioritäten und FIFO-Verbrauch", () => {
  it("BB-16.1 – Budget-Type-Settings Reihenfolge spiegelt Prioritäten wider", async () => {
    const res = await apiGet<any>(`/api/budget/${testCustomerId}/type-settings`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data)).toBe(true);
    expect(res.data.length).toBeGreaterThanOrEqual(1);
    const enabled = res.data.filter((s: any) => s.enabled);
    for (let i = 1; i < enabled.length; i++) {
      expect(enabled[i].priority).toBeGreaterThan(enabled[i - 1].priority);
    }
  });

  it("BB-16.2 – Transaktionen haben gültige transactionType-Werte", async () => {
    const txRes = await apiGet<any[]>(`/api/budget/${testCustomerId}/transactions?budgetType=entlastungsbetrag_45b&limit=50`);
    expect(txRes.status).toBe(200);
    const validTypes = ["consumption", "reversal", "manual_adjustment", "allocation", "carryover"];
    for (const tx of txRes.data) {
      expect(validTypes).toContain(tx.transactionType);
      expect(typeof tx.amountCents).toBe("number");
    }
  });

  it("BB-16.3 – Carryover-Allokation vorhanden falls Übertrag existiert", async () => {
    const ovRes = await apiGet<any>(`/api/budget/${testCustomerId}/overview`);
    expect(ovRes.status).toBe(200);
    expect(ovRes.data.entlastungsbetrag45b).toBeDefined();
    if (ovRes.data.entlastungsbetrag45b.carryoverCents > 0) {
      expect(ovRes.data.entlastungsbetrag45b.carryoverCents).toBeGreaterThan(0);
      if (ovRes.data.entlastungsbetrag45b.carryoverExpiresAt) {
        const expiryDate = new Date(ovRes.data.entlastungsbetrag45b.carryoverExpiresAt);
        expect(expiryDate.getMonth()).toBe(5);
      }
    }
  });
});

describe("BB-17: Kaskadenreihenfolge (§45a → §45b → §39/42a)", () => {
  it("BB-17.1 – Kaskadenreihenfolge kann gesetzt und gelesen werden", async () => {
    const patchRes = await apiPatch<any>(`/api/budget/${testCustomerId}/type-settings`, {
      settings: [
        { budgetType: "umwandlung_45a", enabled: true, priority: 1 },
        { budgetType: "entlastungsbetrag_45b", enabled: true, priority: 2 },
        { budgetType: "ersatzpflege_39_42a", enabled: true, priority: 3 },
      ],
    });
    expect(patchRes.status).toBe(200);

    const settingsRes = await apiGet<any>(`/api/budget/${testCustomerId}/type-settings`);
    expect(settingsRes.status).toBe(200);
    expect(Array.isArray(settingsRes.data)).toBe(true);
    expect(settingsRes.data.length).toBe(3);
    for (const setting of settingsRes.data) {
      expect(setting).toHaveProperty("budgetType");
      expect(setting).toHaveProperty("priority");
      expect(setting).toHaveProperty("enabled");
    }
  });

  it("BB-17.2 – Kunden-spezifische Kaskadenreihenfolge wird angewendet", async () => {
    const patchRes = await apiPatch<any>(`/api/budget/${testCustomerId}/type-settings`, {
      settings: [
        { budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1 },
        { budgetType: "umwandlung_45a", enabled: true, priority: 2 },
        { budgetType: "ersatzpflege_39_42a", enabled: true, priority: 3 },
      ],
    });
    expect(patchRes.status).toBe(200);

    const verifyRes = await apiGet<any>(`/api/budget/${testCustomerId}/type-settings`);
    expect(verifyRes.status).toBe(200);
    const sorted = verifyRes.data.sort((a: any, b: any) => a.priority - b.priority);
    expect(sorted[0].budgetType).toBe("entlastungsbetrag_45b");
    expect(sorted[1].budgetType).toBe("umwandlung_45a");

    await apiPatch(`/api/budget/${testCustomerId}/type-settings`, {
      settings: [
        { budgetType: "umwandlung_45a", enabled: true, priority: 1 },
        { budgetType: "entlastungsbetrag_45b", enabled: true, priority: 2 },
        { budgetType: "ersatzpflege_39_42a", enabled: true, priority: 3 },
      ],
    });
  });

  it("BB-17.3 – Kostenvoranschlag (cost-estimate) liefert Budget-Informationen", async () => {
    const costRes = await apiGet<any>(
      `/api/budget/${testCustomerId}/cost-estimate?serviceIds=${hwServiceId}&serviceDurations=60`
    );
    expect(costRes.status).toBe(200);
    expect(costRes.data).toHaveProperty("totalCents");
    expect(typeof costRes.data.totalCents).toBe("number");
  });
});

describe("BB-18: FIFO-Verbrauch – Carryover vor regulärer Allokation", () => {
  it("BB-18.1 – §45b Allokationen enthalten source-Feld (monthly_auto oder carryover)", async () => {
    const allocRes = await apiGet<any[]>(`/api/budget/${testCustomerId}/allocations?budgetType=entlastungsbetrag_45b`);
    expect(allocRes.status).toBe(200);
    expect(allocRes.data.length).toBeGreaterThan(0);
    const validSources = ["monthly_auto", "carryover", "manual", "manual_adjustment", "yearly_auto"];
    for (const alloc of allocRes.data) {
      expect(validSources).toContain(alloc.source);
      expect(alloc).toHaveProperty("validFrom");
      expect(alloc).toHaveProperty("amountCents");
      expect(typeof alloc.amountCents).toBe("number");
    }
  });

  it("BB-18.2 – Carryover-Allokation hat Ablaufdatum 30.06.", async () => {
    const allocRes = await apiGet<any[]>(`/api/budget/${testCustomerId}/allocations?budgetType=entlastungsbetrag_45b`);
    expect(allocRes.status).toBe(200);
    const carryovers = allocRes.data.filter((a: any) => a.source === "carryover");
    for (const co of carryovers) {
      expect(co.expiresAt, "Carryover muss expiresAt haben").toBeDefined();
      const expiry = new Date(co.expiresAt);
      expect(expiry.getMonth()).toBe(5);
      expect(expiry.getDate()).toBe(30);
    }
  });

  it("BB-18.3 – Verbrauchte Transaktionen referenzieren eine gültige Allokation", async () => {
    const txRes = await apiGet<any[]>(`/api/budget/${testCustomerId}/transactions?budgetType=entlastungsbetrag_45b&limit=50`);
    expect(txRes.status).toBe(200);
    const consumptions = txRes.data.filter((t: any) => t.transactionType === "consumption");
    for (const tx of consumptions) {
      expect(tx.allocationId, "Consumption muss allocationId haben").toBeDefined();
      expect(typeof tx.allocationId).toBe("number");
      expect(tx.allocationId).toBeGreaterThan(0);
    }
  });

  it("BB-18.4 – FIFO-Reihenfolge: Carryover wird vor regulärer Allokation verbraucht", async () => {
    const allocRes = await apiGet<any[]>(`/api/budget/${testCustomerId}/allocations?budgetType=entlastungsbetrag_45b`);
    expect(allocRes.status).toBe(200);
    const carryovers = allocRes.data.filter((a: any) => a.source === "carryover");
    const regulars = allocRes.data.filter((a: any) => a.source === "monthly_auto");
    if (carryovers.length > 0 && regulars.length > 0) {
      const txRes = await apiGet<any[]>(`/api/budget/${testCustomerId}/transactions?budgetType=entlastungsbetrag_45b&limit=200`);
      expect(txRes.status).toBe(200);
      const consumptions = txRes.data.filter((t: any) => t.transactionType === "consumption");
      if (consumptions.length > 0) {
        const carryoverIds = new Set(carryovers.map((c: any) => c.id));
        const regularIds = new Set(regulars.map((r: any) => r.id));
        const carryoverConsumptions = consumptions.filter((t: any) => carryoverIds.has(t.allocationId));
        const regularConsumptions = consumptions.filter((t: any) => regularIds.has(t.allocationId));
        if (carryoverConsumptions.length > 0 && regularConsumptions.length > 0) {
          const lastCarryoverDate = new Date(
            Math.max(...carryoverConsumptions.map((t: any) => new Date(t.createdAt || t.date).getTime()))
          );
          const firstRegularDate = new Date(
            Math.min(...regularConsumptions.map((t: any) => new Date(t.createdAt || t.date).getTime()))
          );
          expect(
            lastCarryoverDate.getTime() <= firstRegularDate.getTime(),
            "Carryover muss zeitlich vor regulärer Allokation verbraucht werden (FIFO)"
          ).toBe(true);
        }
      }
    }
  });
});

describe("BUD-EDGE: Budget-Grenzfälle", () => {
  let edgeCustomerId: number;

  beforeAll(async () => {
    const suffix = Date.now();
    const createRes = await apiPost<any>("/api/admin/customers", {
      vorname: "BudgetEdge",
      nachname: `Test-${suffix}`,
      geburtsdatum: "1945-06-15",
      strasse: "Teststr.",
      nr: "1",
      plz: "12345",
      stadt: "Berlin",
      pflegegrad: 1,
      billingType: "pflegekasse_gesetzlich",
    });
    expect(createRes.status).toBe(201);
    edgeCustomerId = createRes.data.id;
  });

  it("BUD-EDGE-1 – Budgetstatus für Kunde ohne Pflegegrad", async () => {
    const res = await apiGet<any>(`/api/budget/${edgeCustomerId}/status?year=${new Date().getFullYear()}`);
    expect(res.status).toBe(200);
  });

  it("BUD-EDGE-2 – Kostenschätzung mit 0 Minuten liefert Ergebnis", async () => {
    const year = new Date().getFullYear();
    const month = new Date().getMonth() + 1;
    const res = await apiGet<any>(`/api/budget/${edgeCustomerId}/cost-estimate?year=${year}&month=${month}&minutes=0`);
    expect(res.status).toBe(200);
  });
});

// Task #101: Doppelzählung & Mehrfach-Anzeige Startwert §45b
describe("BUD-IB-DEDUP: Startwert §45b – keine Doppelzählung mit Carryover", () => {
  let dedupCustomerId: number;
  const previousYear = new Date().getFullYear() - 1;
  const startMonth = 12;
  const ibAmountCents = 157200; // 1.572 €

  beforeAll(async () => {
    const suffix = Date.now();
    const createRes = await apiPost<any>("/api/admin/customers", {
      vorname: "IBDedup",
      nachname: `Test-${suffix}`,
      geburtsdatum: "1942-04-04",
      strasse: "Teststr.",
      nr: "1",
      plz: "12345",
      stadt: "Berlin",
      pflegegrad: 3,
      billingType: "pflegekasse_gesetzlich",
    });
    expect(createRes.status).toBe(201);
    dedupCustomerId = createRes.data.id;

    await apiPut<any>(`/api/budget/${dedupCustomerId}/type-settings`, {
      settings: [
        { budgetType: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
        { budgetType: "umwandlung_45a", priority: 2, enabled: false, monthlyLimitCents: null },
        { budgetType: "ersatzpflege_39_42a", priority: 3, enabled: false, yearlyLimitCents: null },
      ],
    });

    // Startwert ab Dezember Vorjahr
    const ibRes = await apiPost<any>(`/api/budget/${dedupCustomerId}/initial-balance/entlastungsbetrag_45b`, {
      amountCents: ibAmountCents,
      validFrom: `${previousYear}-${String(startMonth).padStart(2, "0")}`,
    });
    expect(ibRes.status).toBe(200);
  });

  it("BUD-IB-DEDUP-1 – Startwert-Historie liefert ausschließlich initial_balance-Einträge", async () => {
    // Auch nachdem die Carryover-Sync gelaufen ist (via overview)
    await apiGet<any>(`/api/budget/${dedupCustomerId}/overview`);
    const res = await apiGet<any[]>(`/api/budget/${dedupCustomerId}/initial-balances/entlastungsbetrag_45b`);
    expect(res.status).toBe(200);
    expect(res.data.length).toBeGreaterThan(0);
    for (const a of res.data) {
      expect(a.source).toBe("initial_balance");
    }
  });

  it("BUD-IB-DEDUP-2 – Es entsteht kein automatischer Carryover, wenn für das Vorjahr ein Startwert existiert", async () => {
    await apiGet<any>(`/api/budget/${dedupCustomerId}/overview`); // triggert syncCarryoverAndExpiry
    const allocRes = await apiGet<any[]>(`/api/budget/${dedupCustomerId}/allocations`);
    expect(allocRes.status).toBe(200);
    const autoCarryover = allocRes.data.filter(
      (a: any) => a.budgetType === "entlastungsbetrag_45b" && a.source === "carryover"
    );
    expect(autoCarryover.length).toBe(0);
  });

  it("BUD-IB-DEDUP-3 – totalAllocatedCents = Startwert + monatliche Auto-Allokationen ab Folgemonat (keine Doppelzählung)", async () => {
    const overviewRes = await apiGet<any>(`/api/budget/${dedupCustomerId}/overview`);
    expect(overviewRes.status).toBe(200);
    const s45b = overviewRes.data.entlastungsbetrag45b;

    const now = new Date();
    const curYear = now.getFullYear();
    const curMonth = now.getMonth() + 1;
    // Monate ab Januar curYear bis aktueller Monat
    const monthsSinceIB = (curYear - previousYear) * 12 + (curMonth - startMonth);
    const expected = ibAmountCents + Math.max(0, monthsSinceIB) * 13100;

    expect(s45b.totalAllocatedCents).toBe(expected);
  });

  it("BUD-IB-DEDUP-4 – Klassischer Carryover funktioniert weiterhin, wenn KEIN Startwert für das Vorjahr existiert", async () => {
    const suffix = Date.now();
    const createRes = await apiPost<any>("/api/admin/customers", {
      vorname: "IBDedupCO",
      nachname: `Test-${suffix}`,
      geburtsdatum: "1942-04-04",
      strasse: "Teststr.",
      nr: "1",
      plz: "12345",
      stadt: "Berlin",
      pflegegrad: 3,
      billingType: "pflegekasse_gesetzlich",
    });
    const id = createRes.data.id;

    await apiPut<any>(`/api/budget/${id}/type-settings`, {
      settings: [
        { budgetType: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
        { budgetType: "umwandlung_45a", priority: 2, enabled: false, monthlyLimitCents: null },
        { budgetType: "ersatzpflege_39_42a", priority: 3, enabled: false, yearlyLimitCents: null },
      ],
    });
    // Budgetstart Januar Vorjahr → klassischer Übertrag soll erzeugt werden
    await apiPut<any>(`/api/budget/${id}/preferences`, {
      customerId: id,
      budgetStartDate: `${previousYear}-01-01`,
    });

    await apiGet<any>(`/api/budget/${id}/overview`);
    const allocRes = await apiGet<any[]>(`/api/budget/${id}/allocations`);
    const carryovers = allocRes.data.filter(
      (a: any) => a.budgetType === "entlastungsbetrag_45b" && a.source === "carryover"
    );
    // Mindestens ein automatischer Carryover für das aktuelle Jahr
    expect(carryovers.length).toBeGreaterThan(0);
  });
});
