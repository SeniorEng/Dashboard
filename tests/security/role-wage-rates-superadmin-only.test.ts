import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  apiGet,
  apiGetAs,
  apiPostAs,
  apiDeleteAs,
  apiPost,
  apiDelete,
  createTestEmployee,
  deactivateTestEmployee,
  loginAs,
  getFutureDate,
} from "../test-utils";

/**
 * Task #1511 — Lohn-Daten sind ausnahmslos Superadmin-only.
 *
 * Task #1510 hat die rollenbasierte Lohn-Matrix Superadmin-exklusiv gemacht:
 * die fünf `/api/services/role-wage-rates*`-Routen wurden von `requireAdmin` auf
 * `requireSuperAdmin` umgestellt. Dieser Test PINNT die Garantie serverseitig,
 * damit ein späteres Refactor die sensiblen Lohn-/Vergütungsdaten nicht
 * unbemerkt wieder für normale Admins öffnet.
 *
 * Kontrakt:
 *   - Normaler Admin (isAdmin=true, isSuperAdmin=false) → 403 FORBIDDEN auf
 *     ALLEN fünf Routen (GET, GET /all, GET /future, POST, DELETE /:rateId).
 *   - Superadmin (Default-Test-User) → 200/erwartetes Verhalten.
 *
 * Wichtig: der Default-Test-User (`apiGet`/`apiPost`/...) ist der geseedete
 * Superadmin; den normalen Admin legen wir explizit per `createTestEmployee`
 * an und loggen uns separat ein.
 */

interface ServiceRow {
  id: number;
  isActive: boolean;
}

interface ErrorResponse {
  error?: string;
  message?: string;
}

const createdEmployeeIds: number[] = [];
let normalAdminAuth: Awaited<ReturnType<typeof loginAs>>;
let serviceId: number;
const createdRateIds: number[] = [];

beforeAll(async () => {
  const normalAdmin = await createTestEmployee({ isAdmin: true, nachnamePrefix: "WageGateAdmin" });
  createdEmployeeIds.push(normalAdmin.id);
  normalAdminAuth = await loginAs(normalAdmin.email, normalAdmin.password);

  // Eine echte aktive Leistung für die superadmin-seitigen 200er-Pfade
  // (POST/DELETE brauchen eine gültige serviceId).
  const servicesRes = await apiGet<ServiceRow[]>("/api/services");
  expect(servicesRes.status).toBe(200);
  const active = (servicesRes.data || []).find(s => s.isActive) || servicesRes.data?.[0];
  expect(active, "Mindestens eine Leistung im Katalog erwartet").toBeTruthy();
  serviceId = active!.id;
});

afterAll(async () => {
  // Erzeugte Lohnsatz-Zeilen wieder entfernen (als Superadmin).
  for (const rateId of createdRateIds) {
    try {
      await apiDelete(`/api/services/role-wage-rates/${rateId}?confirmClosedOverride=true`);
    } catch {}
  }
  for (const id of createdEmployeeIds) await deactivateTestEmployee(id);
});

describe("Lohn-Routen sind Superadmin-only (Task #1511)", () => {
  describe("Normaler Admin → 403 auf allen 5 Routen", () => {
    it("GET /services/role-wage-rates → 403", async () => {
      const res = await apiGetAs<ErrorResponse>(normalAdminAuth, "/api/services/role-wage-rates");
      expect(res.status).toBe(403);
      expect(res.data.error).toBe("FORBIDDEN");
    });

    it("GET /services/role-wage-rates/all → 403", async () => {
      const res = await apiGetAs<ErrorResponse>(normalAdminAuth, "/api/services/role-wage-rates/all");
      expect(res.status).toBe(403);
      expect(res.data.error).toBe("FORBIDDEN");
    });

    it("GET /services/role-wage-rates/future → 403", async () => {
      const res = await apiGetAs<ErrorResponse>(normalAdminAuth, "/api/services/role-wage-rates/future");
      expect(res.status).toBe(403);
      expect(res.data.error).toBe("FORBIDDEN");
    });

    it("POST /services/role-wage-rates → 403 (vor jeder Validierung)", async () => {
      const res = await apiPostAs<ErrorResponse>(normalAdminAuth, "/api/services/role-wage-rates", {
        role: "employee",
        serviceId,
        cents: 1500,
        validFrom: getFutureDate(400),
      });
      expect(res.status).toBe(403);
      expect(res.data.error).toBe("FORBIDDEN");
    });

    it("DELETE /services/role-wage-rates/:rateId → 403", async () => {
      const res = await apiDeleteAs(normalAdminAuth, "/api/services/role-wage-rates/1");
      expect(res.status).toBe(403);
      expect((res.data as ErrorResponse).error).toBe("FORBIDDEN");
    });
  });

  describe("Superadmin → 200/erwartetes Verhalten", () => {
    it("GET /services/role-wage-rates → 200 (Array)", async () => {
      const res = await apiGet<unknown[]>("/api/services/role-wage-rates");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.data)).toBe(true);
    });

    it("GET /services/role-wage-rates/all → 200 (Array)", async () => {
      const res = await apiGet<unknown[]>("/api/services/role-wage-rates/all");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.data)).toBe(true);
    });

    it("GET /services/role-wage-rates/future → 200 (Array)", async () => {
      const res = await apiGet<unknown[]>("/api/services/role-wage-rates/future");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.data)).toBe(true);
    });

    it("POST /services/role-wage-rates → 200 (legt Lohnsatz an)", async () => {
      // Weit in der Zukunft → kein Abschluss-/Ersetzen-Konflikt.
      const res = await apiPost<{ id: number }>("/api/services/role-wage-rates", {
        role: "employee",
        serviceId,
        cents: 1750,
        validFrom: getFutureDate(420),
      });
      expect(res.status).toBe(200);
      expect(typeof res.data.id).toBe("number");
      createdRateIds.push(res.data.id);
    });

    it("DELETE /services/role-wage-rates/:rateId → 200 (entfernt Zukunfts-Zeile)", async () => {
      const rateId = createdRateIds[0];
      expect(rateId, "POST-Test muss zuvor eine Zeile angelegt haben").toBeTruthy();
      const res = await apiDelete(`/api/services/role-wage-rates/${rateId}`);
      expect(res.status).toBe(200);
      expect((res.data as { success?: boolean }).success).toBe(true);
      createdRateIds.shift();
    });
  });
});
