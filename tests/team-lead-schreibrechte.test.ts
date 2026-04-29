import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, desc } from "drizzle-orm";
import { db } from "../server/lib/db";
import { customerAssignmentHistory } from "../shared/schema/customers";
import { appointments } from "../shared/schema/appointments";
import {
  apiPost,
  apiPatch,
  apiPostAs,
  apiPatchAs,
  apiGetAs,
  apiDeleteAs,
  loginAs,
  createTestEmployee,
  createTestCustomer,
  assignEmployeeToCustomer,
  deactivateTestEmployee,
  resetAuthCache,
  getAuthCookie,
} from "./test-utils";

/**
 * Task #202 — Teamleiter-Schreibrechte.
 *
 * Erlaubte Aktionen für Teamleiter:
 *  - Termine umhängen (firmenweit reassign mit Konflikt-Check).
 *  - Termine im Namen von Team-Mitarbeitern anlegen (Auswahl auf Team begrenzt).
 *  - Kunden-Zuordnungen (primary/backup/backup2) ändern für Team-Kunden.
 *
 * Audit-Log enthält metadata.actor.role = "teamLead".
 *
 * Stundenübersicht / Monatsabschluss / Massen-Reassign sind explizit out of scope.
 */

const createdEmployeeIds: number[] = [];
const createdCustomerIds: number[] = [];

interface PersonaSetup {
  adminAuth: Awaited<ReturnType<typeof getAuthCookie>>;
  lead: { id: number; email: string; password: string };
  leadAuth: Awaited<ReturnType<typeof loginAs>>;
  member: { id: number; email: string; password: string };
  memberAuth: Awaited<ReturnType<typeof loginAs>>;
  outsider: { id: number; email: string; password: string };
  outsiderAuth: Awaited<ReturnType<typeof loginAs>>;
  customerLead: number;
  customerMember: number;
  customerOutsider: number;
  serviceId: number;
}

let setup: PersonaSetup;

function nextWeekday(daysFromNow: number): string {
  // Zähle daysFromNow tatsächliche Werktage ab heute hoch, damit
  // unterschiedliche Indizes nie auf denselben Tag kollabieren (sonst
  // Slot-Kollisionen z.B. zwischen nextWeekday(24) und nextWeekday(25),
  // wenn ein Wochenende dazwischenliegt).
  const d = new Date();
  let added = 0;
  while (added < daysFromNow) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0 && d.getDay() !== 6) added += 1;
  }
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function createApptForCustomer(
  customerId: number,
  employeeId: number,
  serviceId: number,
  date: string,
  start: string,
): Promise<number> {
  const res = await apiPost<any>("/api/appointments/kundentermin", {
    customerId,
    date,
    scheduledStart: start,
    services: [{ serviceId, durationMinutes: 60 }],
    assignedEmployeeId: employeeId,
  });
  if (res.status !== 201) {
    throw new Error(`createAppt failed: ${res.status} ${JSON.stringify(res.data)}`);
  }
  return res.data.id;
}

