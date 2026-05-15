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

// Task #453: zuvor als flaky gemeldet (Cache-Isolation). Der `birthdaysCache`
// in `server/services/cache.ts` wird bei jedem Customer-Create invalidiert
// (siehe `server/routes/admin/customers.ts`), daher liefert der erste GET im
// beforeAll bereits einen frischen Snapshot. Der Cache-Isolation-Case unten
// holt zusätzlich beide Varianten in derselben Test-Iteration, sodass selbst
// bei einem hypothetischen Cache-Leak die Differenz im Response-Body sichtbar
// wäre — wir testen also Antwort-Inhalt, nicht Cache-Internals.
describe("GET /api/birthdays — includePast Query-Param", () => {
  let customerId: number;
  const yesterday = isoDaysAgo(2);

  beforeAll(async () => {
    await getAuthCookie();
    // `createdAt` muss VOR dem diesjährigen Geburtstag liegen, sonst greift
    // der Task-#430-Guard (`thisYearBirthday < createdAt → forward`).
    const backdated = new Date();
    backdated.setDate(backdated.getDate() - 30);
    const created = await createTestCustomer({
      vorname: "Geburtstags-Test",
      geburtsdatum: yesterday,
      createdAtOverride: backdated,
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
    // Task #453: explizit doppelte Aufrufe in jeder Variante, damit ein
    // hypothetisches Cache-Leck (z.B. shared cache key zwischen includePast=30
    // und der unmarkierten Variante) deterministisch ans Licht kommt. Bisher
    // wurde jede Variante nur einmal abgefragt — ein TTL-Cache hätte das
    // Lecksignal evtl. verdeckt.
    const withPast1 = await apiGet<BirthdayEntry[]>("/api/birthdays?days=30&includePast=30");
    const withoutPast1 = await apiGet<BirthdayEntry[]>("/api/birthdays?days=30");
    const withPast2 = await apiGet<BirthdayEntry[]>("/api/birthdays?days=30&includePast=30");
    const withoutPast2 = await apiGet<BirthdayEntry[]>("/api/birthdays?days=30");

    const inWithPast1 = withPast1.data.some((b) => b.type === "customer" && b.id === customerId);
    const inWithoutPast1 = withoutPast1.data.some((b) => b.type === "customer" && b.id === customerId);
    const inWithPast2 = withPast2.data.some((b) => b.type === "customer" && b.id === customerId);
    const inWithoutPast2 = withoutPast2.data.some((b) => b.type === "customer" && b.id === customerId);

    // Beide Varianten müssen stabil ihre eigene Sicht behalten — auch beim
    // zweiten Aufruf (Cache muss pro Query-Variante isoliert sein).
    expect(inWithPast1, "includePast=30 muss überfälligen Kunden enthalten (1. Aufruf)").toBe(true);
    expect(inWithPast2, "includePast=30 muss überfälligen Kunden enthalten (2. Aufruf, Cache-Hit)").toBe(true);
    expect(inWithoutPast1, "ohne includePast darf überfälliger Kunde nicht erscheinen (1. Aufruf)").toBe(false);
    expect(inWithoutPast2, "ohne includePast darf überfälliger Kunde nicht erscheinen (2. Aufruf, Cache-Hit)").toBe(false);
  });

  it("includePast=1 (Fenster zu klein): Kunde mit Geburtstag vor 2 Tagen fehlt", async () => {
    const res = await apiGet<BirthdayEntry[]>("/api/birthdays?days=30&includePast=1");
    expect(res.status).toBe(200);
    const found = res.data.find((b) => b.type === "customer" && b.id === customerId);
    expect(found).toBeUndefined();
  });
});
