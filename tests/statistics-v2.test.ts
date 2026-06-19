import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { apiGet, apiPost, apiDelete, getAuthCookie, createTestEmployee, deactivateTestEmployee } from "./test-utils";
import { costForMinutes } from "@shared/domain/statistics/economics";
import { getEntryTypeLabel } from "@shared/domain/time-entries";
import type { EconomicsNonBillableDrillRow } from "@shared/statistics";

beforeAll(async () => {
  await getAuthCookie();
});

const year = new Date().getFullYear();
const month = new Date().getMonth() + 1;

/** Hauswirtschafts-Stundensatz = Bewertungssatz für nicht-abrechenbare Zeit. */
const HW_RATE_CENTS = 1600;

/**
 * Liefert ein YYYY-MM-DD im aktuellen Monat, das garantiert ein Werktag ist
 * (Zeiterfassungen außer Blocker werden am Wochenende abgelehnt). Der aktuelle
 * Monat ist nie monatsabgeschlossen, daher sind die Einträge anlegbar.
 */
function weekdayInCurrentMonth(dayOfMonth: number): string {
  const d = new Date(year, month - 1, dayOfMonth);
  const dow = d.getDay();
  if (dow === 6) d.setDate(d.getDate() + 2);
  else if (dow === 0) d.setDate(d.getDate() + 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function expectKpi(obj: any) {
  expect(obj).toHaveProperty("current");
  expect(obj).toHaveProperty("previous");
  expect(obj).toHaveProperty("deltaAbs");
  expect(obj).toHaveProperty("deltaPct");
  expect(obj).toHaveProperty("previousYear");
  expect(obj).toHaveProperty("deltaYearAbs");
  expect(obj).toHaveProperty("deltaYearPct");
}

describe("STAT-V2: /api/statistics/v2 endpoints", () => {
  it("STAT-V2.1 – cockpit returns all KPI groups + comparison", async () => {
    const res = await apiGet<any>(`/api/statistics/v2/cockpit?year=${year}&month=${month}`);
    expect(res.status).toBe(200);
    for (const key of ["planned", "documented", "proven", "invoiced"]) {
      expectKpi(res.data.revenueByStage[key]);
    }
    expectKpi(res.data.activeCustomers);
    expectKpi(res.data.totalMinutes);
    expect(res.data.minutesByServiceType).toHaveProperty("hauswirtschaft");
    expect(res.data.sparklines.revenueDocumented).toHaveLength(12);
    expect(res.data.sparklines.totalMinutes).toHaveLength(12);
  });

  it("STAT-V2.2 – cockpit accepts from/to range filter", async () => {
    const res = await apiGet<any>(`/api/statistics/v2/cockpit?from=${year}-01-01&to=${year}-06-30`);
    expect(res.status).toBe(200);
    expect(res.data.period.from).toBe(`${year}-01-01`);
    expect(res.data.period.to).toBe(`${year}-06-30`);
  });

  it("STAT-V2.2b – invalid period parameters return 400", async () => {
    const res = await apiGet<any>(`/api/statistics/v2/cockpit?year=abc`);
    expect(res.status).toBe(400);
    const res2 = await apiGet<any>(`/api/statistics/v2/cockpit?from=2025-12-31&to=2025-01-01`);
    expect(res2.status).toBe(400);
  });

  it("STAT-V2.3 – process-health summary has comparison and thresholds", async () => {
    const res = await apiGet<any>(`/api/statistics/v2/process-health?year=${year}&month=${month}`);
    expect(res.status).toBe(200);
    expectKpi(res.data.customersWithoutEmployee);
    expectKpi(res.data.customersWithoutAppointments);
    expectKpi(res.data.undocumentedAppointments);
    expectKpi(res.data.appointmentsWithoutRecord);
    expectKpi(res.data.recordsWithoutInvoice);
    expectKpi(res.data.total);
    expect(["gruen", "gelb", "rot"]).toContain(res.data.healthScore);
    expect(res.data.thresholds).toHaveProperty("yellow");
    expect(res.data.thresholds).toHaveProperty("red");
  });

  it("STAT-V2.4 – process-health drill-downs return arrays", async () => {
    for (const path of [
      "customers-without-employee",
      `customers-without-appointments?year=${year}&month=${month}`,
      `undocumented-appointments?year=${year}&month=${month}`,
      `appointments-without-record?year=${year}&month=${month}`,
      `records-without-invoice?year=${year}&month=${month}`,
    ]) {
      const res = await apiGet<any>(`/api/statistics/v2/process-health/${path}`);
      expect(res.status, `Failed: ${path}`).toBe(200);
      expect(Array.isArray(res.data)).toBe(true);
    }
  });

  it("STAT-V2.5 – customers endpoint with comparison KPIs", async () => {
    const res = await apiGet<any>(`/api/statistics/v2/customers?year=${year}`);
    expect(res.status).toBe(200);
    expect(res.data.funnel).toHaveProperty("active");
    expectKpi(res.data.activeCustomers);
    expectKpi(res.data.conversionRatePct);
    expect(res.data.monthlyGainedLost).toHaveLength(12);
    expect(Array.isArray(res.data.topCustomersByRevenue)).toBe(true);
    expect(Array.isArray(res.data.unusedBudgetCustomers)).toBe(true);
  });

  it("STAT-V2.6 – revenue endpoint exposes all 4 stages per dimension", async () => {
    const res = await apiGet<any>(`/api/statistics/v2/revenue?year=${year}&month=${month}`);
    expect(res.status).toBe(200);
    expectKpi(res.data.byStage.planned);
    expectKpi(res.data.byStage.invoiced);
    if (res.data.byServiceType.length > 0) {
      const row = res.data.byServiceType[0];
      for (const k of ["planned", "documented", "proven", "invoiced"]) {
        expect(row).toHaveProperty(k);
      }
    }
    if (res.data.byEmployee.length > 0) {
      const row = res.data.byEmployee[0];
      for (const k of ["planned", "documented", "proven", "invoiced"]) {
        expect(row).toHaveProperty(k);
      }
    }
    if (res.data.byCustomer.length > 0) {
      const row = res.data.byCustomer[0];
      for (const k of ["planned", "documented", "proven", "invoiced"]) {
        expect(row).toHaveProperty(k);
      }
    }
    expect(typeof res.data.monthForecastCents).toBe("number");
  });

  it("STAT-V2.7 – performance endpoint with utilization comparison", async () => {
    const res = await apiGet<any>(`/api/statistics/v2/performance?year=${year}&month=${month}`);
    expect(res.status).toBe(200);
    expect(res.data.minutesByMonth).toHaveLength(12);
    expectKpi(res.data.utilization.productiveMinutes);
    expectKpi(res.data.utilization.overheadMinutes);
    expectKpi(res.data.utilization.sickVacationMinutes);
    expectKpi(res.data.revenuePerHour.totalCentsPerHour);
  });

  it("STAT-V2.8 – budgets endpoint with year-over-year comparison", async () => {
    const res = await apiGet<any>(`/api/statistics/v2/budgets?year=${year}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data.rows)).toBe(true);
    expect(Array.isArray(res.data.aggregateByStatus)).toBe(true);
    expectKpi(res.data.totalUsedCents);
    expectKpi(res.data.totalAllocatedCents);
  });

  describe("STAT-V2.9 – non-billable hours drill-down", () => {
    let employeeId: number;
    const createdEntryIds: number[] = [];
    const dateA = weekdayInCurrentMonth(10);
    const dateB = weekdayInCurrentMonth(12);
    // Vielfache von 60 Minuten ⇒ HW-Satz-Bewertung exakt ohne Rundungsrest.
    const bueroMinutes = 120;
    const vertriebMinutes = 180;

    beforeAll(async () => {
      const emp = await createTestEmployee({ nachnamePrefix: "NonBillDrill" });
      employeeId = emp.id;
      for (const [entryType, minutes, date] of [
        ["bueroarbeit", bueroMinutes, dateA],
        ["vertrieb", vertriebMinutes, dateB],
      ] as const) {
        const res = await apiPost<any>("/api/time-entries", {
          targetUserId: employeeId,
          entryType,
          entryDate: date,
          durationMinutes: minutes,
        });
        expect(res.status, `seed ${entryType}: ${JSON.stringify(res.data)}`).toBe(201);
        createdEntryIds.push(res.data.id);
      }
    });

    afterAll(async () => {
      for (const id of createdEntryIds) {
        try {
          await apiDelete(`/api/time-entries/${id}`);
        } catch {}
      }
      await deactivateTestEmployee(employeeId);
    });

    it("requires admin (employees are forbidden)", async () => {
      const emp = await createTestEmployee({ nachnamePrefix: "NonBillForbidden" });
      try {
        const { loginAs, apiGetAs } = await import("./test-utils");
        const auth = await loginAs(emp.email, emp.password);
        const res = await apiGetAs(auth, "/api/statistics/v2/revenue/economics/non-billable");
        expect(res.status).toBe(403);
      } finally {
        await deactivateTestEmployee(emp.id);
      }
    });

    it("groups rows by employee + category with HW-rate valuation", async () => {
      const res = await apiGet<EconomicsNonBillableDrillRow[]>(
        `/api/statistics/v2/revenue/economics/non-billable?from=${dateA}&to=${dateB}`,
      );
      expect(res.status).toBe(200);
      expect(Array.isArray(res.data)).toBe(true);

      const mine = res.data.filter((r) => r.employeeId === employeeId);
      expect(mine).toHaveLength(2);

      const buero = mine.find((r) => r.category === "bueroarbeit");
      const vertrieb = mine.find((r) => r.category === "vertrieb");
      expect(buero, "bueroarbeit row").toBeDefined();
      expect(vertrieb, "vertrieb row").toBeDefined();

      expect(buero!.minutes).toBe(bueroMinutes);
      expect(vertrieb!.minutes).toBe(vertriebMinutes);

      expect(buero!.categoryLabel).toBe(getEntryTypeLabel("bueroarbeit"));
      expect(vertrieb!.categoryLabel).toBe(getEntryTypeLabel("vertrieb"));

      expect(buero!.costCents).toBe(costForMinutes(bueroMinutes, HW_RATE_CENTS));
      expect(vertrieb!.costCents).toBe(costForMinutes(vertriebMinutes, HW_RATE_CENTS));

      for (const row of mine) {
        expect(row.employeeName.length).toBeGreaterThan(0);
      }
    });

    it("excludes the period when the date filter does not cover the entries", async () => {
      const otherYear = year - 1;
      const res = await apiGet<EconomicsNonBillableDrillRow[]>(
        `/api/statistics/v2/revenue/economics/non-billable?from=${otherYear}-01-01&to=${otherYear}-01-31`,
      );
      expect(res.status).toBe(200);
      expect(res.data.some((r) => r.employeeId === employeeId)).toBe(false);
    });
  });
});
