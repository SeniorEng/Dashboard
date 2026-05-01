import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  apiPost,
  apiPostAs,
  apiPatch,
  apiPut,
  apiGet,
  createTestEmployee,
  deactivateTestEmployee,
  resetAuthCache,
  getAuthCookie,
  loginAs,
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

    it("Deaktivieren via /deactivate-Endpoint setzt isTeamLead persistent zurück", async () => {
      const leadId = await makeEmployee("TLDeactivateEp");
      const promote = await apiPatch<any>(`/api/admin/users/${leadId}`, { isTeamLead: true });
      expect(promote.status).toBe(200);
      expect(promote.data.isTeamLead).toBe(true);

      const deactivate = await apiPost<any>(`/api/admin/users/${leadId}/deactivate`, {});
      expect(deactivate.status).toBe(200);

      const reread = await apiGet<any>(`/api/admin/users/${leadId}`);
      expect(reread.status).toBe(200);
      expect(reread.data.isActive).toBe(false);
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

  // Task #285 — neue Anlegen-Pfade aus Task #282:
  // Super-Admin kann isTeamLead direkt im POST setzen, normale Admins nicht,
  // und die Invariante "Admin ⇒ kein Teamleiter" greift auch beim Anlegen.
  describe("Anlegen mit isTeamLead (Task #282 / #285)", () => {
    function buildNewUserPayload(prefix: string, overrides: Record<string, unknown> = {}) {
      const ts = Date.now();
      const rand = Math.random().toString(36).slice(2, 7);
      const phoneSuffix = String(ts).slice(-9).padStart(9, "0");
      return {
        email: `tl-create-${ts}-${rand}@test.local`,
        password: "TestPasswort123!",
        vorname: "Test",
        nachname: `${prefix}_${ts}_${rand}`,
        geburtsdatum: "1990-01-01",
        eintrittsdatum: "2024-01-01",
        telefon: `+49170${phoneSuffix}`,
        ...overrides,
      };
    }

    it("Super-Admin kann beim Anlegen direkt isTeamLead: true setzen", async () => {
      const payload = buildNewUserPayload("TLCreateLead", { isTeamLead: true });
      const res = await apiPost<any>("/api/admin/users", payload);
      expect(res.status).toBe(201);
      expect(res.data.isTeamLead).toBe(true);
      expect(res.data.isAdmin).toBe(false);
      createdIds.push(res.data.id);

      // Persistenz nochmal prüfen: erneutes Lesen liefert denselben Marker.
      const reread = await apiGet<any>(`/api/admin/users/${res.data.id}`);
      expect(reread.status).toBe(200);
      expect(reread.data.isTeamLead).toBe(true);
      expect(reread.data.isAdmin).toBe(false);
    });

    it("normaler Admin (kein Super-Admin) bekommt 403 mit klarer Nachricht, wenn er isTeamLead: true mitschickt", async () => {
      const adminEmp = await createTestEmployee({
        isAdmin: true,
        nachnamePrefix: "TLCreateAdminCaller",
      });
      createdIds.push(adminEmp.id);

      // Damit das Request den /users-Handler überhaupt erreicht, braucht der
      // normale Admin die 'users'-Berechtigung. Ohne sie würde schon der
      // Permission-Guard mit einer generischen Meldung blocken.
      const grantPerms = await apiPut<any>(`/api/admin/users/${adminEmp.id}/permissions`, {
        permissions: ["users"],
      });
      expect(grantPerms.status).toBe(200);

      const adminAuth = await loginAs(adminEmp.email, adminEmp.password);

      const payload = buildNewUserPayload("TLCreateForbidden", { isTeamLead: true });
      const res = await apiPostAs<any>(adminAuth, "/api/admin/users", payload);

      expect(res.status).toBe(403);
      expect(res.data.error).toBe("FORBIDDEN");
      expect(res.data.message).toBe("Nur der Hauptadministrator kann Teamleitungen anlegen");
    });

    it("isAdmin: true und isTeamLead: true gemeinsam ⇒ isTeamLead wird auf false gesetzt", async () => {
      const payload = buildNewUserPayload("TLCreateAdminAndLead", {
        isAdmin: true,
        isTeamLead: true,
      });
      const res = await apiPost<any>("/api/admin/users", payload);
      expect(res.status).toBe(201);
      expect(res.data.isAdmin).toBe(true);
      expect(res.data.isTeamLead).toBe(false);
      createdIds.push(res.data.id);

      // Auch beim erneuten Lesen darf der Teamleiter-Marker nicht erscheinen.
      const reread = await apiGet<any>(`/api/admin/users/${res.data.id}`);
      expect(reread.status).toBe(200);
      expect(reread.data.isAdmin).toBe(true);
      expect(reread.data.isTeamLead).toBe(false);
    });
  });
});
