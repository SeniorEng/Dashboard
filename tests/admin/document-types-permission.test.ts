import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  apiPut,
  apiGetAs,
  apiPostAs,
  createTestEmployee,
  deactivateTestEmployee,
  resetAuthCache,
  getAuthCookie,
  loginAs,
} from "../test-utils";

/**
 * Task #417 — Admins mit `customers`-Recht (ohne `documents`-Recht) müssen
 * die Liste der Dokumententypen lesen können, sonst bleibt das Upload-Sheet
 * im Admin-Kundenbereich leer und der Upload schlägt stumm fehl.
 *
 * Schreiben (POST /document-types) bleibt weiterhin `documents`-exklusiv.
 */

const createdIds: number[] = [];

beforeAll(async () => {
  await getAuthCookie();
});

afterAll(async () => {
  for (const id of [...createdIds].reverse()) {
    await deactivateTestEmployee(id).catch(() => {});
  }
  resetAuthCache();
});

describe("Task #417 – /api/admin/document-types Read-Fallback", () => {
  it("Admin mit nur 'customers'-Recht darf document-types lesen, aber nicht anlegen", async () => {
    const admin = await createTestEmployee({ isAdmin: true, nachnamePrefix: "DocTypeReadFallback" });
    createdIds.push(admin.id);

    const grant = await apiPut<any>(`/api/admin/users/${admin.id}/permissions`, {
      permissions: ["customers"],
    });
    expect(grant.status).toBe(200);

    const adminAuth = await loginAs(admin.email, admin.password);

    const readRes = await apiGetAs<any>(adminAuth, "/api/admin/document-types");
    expect(readRes.status).toBe(200);
    expect(Array.isArray(readRes.data)).toBe(true);

    const writeRes = await apiPostAs<any>(adminAuth, "/api/admin/document-types", {
      name: `Test-Typ ${Date.now()}`,
      kind: "customer",
    });
    expect(writeRes.status).toBe(403);
  });

  it("Admin ganz ohne admin-Permissions bekommt weiterhin 403 beim Lesen", async () => {
    const admin = await createTestEmployee({ isAdmin: true, nachnamePrefix: "DocTypeNoPerms" });
    createdIds.push(admin.id);

    const grant = await apiPut<any>(`/api/admin/users/${admin.id}/permissions`, {
      permissions: [],
    });
    expect(grant.status).toBe(200);

    const adminAuth = await loginAs(admin.email, admin.password);
    const readRes = await apiGetAs<any>(adminAuth, "/api/admin/document-types");
    expect(readRes.status).toBe(403);
  });
});
