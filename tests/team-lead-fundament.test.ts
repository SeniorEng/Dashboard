import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  apiPost,
  apiPatch,
  apiGet,
  apiPut,
  apiPatchAs,
  loginAs,
  createTestEmployee,
  deactivateTestEmployee,
  resetAuthCache,
  getAuthCookie,
} from "./test-utils";

/**
 * Task #200 — Teamleiter-Fundament
 *
 * Validiert das reine Fundament:
 *  - Schema (isTeamLead, teamLeadId)
 *  - Vier Validierungs-Fälle der PATCH-Route
 *  - Helper-Modul (countActiveReports, getTeamMemberIds)
 *  - Deactivation-Pfad: Teamleiter mit aktiven Reports kann nicht deaktiviert werden
 *  - Audit-Einträge (user_team_lead_set / _unset / _assigned)
 *
 * Achtung: Visibility und Schreibrechte folgen in Tasks #201/#202.
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

async function patchUser(id: number, patch: Record<string, unknown>) {
  return apiPatch<any>(`/api/admin/users/${id}`, patch);
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

describe("Task #200 – Teamleiter-Fundament", () => {
  describe("Schema & Defaults", () => {
    it("neu angelegte Mitarbeiter sind kein Teamleiter und haben keinen teamLeadId", async () => {
      const empId = await makeEmployee("TLDefault");
      const res = await apiGet<any>(`/api/admin/users/${empId}`);
      expect(res.status).toBe(200);
      expect(res.data.isTeamLead).toBe(false);
      expect(res.data.teamLeadId).toBeNull();
    });
  });

  describe("Markierung & Zuordnung (Happy Path)", () => {
    it("kann einen Mitarbeiter zum Teamleiter machen und einen anderen zuordnen", async () => {
      const leadId = await makeEmployee("TLLead");
      const memberId = await makeEmployee("TLMember");

      const setLead = await patchUser(leadId, { isTeamLead: true });
      expect(setLead.status).toBe(200);
      expect(setLead.data.isTeamLead).toBe(true);

      const assign = await patchUser(memberId, { teamLeadId: leadId });
      expect(assign.status).toBe(200);
      expect(assign.data.teamLeadId).toBe(leadId);
    });

    it("kann teamLeadId wieder auf null setzen", async () => {
      const leadId = await makeEmployee("TLLead2");
      const memberId = await makeEmployee("TLMember2");
      await patchUser(leadId, { isTeamLead: true });
      await patchUser(memberId, { teamLeadId: leadId });

      const cleared = await patchUser(memberId, { teamLeadId: null });
      expect(cleared.status).toBe(200);
      expect(cleared.data.teamLeadId).toBeNull();
    });
  });

  describe("Validierungsfälle", () => {
    it("Fall 1: Selbstreferenz wird abgelehnt", async () => {
      const empId = await makeEmployee("TLSelf");
      const res = await patchUser(empId, { teamLeadId: empId });
      expect(res.status).toBe(400);
      expect(res.data.message).toMatch(/eigener Teamleiter/i);
    });

    it("Fall 2: Admin darf keinen teamLeadId haben", async () => {
      const adminId = await makeAdmin("TLAdmin");
      const leadId = await makeEmployee("TLLeadForAdmin");
      await patchUser(leadId, { isTeamLead: true });

      const res = await patchUser(adminId, { teamLeadId: leadId });
      expect(res.status).toBe(400);
      expect(res.data.message).toMatch(/Administrator/i);
    });

    it("Fall 3: Teamleiter darf selbst keinen teamLeadId haben", async () => {
      const leadAId = await makeEmployee("TLLeadA");
      const leadBId = await makeEmployee("TLLeadB");
      await patchUser(leadAId, { isTeamLead: true });
      await patchUser(leadBId, { isTeamLead: true });

      const res = await patchUser(leadAId, { teamLeadId: leadBId });
      expect(res.status).toBe(400);
      expect(res.data.message).toMatch(/Teamleiter kann selbst keinen Teamleiter/i);
    });

    it("Fall 4a: nicht-existierender teamLeadId wird abgelehnt", async () => {
      const empId = await makeEmployee("TLBadRef");
      const res = await patchUser(empId, { teamLeadId: 999999999 });
      expect(res.status).toBe(400);
      expect(res.data.message).toMatch(/nicht.*verfügbar/i);
    });

    it("Fall 4b: zugewiesener Mitarbeiter ist nicht isTeamLead → abgelehnt", async () => {
      const empId = await makeEmployee("TLNonLead");
      const otherId = await makeEmployee("TLOtherNonLead");
      const res = await patchUser(empId, { teamLeadId: otherId });
      expect(res.status).toBe(400);
      expect(res.data.message).toMatch(/nicht.*verfügbar/i);
    });

    it("Invariante: Admin und Teamleiter gleichzeitig wird abgelehnt", async () => {
      const empId = await makeEmployee("TLBoth");
      const res = await patchUser(empId, { isAdmin: true, isTeamLead: true });
      expect(res.status).toBe(400);
      expect(res.data.message).toMatch(/gleichzeitig|Administrator/i);
    });

    it("Fall 4e: Admin als Teamleiter zuweisen wird abgelehnt", async () => {
      const adminId = await makeAdmin("TLAdminAsLead");
      const empId = await makeEmployee("TLNeedsAdminLead");
      // Admin kann gar nicht isTeamLead sein, aber falls jemand das versucht zu umgehen:
      const res = await patchUser(empId, { teamLeadId: adminId });
      expect(res.status).toBe(400);
      expect(res.data.message).toMatch(/nicht.*verfügbar/i);
    });

    it("Authz: nicht-SuperAdmin darf isTeamLead nicht setzen", async () => {
      const adminEmp = await createTestEmployee({ isAdmin: true, nachnamePrefix: "TLAuthzAdmin" });
      createdIds.push(adminEmp.id);
      const targetId = await makeEmployee("TLAuthzTarget");
      // Test-Admin braucht "users"-Permission, damit unser feinkörniger
      // isTeamLead-Authz-Check überhaupt greift (sonst blockt die globale
      // Bereichs-Middleware bereits davor).
      await apiPut(`/api/admin/users/${adminEmp.id}/permissions`, {
        permissions: ["users"],
      });

      const adminAuth = await loginAs(adminEmp.email, adminEmp.password);
      const res = await apiPatchAs<any>(adminAuth, `/api/admin/users/${targetId}`, {
        isTeamLead: true,
      });
      expect(res.status).toBe(403);
      expect(res.data.message).toMatch(/Hauptadministrator/i);
    });

    it("Fall 4d: zugewiesener Teamleiter ist anonymisiert → abgelehnt", async () => {
      const leadId = await makeEmployee("TLAnon");
      const empId = await makeEmployee("TLNeedsAnonLead");
      await patchUser(leadId, { isTeamLead: true });
      // Erst deaktivieren (kein Reports-Konflikt)
      const deact = await apiPost<any>(`/api/admin/users/${leadId}/deactivate`, {});
      expect(deact.status).toBe(200);
      // Dann anonymisieren
      const anon = await apiPost<any>(`/api/admin/users/${leadId}/anonymize`, {});
      expect([200, 201, 204]).toContain(anon.status);

      const res = await patchUser(empId, { teamLeadId: leadId });
      expect(res.status).toBe(400);
      expect(res.data.message).toMatch(/nicht.*verfügbar/i);
    });

    it("Fall 4c: zugewiesener Teamleiter ist deaktiviert → abgelehnt", async () => {
      const leadId = await makeEmployee("TLDeact");
      const empId = await makeEmployee("TLNeedsLead");
      await patchUser(leadId, { isTeamLead: true });
      // Deaktivieren (hat keine Reports → erlaubt)
      const deact = await apiPost<any>(`/api/admin/users/${leadId}/deactivate`, {});
      expect(deact.status).toBe(200);

      const res = await patchUser(empId, { teamLeadId: leadId });
      expect(res.status).toBe(400);
      expect(res.data.message).toMatch(/nicht.*verfügbar/i);
    });
  });

  describe("Reports-Block: Teamleiter-Markierung kann nicht entfernt werden", () => {
    it("Entzug von isTeamLead wird blockiert wenn aktive Reports existieren", async () => {
      const leadId = await makeEmployee("TLWithReports");
      const memberId = await makeEmployee("TLReport");
      await patchUser(leadId, { isTeamLead: true });
      const assign = await patchUser(memberId, { teamLeadId: leadId });
      expect(assign.status).toBe(200);

      const res = await patchUser(leadId, { isTeamLead: false });
      expect(res.status).toBe(400);
      expect(res.data.message).toMatch(/aktive Mitarbeiter/i);
    });

    it("nach Lösung der Zuordnung kann isTeamLead wieder entfernt werden", async () => {
      const leadId = await makeEmployee("TLWithReports2");
      const memberId = await makeEmployee("TLReport2");
      await patchUser(leadId, { isTeamLead: true });
      await patchUser(memberId, { teamLeadId: leadId });

      const clear = await patchUser(memberId, { teamLeadId: null });
      expect(clear.status).toBe(200);

      const res = await patchUser(leadId, { isTeamLead: false });
      expect(res.status).toBe(200);
      expect(res.data.isTeamLead).toBe(false);
    });
  });

  describe("Deactivation-Block: Teamleiter mit Reports kann nicht deaktiviert werden", () => {
    it("Deaktivierung wird abgelehnt solange Reports existieren", async () => {
      const leadId = await makeEmployee("TLDeactBlock");
      const memberId = await makeEmployee("TLDeactReport");
      await patchUser(leadId, { isTeamLead: true });
      await patchUser(memberId, { teamLeadId: leadId });

      const deact = await apiPost<any>(`/api/admin/users/${leadId}/deactivate`, {});
      expect(deact.status).toBe(400);
      expect(deact.data.message).toMatch(/Teamleiter.*nicht deaktiviert/i);
    });

    it("nach Auflösung der Zuordnung lässt sich der Teamleiter deaktivieren", async () => {
      const leadId = await makeEmployee("TLDeactOk");
      const memberId = await makeEmployee("TLDeactOkReport");
      await patchUser(leadId, { isTeamLead: true });
      await patchUser(memberId, { teamLeadId: leadId });
      await patchUser(memberId, { teamLeadId: null });

      const deact = await apiPost<any>(`/api/admin/users/${leadId}/deactivate`, {});
      expect(deact.status).toBe(200);
    });

    it("PATCH isActive=false eines Teamleiters mit Reports wird ebenfalls blockiert", async () => {
      const leadId = await makeEmployee("TLPatchDeact");
      const memberId = await makeEmployee("TLPatchDeactRep");
      await patchUser(leadId, { isTeamLead: true });
      const assign = await patchUser(memberId, { teamLeadId: leadId });
      expect(assign.status).toBe(200);

      const res = await patchUser(leadId, { isActive: false });
      expect(res.status).toBe(400);
      expect(res.data.message).toMatch(/Teamleiter.*nicht deaktiviert/i);
    });
  });

  describe("Auto-Bereinigung: Bei Wechsel zu Admin/Teamleiter wird teamLeadId entfernt", () => {
    it("Mitarbeiter mit teamLeadId, der zum Teamleiter wird, verliert teamLeadId", async () => {
      const leadId = await makeEmployee("TLAutoLead");
      const empId = await makeEmployee("TLAutoMember");
      await patchUser(leadId, { isTeamLead: true });
      await patchUser(empId, { teamLeadId: leadId });

      const res = await patchUser(empId, { isTeamLead: true });
      expect(res.status).toBe(200);
      expect(res.data.isTeamLead).toBe(true);
      expect(res.data.teamLeadId).toBeNull();
    });
  });

  describe("Audit-Einträge", () => {
    it("set/unset/assigned werden ins Audit-Log geschrieben", async () => {
      const leadId = await makeEmployee("TLAudit");
      const memberId = await makeEmployee("TLAuditMember");

      await patchUser(leadId, { isTeamLead: true });
      await patchUser(memberId, { teamLeadId: leadId });
      await patchUser(memberId, { teamLeadId: null });

      const audits = await apiGet<any>(
        `/api/admin/audit-log?entityType=user&entityId=${memberId}&limit=20`,
      );
      expect(audits.status).toBe(200);
      const entries = audits.data.entries ?? audits.data.logs ?? audits.data ?? [];
      const actions = entries.map((l: any) => l.action);
      expect(actions).toContain("user_team_lead_assigned");

      const leadAudits = await apiGet<any>(
        `/api/admin/audit-log?entityType=user&entityId=${leadId}&limit=20`,
      );
      const leadEntries = leadAudits.data.entries ?? leadAudits.data.logs ?? leadAudits.data ?? [];
      const leadActions = leadEntries.map((l: any) => l.action);
      expect(leadActions).toContain("user_team_lead_set");
    });
  });

  describe("Helper: countActiveReports / getTeamMemberIds", () => {
    it("Helper-Funktionen liefern korrekte Mitglieder-IDs", async () => {
      const { countActiveReports, getTeamMemberIds } = await import(
        "../server/lib/team-lead"
      );
      const leadId = await makeEmployee("TLHelperLead");
      const m1 = await makeEmployee("TLHelperM1");
      const m2 = await makeEmployee("TLHelperM2");
      await patchUser(leadId, { isTeamLead: true });
      await patchUser(m1, { teamLeadId: leadId });
      await patchUser(m2, { teamLeadId: leadId });

      const count = await countActiveReports(leadId);
      expect(count).toBe(2);

      const memberIds = await getTeamMemberIds(leadId);
      expect(memberIds).toEqual(expect.arrayContaining([m1, m2]));
      expect(memberIds.length).toBe(2);
    });

    it("getTeamMemberIds liefert leeres Array wenn Lead nicht (mehr) Teamleiter ist", async () => {
      const { getTeamMemberIds } = await import("../server/lib/team-lead");
      const empId = await makeEmployee("TLHelperNonLead");
      const result = await getTeamMemberIds(empId);
      expect(result).toEqual([]);
    });
  });
});
