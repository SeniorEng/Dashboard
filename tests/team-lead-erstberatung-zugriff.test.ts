import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  apiPatch,
  apiGetAs,
  loginAs,
  createTestEmployee,
  deactivateTestEmployee,
  resetAuthCache,
} from "./test-utils";

/**
 * Task #309 — Regressionstest zu Task #308 (Ursulas Bug).
 *
 * Stellt sicher, dass Teamleitungen (isTeamLead = true, isAdmin = false) die
 * Erstberatungs-Übersicht weiterhin laden können und der nötige Mitarbeiter-
 * Payload `roles` enthält. Reguläre Mitarbeiter ohne Marker erhalten
 * weiterhin 403.
 */

const createdEmployeeIds: number[] = [];

let leadAuth: Awaited<ReturnType<typeof loginAs>>;
let regularAuth: Awaited<ReturnType<typeof loginAs>>;

beforeAll(async () => {
  const lead = await createTestEmployee({ nachnamePrefix: "TL309_Lead" });
  createdEmployeeIds.push(lead.id);
  await apiPatch(`/api/admin/users/${lead.id}`, { isTeamLead: true });

  const regular = await createTestEmployee({ nachnamePrefix: "TL309_Reg" });
  createdEmployeeIds.push(regular.id);

  leadAuth = await loginAs(lead.email, lead.password);
  regularAuth = await loginAs(regular.email, regular.password);
});

afterAll(async () => {
  for (const id of [...createdEmployeeIds].reverse()) {
    await deactivateTestEmployee(id).catch(() => {});
  }
  resetAuthCache();
});

describe("Task #309 – Teamleitung darf Erstberatungen umlegen", () => {
  it("Teamleitung erhält 200 auf /api/appointments/planned-consultations", async () => {
    const res = await apiGetAs<unknown>(leadAuth, "/api/appointments/planned-consultations");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data)).toBe(true);
  });

  it("Teamleitung erhält 200 auf /api/appointments/planned-consultations?filter=overdue", async () => {
    const res = await apiGetAs<unknown>(
      leadAuth,
      "/api/appointments/planned-consultations?filter=overdue",
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data)).toBe(true);
  });

  it("/api/appointments/active-employees enthält roles im Payload für Teamleitungen", async () => {
    const res = await apiGetAs<Array<{ id: number; displayName: string; roles?: unknown }>>(
      leadAuth,
      "/api/appointments/active-employees",
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data)).toBe(true);
    expect(res.data.length).toBeGreaterThan(0);
    for (const emp of res.data) {
      expect(emp).toHaveProperty("roles");
      expect(Array.isArray(emp.roles)).toBe(true);
    }
  });

  it("regulärer Mitarbeiter ohne Teamleitung-Marker erhält 403 auf /planned-consultations", async () => {
    const res = await apiGetAs<{ code?: string }>(
      regularAuth,
      "/api/appointments/planned-consultations",
    );
    expect(res.status).toBe(403);
  });
});
