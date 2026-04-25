import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  apiPost,
  apiPatch,
  apiPostAs,
  apiPatchAs,
  apiGet,
  apiGetAs,
  loginAs,
  createTestEmployee,
  createTestCustomer,
  assignEmployeeToCustomer,
  deactivateTestEmployee,
  resetAuthCache,
  getAuthCookie,
} from "./test-utils";

/**
 * Task #201 — Teamleiter-Sichten (read-only).
 *
 * Drei Personas:
 *  - Admin (SuperAdmin): sieht alles.
 *  - Teamleiter: sieht eigene + zugeordnete Mitarbeiter und deren Kunden/Termine.
 *  - Regulär: sieht nur eigene.
 *
 * Geprüfte Sichten:
 *  - GET /api/customers
 *  - GET /api/customers/:id
 *  - GET /api/appointments?date=...
 *  - GET /api/appointments/counts
 *  - GET /api/appointments/undocumented
 *  - GET /api/appointments/:id
 *  - GET /api/team/weekly-availability
 *  - GET /api/team/members
 *
 * Schreibrechte sind ausdrücklich nicht Bestandteil (Task #202).
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
  appointmentLead: number;
  appointmentMember: number;
  appointmentOutsider: number;
  serviceId: number;
  testDate: string;
}

let setup: PersonaSetup;

function nextWeekday(daysFromNow: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function mondayOfWeek(date: Date): string {
  const d = new Date(date);
  const dow = d.getDay();
  const diff = dow === 0 ? -6 : 1 - dow;
  d.setDate(d.getDate() + diff);
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
  start: string
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

  const lead = await createTestEmployee({ nachnamePrefix: "TLS_Lead" });
  createdEmployeeIds.push(lead.id);
  const member = await createTestEmployee({ nachnamePrefix: "TLS_Member" });
  createdEmployeeIds.push(member.id);
  const outsider = await createTestEmployee({ nachnamePrefix: "TLS_Outsider" });
  createdEmployeeIds.push(outsider.id);

  await apiPatch(`/api/admin/users/${lead.id}`, { isTeamLead: true });
  await apiPatch(`/api/admin/users/${member.id}`, { teamLeadId: lead.id });

  const leadAuth = await loginAs(lead.email, lead.password);
  const memberAuth = await loginAs(member.email, member.password);
  const outsiderAuth = await loginAs(outsider.email, outsider.password);

  const cLead = await createTestCustomer({ nachname: `TLS_C_Lead_${Date.now()}` });
  const cMember = await createTestCustomer({ nachname: `TLS_C_Member_${Date.now()}` });
  const cOutsider = await createTestCustomer({ nachname: `TLS_C_Outsider_${Date.now()}` });
  createdCustomerIds.push(cLead.id, cMember.id, cOutsider.id);

  await assignEmployeeToCustomer(cLead.id, lead.id);
  await assignEmployeeToCustomer(cMember.id, member.id);
  await assignEmployeeToCustomer(cOutsider.id, outsider.id);

  const svcRes = await apiPost<any>("/api/services", {
    name: `tlsicht_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
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

  const testDate = nextWeekday(7);

  const aLead = await createApptForCustomer(cLead.id, lead.id, serviceId, testDate, "09:00");
  const aMember = await createApptForCustomer(cMember.id, member.id, serviceId, testDate, "10:00");
  const aOutsider = await createApptForCustomer(cOutsider.id, outsider.id, serviceId, testDate, "11:00");

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
    appointmentLead: aLead,
    appointmentMember: aMember,
    appointmentOutsider: aOutsider,
    serviceId,
    testDate,
  };
}, 120_000);

afterAll(async () => {
  for (const id of [...createdEmployeeIds].reverse()) {
    await deactivateTestEmployee(id).catch(() => {});
  }
  resetAuthCache();
});

describe("Task #201 – Teamleiter-Sichten", () => {
  describe("Auth-Flag: /api/auth/me liefert isTeamLead/teamLeadId", () => {
    it("Teamleiter: isTeamLead=true, teamLeadId=null", async () => {
      const res = await apiGetAs<any>(setup.leadAuth, "/api/auth/me");
      expect(res.status).toBe(200);
      expect(res.data.user.isTeamLead).toBe(true);
      expect(res.data.user.teamLeadId).toBeNull();
    });

    it("Mitglied: isTeamLead=false, teamLeadId=lead.id", async () => {
      const res = await apiGetAs<any>(setup.memberAuth, "/api/auth/me");
      expect(res.status).toBe(200);
      expect(res.data.user.isTeamLead).toBe(false);
      expect(res.data.user.teamLeadId).toBe(setup.lead.id);
    });

    it("Outsider: isTeamLead=false, teamLeadId=null", async () => {
      const res = await apiGetAs<any>(setup.outsiderAuth, "/api/auth/me");
      expect(res.status).toBe(200);
      expect(res.data.user.isTeamLead).toBe(false);
      expect(res.data.user.teamLeadId).toBeNull();
    });
  });

  describe("GET /api/customers", () => {
    it("Admin: sieht alle Test-Kunden", async () => {
      const res = await apiGetAs<any[]>(setup.adminAuth, "/api/customers");
      expect(res.status).toBe(200);
      const ids = res.data.map((c: any) => c.id);
      expect(ids).toEqual(expect.arrayContaining([setup.customerLead, setup.customerMember, setup.customerOutsider]));
    });

    it("Teamleiter: sieht eigene + Mitglieds-Kunden, NICHT Outsider", async () => {
      const res = await apiGetAs<any[]>(setup.leadAuth, "/api/customers");
      expect(res.status).toBe(200);
      const ids = res.data.map((c: any) => c.id);
      expect(ids).toEqual(expect.arrayContaining([setup.customerLead, setup.customerMember]));
      expect(ids).not.toContain(setup.customerOutsider);
    });

    it("Mitglied (regulär): sieht nur eigene Kunden", async () => {
      const res = await apiGetAs<any[]>(setup.memberAuth, "/api/customers");
      expect(res.status).toBe(200);
      const ids = res.data.map((c: any) => c.id);
      expect(ids).toContain(setup.customerMember);
      expect(ids).not.toContain(setup.customerLead);
      expect(ids).not.toContain(setup.customerOutsider);
    });

    it("Outsider: sieht nur eigene Kunden", async () => {
      const res = await apiGetAs<any[]>(setup.outsiderAuth, "/api/customers");
      expect(res.status).toBe(200);
      const ids = res.data.map((c: any) => c.id);
      expect(ids).toContain(setup.customerOutsider);
      expect(ids).not.toContain(setup.customerLead);
      expect(ids).not.toContain(setup.customerMember);
    });
  });

  describe("GET /api/customers/:id", () => {
    it("Teamleiter: darf Mitglieds-Kunde lesen", async () => {
      const res = await apiGetAs<any>(setup.leadAuth, `/api/customers/${setup.customerMember}`);
      expect(res.status).toBe(200);
      expect(res.data.id).toBe(setup.customerMember);
    });

    it("Teamleiter: darf NICHT Outsider-Kunde lesen", async () => {
      const res = await apiGetAs<any>(setup.leadAuth, `/api/customers/${setup.customerOutsider}`);
      expect(res.status).toBe(403);
    });

    it("Mitglied: darf NICHT Lead-Kunde lesen", async () => {
      const res = await apiGetAs<any>(setup.memberAuth, `/api/customers/${setup.customerLead}`);
      expect(res.status).toBe(403);
    });

    it("Outsider: darf NICHT Lead-Kunde lesen", async () => {
      const res = await apiGetAs<any>(setup.outsiderAuth, `/api/customers/${setup.customerLead}`);
      expect(res.status).toBe(403);
    });
  });

  describe("GET /api/appointments?date=...", () => {
    it("Admin: sieht alle drei Test-Termine am Tag", async () => {
      const res = await apiGetAs<any[]>(setup.adminAuth, `/api/appointments?date=${setup.testDate}`);
      expect(res.status).toBe(200);
      const ids = res.data.map((a: any) => a.id);
      expect(ids).toEqual(expect.arrayContaining([setup.appointmentLead, setup.appointmentMember, setup.appointmentOutsider]));
    });

    it("Teamleiter: sieht eigenen + Mitglied-Termin, NICHT Outsider", async () => {
      const res = await apiGetAs<any[]>(setup.leadAuth, `/api/appointments?date=${setup.testDate}`);
      expect(res.status).toBe(200);
      const ids = res.data.map((a: any) => a.id);
      expect(ids).toEqual(expect.arrayContaining([setup.appointmentLead, setup.appointmentMember]));
      expect(ids).not.toContain(setup.appointmentOutsider);
    });

    it("Mitglied (regulär): sieht nur eigenen Termin", async () => {
      const res = await apiGetAs<any[]>(setup.memberAuth, `/api/appointments?date=${setup.testDate}`);
      expect(res.status).toBe(200);
      const ids = res.data.map((a: any) => a.id);
      expect(ids).toContain(setup.appointmentMember);
      expect(ids).not.toContain(setup.appointmentLead);
      expect(ids).not.toContain(setup.appointmentOutsider);
    });

    it("Teamleiter mit ?customerId=... darf NICHT Outsider-Termin auf gemeinsamem Kunden sehen", async () => {
      // Outsider wird (zusätzlich) zu customerMember zugeordnet, sodass beide
      // Teams (Lead/Member und Outsider) auf demselben Kunden Termine haben.
      await assignEmployeeToCustomer(setup.customerMember, setup.outsider.id);
      const sharedDate = nextWeekday(8);
      const aOutsiderOnShared = await createApptForCustomer(
        setup.customerMember,
        setup.outsider.id,
        setup.serviceId,
        sharedDate,
        "12:00"
      );

      const res = await apiGetAs<any[]>(
        setup.leadAuth,
        `/api/appointments?date=${sharedDate}&customerId=${setup.customerMember}`
      );
      expect(res.status).toBe(200);
      const ids = res.data.map((a: any) => a.id);
      expect(ids).not.toContain(aOutsiderOnShared);
      // Sanity: assignedEmployeeId muss zu Lead oder zugeordnetem Mitglied gehören
      const allowed = new Set([setup.lead.id, setup.member.id]);
      for (const appt of res.data) {
        expect(allowed.has(appt.assignedEmployeeId)).toBe(true);
      }
    });
  });

  describe("GET /api/appointments/counts", () => {
    it("Teamleiter: counts enthalten Termine von Lead+Mitglied am Test-Tag (>=2)", async () => {
      const res = await apiGetAs<any>(
        setup.leadAuth,
        `/api/appointments/counts?dates=${setup.testDate}`
      );
      expect(res.status).toBe(200);
      const counts = res.data?.counts ?? res.data ?? {};
      const value = counts[setup.testDate] ?? 0;
      expect(value).toBeGreaterThanOrEqual(2);
    });

    it("Mitglied: counts enthalten nur eigenen Termin am Test-Tag (>=1)", async () => {
      const res = await apiGetAs<any>(
        setup.memberAuth,
        `/api/appointments/counts?dates=${setup.testDate}`
      );
      expect(res.status).toBe(200);
      const counts = res.data?.counts ?? res.data ?? {};
      const value = counts[setup.testDate] ?? 0;
      expect(value).toBeGreaterThanOrEqual(1);
    });
  });

  describe("GET /api/appointments/undocumented", () => {
    it("Teamleiter: sieht eigenen + Mitglieds-Termin als undocumented", async () => {
      const res = await apiGetAs<any>(setup.leadAuth, `/api/appointments/undocumented`);
      expect(res.status).toBe(200);
      const list = Array.isArray(res.data) ? res.data : (res.data?.appointments ?? []);
      const ids = list.map((a: any) => a.id);
      expect(ids).not.toContain(setup.appointmentOutsider);
    });

    it("Mitglied: sieht nur eigenen Termin als undocumented", async () => {
      const res = await apiGetAs<any>(setup.memberAuth, `/api/appointments/undocumented`);
      expect(res.status).toBe(200);
      const list = Array.isArray(res.data) ? res.data : (res.data?.appointments ?? []);
      const ids = list.map((a: any) => a.id);
      expect(ids).not.toContain(setup.appointmentLead);
      expect(ids).not.toContain(setup.appointmentOutsider);
    });
  });

  describe("GET /api/appointments/:id", () => {
    it("Teamleiter: darf Mitglied-Termin lesen", async () => {
      const res = await apiGetAs<any>(setup.leadAuth, `/api/appointments/${setup.appointmentMember}`);
      expect(res.status).toBe(200);
      expect(res.data.id).toBe(setup.appointmentMember);
    });

    it("Teamleiter: darf NICHT Outsider-Termin lesen", async () => {
      const res = await apiGetAs<any>(setup.leadAuth, `/api/appointments/${setup.appointmentOutsider}`);
      expect(res.status).toBe(403);
    });

    it("Mitglied: darf NICHT Lead-Termin lesen", async () => {
      const res = await apiGetAs<any>(setup.memberAuth, `/api/appointments/${setup.appointmentLead}`);
      expect(res.status).toBe(403);
    });
  });

  describe("GET /api/team/weekly-availability", () => {
    const startDate = mondayOfWeek(new Date(Date.now() + 7 * 24 * 3600 * 1000));

    it("Teamleiter: liefert eigene + Mitglied, NICHT Outsider", async () => {
      const res = await apiGetAs<any>(
        setup.leadAuth,
        `/api/team/weekly-availability?startDate=${startDate}&days=5`
      );
      expect(res.status).toBe(200);
      expect(Array.isArray(res.data.dates)).toBe(true);
      const ids = res.data.employees.map((e: any) => e.id);
      expect(ids).toEqual(expect.arrayContaining([setup.lead.id, setup.member.id]));
      expect(ids).not.toContain(setup.outsider.id);
    });

    it("Admin: enthält alle drei Test-Mitarbeiter", async () => {
      const res = await apiGetAs<any>(
        setup.adminAuth,
        `/api/team/weekly-availability?startDate=${startDate}&days=5`
      );
      expect(res.status).toBe(200);
      const ids = res.data.employees.map((e: any) => e.id);
      expect(ids).toEqual(expect.arrayContaining([setup.lead.id, setup.member.id, setup.outsider.id]));
    });

    it("Mitglied (regulär): bekommt 403", async () => {
      const res = await apiGetAs<any>(
        setup.memberAuth,
        `/api/team/weekly-availability?startDate=${startDate}&days=5`
      );
      expect(res.status).toBe(403);
    });

    it("Outsider (regulär): bekommt 403", async () => {
      const res = await apiGetAs<any>(
        setup.outsiderAuth,
        `/api/team/weekly-availability?startDate=${startDate}&days=5`
      );
      expect(res.status).toBe(403);
    });

    it("Teamleiter: ungültiges startDate → 400", async () => {
      const res = await apiGetAs<any>(
        setup.leadAuth,
        `/api/team/weekly-availability?startDate=2025-13-40&days=5`
      );
      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/team/members", () => {
    it("Teamleiter: liefert eigene + Mitglied", async () => {
      const res = await apiGetAs<any>(setup.leadAuth, `/api/team/members`);
      expect(res.status).toBe(200);
      const ids = res.data.members.map((m: any) => m.id);
      expect(ids).toEqual(expect.arrayContaining([setup.lead.id, setup.member.id]));
      expect(ids).not.toContain(setup.outsider.id);
      expect(res.data.leadId).toBe(setup.lead.id);
    });

    it("Mitglied (regulär): bekommt 403", async () => {
      const res = await apiGetAs<any>(setup.memberAuth, `/api/team/members`);
      expect(res.status).toBe(403);
    });
  });

  /**
   * Task #201 ist explizit read-only. Schreibrechte für Teamleiter auf
   * Mitarbeiter-Kunden (Stammdaten, Pflegegrad, Vertrag, Unterschriften,
   * Kontakte, Dokumente) gehören zu Task #202 und sind hier negativ
   * abgesichert.
   */
  describe("Task #202 territory: Teamleiter darf Mitglied-Kunde NICHT schreiben", () => {
    it("PATCH /api/customers/:id (Stammdaten) → 403", async () => {
      const res = await apiPatchAs(setup.leadAuth, `/api/customers/${setup.customerMember}`, {
        telefon: "+49 30 12345678",
      });
      expect(res.status).toBe(403);
    });

    it("POST /api/customers/:id/care-level → 403", async () => {
      const res = await apiPostAs(setup.leadAuth, `/api/customers/${setup.customerMember}/care-level`, {
        pflegegrad: 3,
        validFrom: setup.testDate,
      });
      expect(res.status).toBe(403);
    });

    it("PATCH /api/customers/:id/contract → 403", async () => {
      const res = await apiPatchAs(setup.leadAuth, `/api/customers/${setup.customerMember}/contract`, {
        contractStart: setup.testDate,
      });
      expect(res.status).toBe(403);
    });

    it("POST /api/customers/:id/contacts → 403", async () => {
      const res = await apiPostAs(setup.leadAuth, `/api/customers/${setup.customerMember}/contacts`, {
        vorname: "Max",
        nachname: "Mustermann",
        contactType: "notfallkontakt",
      });
      expect(res.status).toBe(403);
    });

    it("POST /api/customers/:id/signatures → 403", async () => {
      const res = await apiPostAs(setup.leadAuth, `/api/customers/${setup.customerMember}/signatures`, {
        signatures: [{ templateSlug: "betreuungsvertrag", customerSignatureData: "data:image/png;base64,iVBOR" }],
      });
      expect(res.status).toBe(403);
    });

    it("POST /api/customers/:id/documents → 403", async () => {
      const res = await apiPostAs(setup.leadAuth, `/api/customers/${setup.customerMember}/documents`, {
        documentTypeId: 1,
        objectPath: "/dummy",
      });
      expect(res.status).toBe(403);
    });
  });
});