beforeAll(async () => {
  const adminAuth = await getAuthCookie();

  const lead = await createTestEmployee({ nachnamePrefix: "TLW_Lead" });
  createdEmployeeIds.push(lead.id);
  const member = await createTestEmployee({ nachnamePrefix: "TLW_Member" });
  createdEmployeeIds.push(member.id);
  const outsider = await createTestEmployee({ nachnamePrefix: "TLW_Outsider" });
  createdEmployeeIds.push(outsider.id);

  await apiPatch(`/api/admin/users/${lead.id}`, { isTeamLead: true });
  await apiPatch(`/api/admin/users/${member.id}`, { teamLeadId: lead.id });

  const leadAuth = await loginAs(lead.email, lead.password);
  const memberAuth = await loginAs(member.email, member.password);
  const outsiderAuth = await loginAs(outsider.email, outsider.password);

  const cLead = await createTestCustomer({ nachname: `TLW_C_Lead_${Date.now()}` });
  const cMember = await createTestCustomer({ nachname: `TLW_C_Member_${Date.now()}` });
  const cOutsider = await createTestCustomer({ nachname: `TLW_C_Outsider_${Date.now()}` });
  createdCustomerIds.push(cLead.id, cMember.id, cOutsider.id);

  await assignEmployeeToCustomer(cLead.id, lead.id);
  await assignEmployeeToCustomer(cMember.id, member.id);
  await assignEmployeeToCustomer(cOutsider.id, outsider.id);

  const svcRes = await apiPost<any>("/api/services", {
    name: `tlwrite_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
    category: "betreuung",
    defaultPriceCents: 3500,
    unitType: "hours",
    durationMinutes: 60,
    isActive: true,
  });
  if (svcRes.status !== 201 && svcRes.status !== 200) {
    throw new Error(`service create failed: ${svcRes.status} ${JSON.stringify(svcRes.data)}`);
  }
  const serviceId = svcRes.data.id;

  setup = {
    adminAuth,
    lead,
    leadAuth,
    member,
    memberAuth,
    outsider,
    outsiderAuth,
    customerLead: cLead.id,
    customerMember: cMember.id,
    customerOutsider: cOutsider.id,
    serviceId,
  };
}, 120_000);

afterAll(async () => {
  for (const id of [...createdEmployeeIds].reverse()) {
    await deactivateTestEmployee(id).catch(() => {});
  }
  resetAuthCache();
});

describe("Task #202 – Teamleiter-Schreibrechte", () => {
  describe("PATCH /api/appointments/:id (Reassign)", () => {
    it("Happy: Teamleiter hängt Member-Termin auf sich um → 200, Audit actor.role=teamLead", async () => {
      const date = nextWeekday(14);
      const apptId = await createApptForCustomer(setup.customerMember, setup.member.id, setup.serviceId, date, "09:00");

      // Lead muss dem Kunden zugeordnet sein, damit der Termin laufen darf.
      // (Konflikt-/Customer-Checks im PATCH prüfen das nicht — nur Overlap.)
      const res = await apiPatchAs<any>(setup.leadAuth, `/api/appointments/${apptId}`, {
        assignedEmployeeId: setup.lead.id,
      });
      expect(res.status).toBe(200);
      expect(res.data.assignedEmployeeId).toBe(setup.lead.id);

      const audit = await apiGetAs<any>(
        setup.adminAuth,
        `/api/admin/audit-log?entityType=appointment&entityId=${apptId}&action=appointment_updated`,
      );
      expect(audit.status).toBe(200);
      const entry = (audit.data.entries || []).find((e: any) => e.userId === setup.lead.id);
      expect(entry).toBeDefined();
      expect(entry.metadata?.actor?.role).toBe("teamLead");
    });

    it("Conflict: Teamleiter Reassign auf MA mit Überlappung → 409 mit MA-Name + Zeitraum", async () => {
      const date = nextWeekday(15);
      // Lead hat 10:00–11:00 Termin auf customerLead.
      await createApptForCustomer(setup.customerLead, setup.lead.id, setup.serviceId, date, "10:00");
      // Member hat 10:00–11:00 Termin auf customerMember.
      const memberAppt = await createApptForCustomer(setup.customerMember, setup.member.id, setup.serviceId, date, "10:00");

      // Lead versucht Member-Termin auf sich umzuhängen → kollidiert mit eigenem Termin.
      const res = await apiPatchAs<any>(setup.leadAuth, `/api/appointments/${memberAppt}`, {
        assignedEmployeeId: setup.lead.id,
      });
      expect(res.status).toBe(409);
      // Spezifischer Message: Mitarbeitername + blockierter Zeitraum, ohne Termin-Details des Konflikts.
      const msg: string = res.data?.message || "";
      expect(msg).toMatch(/10:00.*11:00/);
      expect(msg.toLowerCase()).toContain("bereits");
      // Keine fremden Kunden- oder Termin-IDs in der Antwort.
      expect(msg).not.toContain(String(setup.customerLead));
      expect(msg).not.toMatch(/customerId|appointmentId/i);
    });

    it("Forbidden: Teamleiter darf Outsider-Termin NICHT umhängen → 403", async () => {
      const date = nextWeekday(16);
      const outsiderAppt = await createApptForCustomer(setup.customerOutsider, setup.outsider.id, setup.serviceId, date, "09:00");

      const res = await apiPatchAs<any>(setup.leadAuth, `/api/appointments/${outsiderAppt}`, {
        assignedEmployeeId: setup.lead.id,
      });
      expect(res.status).toBe(403);
    });

    it("Forbidden: regulärer Mitarbeiter darf fremden Termin NICHT umhängen → 403", async () => {
      const date = nextWeekday(17);
      const leadAppt = await createApptForCustomer(setup.customerLead, setup.lead.id, setup.serviceId, date, "09:00");

      const res = await apiPatchAs<any>(setup.memberAuth, `/api/appointments/${leadAppt}`, {
        assignedEmployeeId: setup.member.id,
      });
      expect(res.status).toBe(403);
    });
  });

  describe("POST /api/appointments/kundentermin (Anlage im Namen von Team-Mitarbeiter)", () => {
    it("Happy: Teamleiter legt Termin im Namen von Member an → 201, Audit actor.role=teamLead", async () => {
      const date = nextWeekday(18);
      const res = await apiPostAs<any>(setup.leadAuth, "/api/appointments/kundentermin", {
        customerId: setup.customerMember,
        date,
        scheduledStart: "09:00",
        services: [{ serviceId: setup.serviceId, durationMinutes: 60 }],
        assignedEmployeeId: setup.member.id,
      });
      expect(res.status).toBe(201);
      expect(res.data.assignedEmployeeId).toBe(setup.member.id);

      // Audit-Eintrag für Termin-Anlage muss actor.role=teamLead enthalten,
      // damit Team-Lead-Schreibaktionen im Audit-Log unterscheidbar bleiben.
      const audit = await apiGetAs<any>(
        setup.adminAuth,
        `/api/admin/audit-log?entityType=appointment&entityId=${res.data.id}&action=appointment_created`,
      );
      expect(audit.status).toBe(200);
      const entry = (audit.data.entries || []).find((e: any) => e.userId === setup.lead.id);
      expect(entry).toBeDefined();
      expect(entry.metadata?.actor?.role).toBe("teamLead");
    });

    it("Forbidden: Teamleiter darf NICHT im Namen von Outsider anlegen → 403", async () => {
      const date = nextWeekday(19);
      const res = await apiPostAs<any>(setup.leadAuth, "/api/appointments/kundentermin", {
        customerId: setup.customerOutsider,
        date,
        scheduledStart: "09:00",
        services: [{ serviceId: setup.serviceId, durationMinutes: 60 }],
        assignedEmployeeId: setup.outsider.id,
      });
      expect(res.status).toBe(403);
    });

    it("Forbidden: regulärer Mitarbeiter darf NICHT im Namen anderer anlegen → 403 (NOT_ASSIGNED auf Outsider-Customer)", async () => {
      const date = nextWeekday(20);
      const res = await apiPostAs<any>(setup.memberAuth, "/api/appointments/kundentermin", {
        customerId: setup.customerOutsider,
        date,
        scheduledStart: "09:00",
        services: [{ serviceId: setup.serviceId, durationMinutes: 60 }],
        assignedEmployeeId: setup.outsider.id,
      });
      expect(res.status).toBe(403);
    });
  });

  describe("Regression: Teamleiter-Schreibrechte beschränken sich auf Reassign", () => {
    it("Forbidden: Teamleiter darf Member-Termin NICHT starten (POST /:id/start) → 403", async () => {
      const date = nextWeekday(21);
      const apptId = await createApptForCustomer(setup.customerMember, setup.member.id, setup.serviceId, date, "09:00");
      const res = await apiPostAs<any>(setup.leadAuth, `/api/appointments/${apptId}/start`, {});
      expect(res.status).toBe(403);
    });

    it("Forbidden: Teamleiter darf Member-Termin NICHT beenden (POST /:id/end) → 403 ACCESS_DENIED", async () => {
      const date = nextWeekday(24);
      const apptId = await createApptForCustomer(setup.customerMember, setup.member.id, setup.serviceId, date, "09:00");
      // Termin in den für /end gültigen Zustand bringen, damit ein 403 nicht
      // versehentlich aus dem Status-Check (INVALID_STATUS) kommt.
      await db
        .update(appointments)
        .set({ status: "in-progress", actualStart: "09:00:00" })
        .where(eq(appointments.id, apptId));
      const res = await apiPostAs<any>(setup.leadAuth, `/api/appointments/${apptId}/end`, {});
      expect(res.status).toBe(403);
      // Sicherstellen, dass die Ablehnung aus dem Access-Check stammt, nicht
      // aus dem späteren Status-Check (INVALID_STATUS).
      expect(res.data?.error).toBe("ACCESS_DENIED");
    });

    it("Forbidden: Teamleiter darf Member-Termin NICHT wieder öffnen (POST /:id/reopen) → 403 ACCESS_DENIED", async () => {
      const date = nextWeekday(25);
      const apptId = await createApptForCustomer(setup.customerMember, setup.member.id, setup.serviceId, date, "09:00");
      // Termin in den für /reopen gültigen Zustand bringen, damit ein 403 nicht
      // versehentlich aus dem Status-Check (INVALID_STATUS) kommt.
      await db
        .update(appointments)
        .set({ status: "completed", actualStart: "09:00:00", actualEnd: "10:00:00" })
        .where(eq(appointments.id, apptId));
      const res = await apiPostAs<any>(setup.leadAuth, `/api/appointments/${apptId}/reopen`, {});
      expect(res.status).toBe(403);
      // Sicherstellen, dass die Ablehnung aus dem Access-Check stammt, nicht
      // aus dem späteren Status-Check (INVALID_STATUS).
      expect(res.data?.error).toBe("ACCESS_DENIED");
    });

    it("Happy: Teamleiter darf Member-Termin löschen, solange nicht gestartet → 200, Audit actor.role=teamLead", async () => {
      const date = nextWeekday(28);
      const apptId = await createApptForCustomer(setup.customerMember, setup.member.id, setup.serviceId, date, "09:00");
      const delRes = await apiDeleteAs(setup.leadAuth, `/api/appointments/${apptId}`);
      expect(delRes.status).toBe(200);

      const audit = await apiGetAs<any>(
        setup.adminAuth,
        `/api/admin/audit-log?entityType=appointment&entityId=${apptId}&action=appointment_deleted`,
      );
      expect(audit.status).toBe(200);
      const entry = (audit.data.entries || []).find((e: any) => e.userId === setup.lead.id);
      expect(entry).toBeDefined();
      expect(entry.metadata?.actor?.role).toBe("teamLead");
    });

    it("Forbidden: Teamleiter darf bereits gestarteten Member-Termin NICHT löschen → 403 APPOINTMENT_STARTED", async () => {
      const date = nextWeekday(29);
      const apptId = await createApptForCustomer(setup.customerMember, setup.member.id, setup.serviceId, date, "09:00");
      // Termin „starten": actualStart und Status auf in_progress setzen.
      await db
        .update(appointments)
        .set({ status: "in_progress", actualStart: "09:00:00" })
        .where(eq(appointments.id, apptId));
      const delRes = await apiDeleteAs(setup.leadAuth, `/api/appointments/${apptId}`);
      expect(delRes.status).toBe(403);
      expect((delRes.data as any)?.error).toBe("APPOINTMENT_STARTED");
    });

    it("Forbidden: Teamleiter darf Outsider-Termin NICHT löschen → 403 ACCESS_DENIED", async () => {
      const date = nextWeekday(30);
      const apptId = await createApptForCustomer(setup.customerOutsider, setup.outsider.id, setup.serviceId, date, "09:00");
      const delRes = await apiDeleteAs(setup.leadAuth, `/api/appointments/${apptId}`);
      expect(delRes.status).toBe(403);
      expect((delRes.data as any)?.error).toBe("ACCESS_DENIED");
    });

    it("Forbidden: regulärer Mitarbeiter darf fremden Termin NICHT löschen → 403", async () => {
      const date = nextWeekday(31);
      const apptId = await createApptForCustomer(setup.customerMember, setup.member.id, setup.serviceId, date, "09:00");
      const delRes = await apiDeleteAs(setup.outsiderAuth, `/api/appointments/${apptId}`);
      expect(delRes.status).toBe(403);
    });
  });

  describe("PATCH /api/customers/:id/assignment (Kunden-Zuordnung)", () => {
    it("Happy: Teamleiter ändert Zuordnung für Team-Kunden → 200, Audit actor.role=teamLead", async () => {
      // Member-Customer: Lead fügt sich selbst als backup hinzu.
      const res = await apiPatchAs<any>(setup.leadAuth, `/api/customers/${setup.customerMember}/assignment`, {
        primaryEmployeeId: setup.member.id,
        backupEmployeeId: setup.lead.id,
        backupEmployeeId2: null,
      });
      expect(res.status).toBe(200);
      expect(res.data.backupEmployeeId).toBe(setup.lead.id);

      const audit = await apiGetAs<any>(
        setup.adminAuth,
        `/api/admin/audit-log?entityType=customer&entityId=${setup.customerMember}&action=customer_updated`,
      );
      expect(audit.status).toBe(200);
      const entry = (audit.data.entries || []).find((e: any) => e.userId === setup.lead.id);
      expect(entry).toBeDefined();
      expect(entry.metadata?.actor?.role).toBe("teamLead");
      expect(entry.metadata?.changedFields).toContain("backupEmployeeId");

      // DB-Persistenz: changedByRole im History-Eintrag
      const histRows = await db
        .select()
        .from(customerAssignmentHistory)
        .where(eq(customerAssignmentHistory.customerId, setup.customerMember))
        .orderBy(desc(customerAssignmentHistory.id))
        .limit(3);
      const leadEntry = histRows.find(
        (r) => r.changedByUserId === setup.lead.id && r.changedByRole === "teamLead",
      );
      expect(leadEntry).toBeDefined();
    });

    it("Forbidden: Teamleiter darf Outsider-Kunden NICHT ändern → 403", async () => {
      const res = await apiPatchAs<any>(setup.leadAuth, `/api/customers/${setup.customerOutsider}/assignment`, {
        primaryEmployeeId: setup.lead.id,
        backupEmployeeId: null,
        backupEmployeeId2: null,
      });
      expect(res.status).toBe(403);
    });

    it("Forbidden: regulärer Mitarbeiter darf Zuordnungen NICHT ändern → 403", async () => {
      const res = await apiPatchAs<any>(setup.memberAuth, `/api/customers/${setup.customerMember}/assignment`, {
        primaryEmployeeId: setup.outsider.id,
        backupEmployeeId: null,
        backupEmployeeId2: null,
      });
      expect(res.status).toBe(403);
    });

    it("Validation: doppelte Mitarbeiter-IDs → 400", async () => {
      const res = await apiPatchAs<any>(setup.leadAuth, `/api/customers/${setup.customerMember}/assignment`, {
        primaryEmployeeId: setup.lead.id,
        backupEmployeeId: setup.lead.id,
        backupEmployeeId2: null,
      });
      expect(res.status).toBe(400);
    });
  });
});
