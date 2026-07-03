import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  apiGet,
  getAuthCookie,
  createTestEmployee,
  deactivateTestEmployee,
} from "./test-utils";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";

/**
 * Guard für Task #1637/#1638: Ehemalige (deaktivierte) zuständige Mitarbeiter
 * müssen auf der Kunden-„Zuständige Mitarbeiter"-Karte weiterhin mit ihrem
 * echten Namen erscheinen. Die Karte liest die Namen über
 * GET /api/appointments/employee-names, welches – anders als
 * /active-employees – auch deaktivierte Nutzer auflöst. Dieser Test
 * verhindert, dass ein künftiger Umbau still wieder den Platzhalter
 * „Ehemalige/r Mitarbeiter/in" einführt.
 */
describe("GET /api/appointments/employee-names", () => {
  let activeEmployeeId: number;
  let deactivatedEmployeeId: number;
  let activeName: string;
  let deactivatedName: string;

  beforeAll(async () => {
    const active = await createTestEmployee({ nachnamePrefix: "AktiverZust" });
    activeEmployeeId = active.id;

    const deactivated = await createTestEmployee({ nachnamePrefix: "AusgeschiedenZust" });
    deactivatedEmployeeId = deactivated.id;
    await deactivateTestEmployee(deactivatedEmployeeId);

    // Anzeigenamen für spätere Assertions über /active-employees bzw. den
    // Endpoint selbst ermitteln – wir vertrauen nicht auf ein bestimmtes
    // vorname/nachname-Format.
    const res = await apiGet<Array<{ id: number; displayName: string }>>(
      `/api/appointments/employee-names?ids=${activeEmployeeId},${deactivatedEmployeeId}`,
    );
    activeName = res.data.find((r) => r.id === activeEmployeeId)!.displayName;
    deactivatedName = res.data.find((r) => r.id === deactivatedEmployeeId)!.displayName;
  });

  afterAll(async () => {
    await deactivateTestEmployee(activeEmployeeId);
  });

  it("löst den Anzeigenamen eines aktiven Mitarbeiters auf", async () => {
    const res = await apiGet<Array<{ id: number; displayName: string }>>(
      `/api/appointments/employee-names?ids=${activeEmployeeId}`,
    );
    expect(res.status).toBe(200);
    const row = res.data.find((r) => r.id === activeEmployeeId);
    expect(row).toBeDefined();
    expect(typeof row!.displayName).toBe("string");
    expect(row!.displayName.length).toBeGreaterThan(0);
    expect(row!.displayName).toBe(activeName);
  });

  it("löst den echten Anzeigenamen eines DEAKTIVIERTEN Mitarbeiters auf (kein Platzhalter)", async () => {
    const res = await apiGet<Array<{ id: number; displayName: string }>>(
      `/api/appointments/employee-names?ids=${deactivatedEmployeeId}`,
    );
    expect(res.status).toBe(200);
    const row = res.data.find((r) => r.id === deactivatedEmployeeId);
    expect(row).toBeDefined();
    expect(typeof row!.displayName).toBe("string");
    expect(row!.displayName.length).toBeGreaterThan(0);
    expect(row!.displayName).toBe(deactivatedName);
    // Nicht der Frontend-Platzhalter aus Task #1637.
    expect(row!.displayName).not.toBe("Ehemalige/r Mitarbeiter/in");
  });

  it("löst mehrere IDs (aktiv + deaktiviert) in einem Aufruf auf", async () => {
    const res = await apiGet<Array<{ id: number; displayName: string }>>(
      `/api/appointments/employee-names?ids=${activeEmployeeId},${deactivatedEmployeeId}`,
    );
    expect(res.status).toBe(200);
    const ids = res.data.map((r) => r.id);
    expect(ids).toContain(activeEmployeeId);
    expect(ids).toContain(deactivatedEmployeeId);
  });

  it("gibt AUSSCHLIESSLICH id + displayName zurück (keine sensiblen Felder)", async () => {
    const res = await apiGet<Array<Record<string, unknown>>>(
      `/api/appointments/employee-names?ids=${activeEmployeeId},${deactivatedEmployeeId}`,
    );
    expect(res.status).toBe(200);
    expect(res.data.length).toBeGreaterThan(0);
    for (const row of res.data) {
      expect(Object.keys(row).sort()).toEqual(["displayName", "id"]);
      // Defense-in-depth: explizit sicherstellen, dass keine sensiblen
      // Nutzerfelder durchsickern.
      for (const forbidden of [
        "email",
        "password",
        "passwordHash",
        "telefon",
        "isAdmin",
        "isSuperAdmin",
        "roles",
        "geburtsdatum",
        "eintrittsdatum",
      ]) {
        expect(row).not.toHaveProperty(forbidden);
      }
    }
  });

  it("gibt ein leeres Array zurück, wenn keine ids übergeben werden", async () => {
    const res = await apiGet<unknown[]>(`/api/appointments/employee-names`);
    expect(res.status).toBe(200);
    expect(res.data).toEqual([]);
  });

  it("gibt ein leeres Array bei ausschließlich ungültigen ids zurück", async () => {
    const res = await apiGet<unknown[]>(
      `/api/appointments/employee-names?ids=abc,-1,0,%20`,
    );
    expect(res.status).toBe(200);
    expect(res.data).toEqual([]);
  });

  it("erfordert Authentifizierung", async () => {
    const res = await fetch(
      `${BASE_URL}/api/appointments/employee-names?ids=${activeEmployeeId}`,
    );
    expect(res.status).toBe(401);
  });
});
