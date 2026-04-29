import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  apiPost,
  apiPatch,
  apiGet,
  createTestEmployee,
  deactivateTestEmployee,
  resetAuthCache,
  getAuthCookie,
} from "./test-utils";

/**
 * Task #252 — Teamleitung als flacher Marker (zurückgedrehtes Konzept).
 *
 * Validiert das Fundament des reduzierten Modells:
 *  - Schema kennt nur noch isTeamLead (boolean, default false).
 *  - Es gibt keine Hierarchie mehr (teamLeadId ist entfernt).
 *  - SuperAdmin kann isTeamLead setzen/zurücknehmen.
 *  - Admin und Teamleiter schließen sich aus (kein Doppel-Marker).
 *  - Eingeschleuste teamLeadId-Felder werden ignoriert (nicht persistiert).
 */

const createdIds: number[] = [];

async function makeEmployee(prefix: string): Promise<number> {
  const emp = await createTestEmployee({ nachnamePrefix: prefix });
  createdIds.push(emp.id);
  return emp.id;
}

async function makeAdmin(prefix: string): Promise<number> {
  const emp = await createTestEmployee({ isAdmin: true, nachnamePrefix: prefix });
  createdIds.push(emp.id);
  return emp.id;
}

beforeAll(async () => {
  await getAuthCookie();
});

afterAll(async () => {
  for (const id of [...createdIds].reverse()) {
    await deactivateTestEmployee(id).catch(() => {});
  }
  resetAuthCache();
});

describe("Task #252 – Teamleitung (flacher Marker)", () => {
  describe("Schema & Defaults", () => {
    it("neu angelegte Mitarbeiter sind kein Teamleiter", async () => {
      const empId = await makeEmployee("TLDefault");
      const res = await apiGet<any>(`/api/admin/users/${empId}`);
      expect(res.status).toBe(200);
      expect(res.data.isTeamLead).toBe(false);
      expect(res.data.teamLeadId).toBeUndefined();
    });
  });

  describe("Markierung umschalten", () => {
    it("kann einen Mitarbeiter zum Teamleiter machen und wieder zurücksetzen", async () => {
      const leadId = await makeEmployee("TLLead");

      const setLead = await apiPatch<any>(`/api/admin/users/${leadId}`, { isTeamLead: true });
      expect(setLead.status).toBe(200);
      expect(setLead.data.isTeamLead).toBe(true);

      const reset = await apiPatch<any>(`/api/admin/users/${leadId}`, { isTeamLead: false });
      expect(reset.status).toBe(200);
      expect(reset.data.isTeamLead).toBe(false);
    });
  });

  describe("Inaktive/anonymisierte Mitarbeiter", () => {
    it("ein inaktiver Mitarbeiter kann nicht zum Teamleiter gemacht werden", async () => {
      const empId = await makeEmployee("TLInactive");
      const deactivate = await apiPatch<any>(`/api/admin/users/${empId}`, { isActive: false });
      expect(deactivate.status).toBe(200);

      const setLead = await apiPatch<any>(`/api/admin/users/${empId}`, { isTeamLead: true });
      expect(setLead.status).toBe(400);
    });

    it("Deaktivieren eines bestehenden Teamleiters setzt isTeamLead automatisch zurück", async () => {
      const leadId = await makeEmployee("TLAutoReset");
      const promote = await apiPatch<any>(`/api/admin/users/${leadId}`, { isTeamLead: true });
      expect(promote.status).toBe(200);
      expect(promote.data.isTeamLead).toBe(true);

      const deactivate = await apiPatch<any>(`/api/admin/users/${leadId}`, { isActive: false });
      expect(deactivate.status).toBe(200);
      expect(deactivate.data.isTeamLead).toBe(false);

      const reread = await apiGet<any>(`/api/admin/users/${leadId}`);
      expect(reread.status).toBe(200);
      expect(reread.data.isTeamLead).toBe(false);
    });
  });

  describe("Konflikt mit Admin-Rolle", () => {
    it("ein Admin kann nicht gleichzeitig Teamleiter sein", async () => {
      const adminId = await makeAdmin("TLConflictA");
      const res = await apiPatch<any>(`/api/admin/users/${adminId}`, { isTeamLead: true });
      expect(res.status).toBe(400);
    });

    it("ein Teamleiter kann nicht gleichzeitig zum Admin gemacht werden", async () => {
      const leadId = await makeEmployee("TLConflictL");
      await apiPatch(`/api/admin/users/${leadId}`, { isTeamLead: true });
      const res = await apiPatch<any>(`/api/admin/users/${leadId}`, { isAdmin: true });
      expect(res.status).toBe(400);
    });
  });

  describe("Hierarchie ist entfernt", () => {
    it("teamLeadId im Patch-Body wird ignoriert (kein Persistieren der Hierarchie)", async () => {
      const leadId = await makeEmployee("TLHierLead");
      await apiPatch(`/api/admin/users/${leadId}`, { isTeamLead: true });

      const memberId = await makeEmployee("TLHierMember");
      const res = await apiPatch<any>(`/api/admin/users/${memberId}`, { teamLeadId: leadId });
      expect(res.status).toBe(200);
      // Feld darf nirgendwo erscheinen — weder in der Antwort noch beim Folgelesen.
      expect((res.data as any).teamLeadId).toBeUndefined();

      const fetched = await apiGet<any>(`/api/admin/users/${memberId}`);
      expect(fetched.status).toBe(200);
      expect((fetched.data as any).teamLeadId).toBeUndefined();
    });

    it("die alte /api/team-Route ist nicht mehr als API registriert", async () => {
      const res = await apiGet<any>("/api/team/members");
      // Entweder 404/405 oder die SPA-Fallback-HTML-Antwort (keine JSON-Liste).
      const isJsonResponse = !!(res.data && typeof res.data === "object" && "members" in (res.data as object));
      expect(isJsonResponse).toBe(false);
    });
  });
});
