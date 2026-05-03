import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  apiPatch,
  apiPatchAs,
  loginAs,
  createTestEmployee,
  createTestCustomer,
  deactivateTestEmployee,
  resetAuthCache,
  getAuthCookie,
} from "./test-utils";

/**
 * Task #313 — Schnell-Editor für Kundenzuordnung (Haupt / Vertretung 1+2).
 *
 * Sichert die Backend-Route PATCH /api/customers/:id/assignment ab:
 *   - Teamleitung (isTeamLead && !isAdmin) darf ändern.
 *   - Admin darf weiterhin ändern (Rückwärtskompatibilität neben /admin/...).
 *   - Reguläre Mitarbeiter dürfen NICHT (403).
 *   - Doppelte Mitarbeiter-IDs werden mit 400 abgelehnt.
 *   - Inaktive Mitarbeiter werden mit 400 abgelehnt.
 */

const createdEmployeeIds: number[] = [];
const createdCustomerIds: number[] = [];

interface Setup {
  adminAuth: Awaited<ReturnType<typeof getAuthCookie>>;
  lead: { id: number; email: string; password: string };
  leadAuth: Awaited<ReturnType<typeof loginAs>>;
  regular: { id: number; email: string; password: string };
  regularAuth: Awaited<ReturnType<typeof loginAs>>;
  empA: { id: number; email: string; password: string };
  empB: { id: number; email: string; password: string };
  empInactive: { id: number; email: string; password: string };
  customerId: number;
}

let setup: Setup;

beforeAll(async () => {
  const adminAuth = await getAuthCookie();

  const lead = await createTestEmployee({ nachnamePrefix: "T313_Lead" });
  createdEmployeeIds.push(lead.id);
  const regular = await createTestEmployee({ nachnamePrefix: "T313_Reg" });
  createdEmployeeIds.push(regular.id);
  const empA = await createTestEmployee({ nachnamePrefix: "T313_A" });
  createdEmployeeIds.push(empA.id);
  const empB = await createTestEmployee({ nachnamePrefix: "T313_B" });
  createdEmployeeIds.push(empB.id);
  const empInactive = await createTestEmployee({ nachnamePrefix: "T313_Inactive" });
  createdEmployeeIds.push(empInactive.id);

  await apiPatch(`/api/admin/users/${lead.id}`, { isTeamLead: true });
  // Mitarbeiter "empInactive" deaktivieren
  await apiPatch(`/api/admin/users/${empInactive.id}`, { isActive: false });

  const leadAuth = await loginAs(lead.email, lead.password);
  const regularAuth = await loginAs(regular.email, regular.password);

  const customerRaw = await createTestCustomer({ nachname: `T313_Cust_${Date.now()}` });
  const customerId = customerRaw.id;
  createdCustomerIds.push(customerId);

  setup = { adminAuth, lead, leadAuth, regular, regularAuth, empA, empB, empInactive, customerId };
});

afterAll(async () => {
  for (const id of [...createdEmployeeIds].reverse()) {
    await deactivateTestEmployee(id).catch(() => {});
  }
  resetAuthCache();
});

describe("Task #313 – PATCH /api/customers/:id/assignment", () => {
  it("Teamleitung darf Zuordnung mit gültigen IDs ändern (200)", async () => {
    const res = await apiPatchAs<any>(setup.leadAuth, `/api/customers/${setup.customerId}/assignment`, {
      primaryEmployeeId: setup.empA.id,
      backupEmployeeId: setup.empB.id,
      backupEmployeeId2: null,
    });
    expect(res.status).toBe(200);
    expect(res.data.primaryEmployeeId).toBe(setup.empA.id);
    expect(res.data.backupEmployeeId).toBe(setup.empB.id);
    expect(res.data.backupEmployeeId2).toBeNull();
  });

  it("Teamleitung: doppelte IDs werden abgelehnt (400)", async () => {
    const res = await apiPatchAs<any>(setup.leadAuth, `/api/customers/${setup.customerId}/assignment`, {
      primaryEmployeeId: setup.empA.id,
      backupEmployeeId: setup.empA.id,
      backupEmployeeId2: null,
    });
    expect(res.status).toBe(400);
    expect(String((res.data as any)?.message ?? "")).toMatch(/unterschiedlich/i);
  });

  it("Teamleitung: inaktiver Mitarbeiter als Hauptansprechpartner wird abgelehnt (400)", async () => {
    const res = await apiPatchAs<any>(setup.leadAuth, `/api/customers/${setup.customerId}/assignment`, {
      primaryEmployeeId: setup.empInactive.id,
      backupEmployeeId: null,
      backupEmployeeId2: null,
    });
    expect(res.status).toBe(400);
    expect(String((res.data as any)?.message ?? "")).toMatch(/aktiv/i);
  });

  it("Regulärer Mitarbeiter darf Zuordnung NICHT ändern (403)", async () => {
    const res = await apiPatchAs<any>(setup.regularAuth, `/api/customers/${setup.customerId}/assignment`, {
      primaryEmployeeId: setup.empA.id,
      backupEmployeeId: null,
      backupEmployeeId2: null,
    });
    expect(res.status).toBe(403);
  });

  it("Admin darf Zuordnung über die neue Route ändern (200, Rückwärtskompatibilität)", async () => {
    const res = await apiPatchAs<any>(setup.adminAuth, `/api/customers/${setup.customerId}/assignment`, {
      primaryEmployeeId: setup.empB.id,
      backupEmployeeId: setup.empA.id,
      backupEmployeeId2: null,
    });
    expect(res.status).toBe(200);
    expect(res.data.primaryEmployeeId).toBe(setup.empB.id);
    expect(res.data.backupEmployeeId).toBe(setup.empA.id);
  });
});
