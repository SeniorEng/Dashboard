import { describe, it, expect, beforeAll } from "vitest";
import {
  apiGet,
  getAuthCookie,
} from "./test-utils";

beforeAll(async () => {
  await getAuthCookie();
});

describe("STAT-1: Statistik-Overview", () => {
  it("STAT-1.1 – GET /api/statistics/overview liefert Daten", async () => {
    const year = new Date().getFullYear();
    const res = await apiGet<any>(`/api/statistics/overview?year=${year}`);
    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty("year");
    expect(res.data.year).toBe(year);
  });

  it("STAT-1.2 – Overview enthält alle Pflichtfelder", async () => {
    const year = new Date().getFullYear();
    const res = await apiGet<any>(`/api/statistics/overview?year=${year}`);
    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty("employees");
    expect(res.data).toHaveProperty("revenue");
    expect(res.data).toHaveProperty("customers");
    expect(res.data).toHaveProperty("efficiency");
    expect(res.data).toHaveProperty("monthlyTrends");
    expect(res.data).toHaveProperty("pflegegradDistribution");
    expect(res.data).toHaveProperty("budgetUtilization");
    expect(res.data).toHaveProperty("cockpit");
  });

  it("STAT-1.3 – Overview mit Monatsfilter", async () => {
    const year = new Date().getFullYear();
    const month = new Date().getMonth() + 1;
    const res = await apiGet<any>(`/api/statistics/overview?year=${year}&month=${month}`);
    expect(res.status).toBe(200);
    expect(res.data.month).toBe(month);
    expect(res.data.cockpit).toHaveProperty("hasPreviousMonth");
    expect(res.data.cockpit.hasPreviousMonth).toBe(true);
  });

  it("STAT-1.4 – Employees Array hat korrekte Struktur", async () => {
    const year = new Date().getFullYear();
    const res = await apiGet<any>(`/api/statistics/overview?year=${year}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data.employees)).toBe(true);
    if (res.data.employees.length > 0) {
      const emp = res.data.employees[0];
      expect(emp).toHaveProperty("id");
      expect(emp).toHaveProperty("name");
      expect(emp).toHaveProperty("appointments");
    }
  });

  it("STAT-1.5 – MonthlyTrends hat 12 Monate", async () => {
    const year = new Date().getFullYear();
    const res = await apiGet<any>(`/api/statistics/overview?year=${year}`);
    expect(res.status).toBe(200);
    expect(res.data.monthlyTrends).toHaveLength(12);
    expect(res.data.monthlyTrends[0]).toHaveProperty("month");
    expect(res.data.monthlyTrends[0].month).toBe(1);
    expect(res.data.monthlyTrends[11].month).toBe(12);
  });

  it("STAT-1.6 – Cockpit enthält Margen- und Budget-Daten", async () => {
    const year = new Date().getFullYear();
    const res = await apiGet<any>(`/api/statistics/overview?year=${year}`);
    expect(res.status).toBe(200);
    const cockpit = res.data.cockpit;
    expect(cockpit).toHaveProperty("margin");
    expect(cockpit).toHaveProperty("utilization");
    expect(cockpit).toHaveProperty("budget");
    expect(cockpit.margin).toHaveProperty("revenueCents");
    expect(cockpit.margin).toHaveProperty("marginPercent");
    expect(cockpit.budget).toHaveProperty("allocatedCents");
    expect(cockpit.budget).toHaveProperty("usedCents");
  });
});
