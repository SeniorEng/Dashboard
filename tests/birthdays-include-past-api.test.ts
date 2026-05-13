import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { apiGet, getAuthCookie, createTestCustomer, cleanupCustomer } from "./test-utils";

interface BirthdayEntry {
  id: number;
  type: "customer" | "employee";
  name: string;
  geburtsdatum: string;
  daysUntil: number;
  age: number;
  address?: string;
}

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().split("T")[0];
}

describe("GET /api/birthdays — includePast Query-Param", () => {
  let customerId: number;
  const yesterday = isoDaysAgo(2);

  beforeAll(async () => {
    await getAuthCookie();
    const created = await createTestCustomer({
      vorname: "Geburtstags-Test",
      geburtsdatum: yesterday,
    });
    customerId = created.id as number;
  });

  afterAll(async () => {
    await cleanupCustomer(customerId);
  });

  it("ohne includePast: überfälliger Kunde fehlt im 30-Tage-Fenster", async () => {
    const res = await apiGet<BirthdayEntry[]>("/api/birthdays?days=30");
    expect(res.status).toBe(200);
    const found = res.data.find((b) => b.type === "customer" && b.id === customerId);
    expect(found).toBeUndefined();
  });

  it("mit includePast=30: Kunde ist enthalten und daysUntil ist negativ (-2)", async () => {
    const res = await apiGet<BirthdayEntry[]>("/api/birthdays?days=30&includePast=30");
    expect(res.status).toBe(200);
    const found = res.data.find((b) => b.type === "customer" && b.id === customerId);
    expect(found).toBeDefined();
    expect(found!.daysUntil).toBe(-2);
    expect(found!.geburtsdatum).toBe(yesterday);
  });

  it("Cache-Isolation: Antwort mit/ohne includePast unterscheidet sich auch beim 2. Aufruf (kein Cache-Leck)", async () => {
    const withPast = await apiGet<BirthdayEntry[]>("/api/birthdays?days=30&includePast=30");
    const withoutPast = await apiGet<BirthdayEntry[]>("/api/birthdays?days=30");

    const inWithPast = withPast.data.some((b) => b.type === "customer" && b.id === customerId);
    const inWithoutPast = withoutPast.data.some((b) => b.type === "customer" && b.id === customerId);

    expect(inWithPast).toBe(true);
    expect(inWithoutPast).toBe(false);
  });

  it("includePast=1 (Fenster zu klein): Kunde mit Geburtstag vor 2 Tagen fehlt", async () => {
    const res = await apiGet<BirthdayEntry[]>("/api/birthdays?days=30&includePast=1");
    expect(res.status).toBe(200);
    const found = res.data.find((b) => b.type === "customer" && b.id === customerId);
    expect(found).toBeUndefined();
  });
});
