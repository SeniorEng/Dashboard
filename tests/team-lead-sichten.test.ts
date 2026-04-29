import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  apiPost,
  apiPatch,
  apiGetAs,
  loginAs,
  createTestEmployee,
  createTestCustomer,
  deactivateTestEmployee,
  resetAuthCache,
  getAuthCookie,
} from "./test-utils";

/**
 * Task #252 — Sichten der Teamleitung (flacher Marker).
 *
 * Konzept: Teamleiter erhalten die Admin-Sicht firmenweit (mit Mitarbeiter-Toggle),
 * besitzen aber keine Hierarchie. Reguläre Mitarbeiter sehen ausschließlich
 * eigene Daten. Die alten /api/team/*-Endpunkte existieren nicht mehr.
 */

const createdEmployeeIds: number[] = [];
const createdCustomerIds: number[] = [];

interface PersonaSetup {
  adminAuth: Awaited<ReturnType<typeof getAuthCookie>>;
  lead: { id: number; email: string; password: string };
  leadAuth: Awaited<ReturnType<typeof loginAs>>;
  employeeA: { id: number; email: string; password: string };
  employeeAAuth: Awaited<ReturnType<typeof loginAs>>;
  employeeB: { id: number; email: string; password: string };
  customerA: number;
  customerB: number;
  serviceId: number;
  testDate: string;
  appointmentA: number;
  appointmentB: number;
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

async function createAppt(
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

  const lead = await createTestEmployee({ nachnamePrefix: "TL252_Lead" });
  createdEmployeeIds.push(lead.id);
  const employeeA = await createTestEmployee({ nachnamePrefix: "TL252_EmpA" });
  createdEmployeeIds.push(employeeA.id);
  const employeeB = await createTestEmployee({ nachnamePrefix: "TL252_EmpB" });
  createdEmployeeIds.push(employeeB.id);

  await apiPatch(`/api/admin/users/${lead.id}`, { isTeamLead: true });

  const leadAuth = await loginAs(lead.email, lead.password);
  const employeeAAuth = await loginAs(employeeA.email, employeeA.password);

  const customerARaw = await createTestCustomer({ nachname: `TL252_CA_${Date.now()}` });
  const customerBRaw = await createTestCustomer({ nachname: `TL252_CB_${Date.now()}` });
  const customerA = customerARaw.id;
  const customerB = customerBRaw.id;
  createdCustomerIds.push(customerA, customerB);

  await apiPatch(`/api/admin/customers/${customerA}/assign`, {
    primaryEmployeeId: employeeA.id,
    backupEmployeeId: null,
    backupEmployeeId2: null,
  });
  await apiPatch(`/api/admin/customers/${customerB}/assign`, {
    primaryEmployeeId: employeeB.id,
    backupEmployeeId: null,
    backupEmployeeId2: null,
  });

  const services = await apiGetAs<any[]>(adminAuth, "/api/services");
  if (services.status !== 200 || !Array.isArray(services.data) || services.data.length === 0) {
    throw new Error("Keine Leistungen verfügbar — bitte Stammdaten initialisieren");
  }
  const serviceId = services.data[0].id;

  const testDate = nextWeekday(2);
  const appointmentA = await createAppt(customerA, employeeA.id, serviceId, testDate, "09:00");
  const appointmentB = await createAppt(customerB, employeeB.id, serviceId, testDate, "11:00");

  setup = {
    adminAuth,
    lead,
    leadAuth,
    employeeA,
    employeeAAuth,
    employeeB,
    customerA,
    customerB,
    serviceId,
    testDate,
    appointmentA,
    appointmentB,
  };
});

afterAll(async () => {
  for (const id of [...createdEmployeeIds].reverse()) {
    await deactivateTestEmployee(id).catch(() => {});
  }
  resetAuthCache();
});

describe("Task #252 – Teamleitung Sichten (Admin-Sicht firmenweit)", () => {
  describe("GET /api/customers", () => {
    it("Teamleiter sieht firmenweit alle Kunden", async () => {
      const res = await apiGetAs<any[]>(setup.leadAuth, "/api/customers");
      expect(res.status).toBe(200);
      const ids = res.data.map((c: any) => c.id);
      expect(ids).toContain(setup.customerA);
      expect(ids).toContain(setup.customerB);
    });

    it("regulärer Mitarbeiter sieht nur eigene Kunden", async () => {
      const res = await apiGetAs<any[]>(setup.employeeAAuth, "/api/customers");
      expect(res.status).toBe(200);
      const ids = res.data.map((c: any) => c.id);
      expect(ids).toContain(setup.customerA);
      expect(ids).not.toContain(setup.customerB);
    });
  });

  describe("GET /api/appointments?date=...", () => {
    it("Teamleiter sieht firmenweit alle Termine des Tages", async () => {
      const res = await apiGetAs<any[]>(
        setup.leadAuth,
        `/api/appointments?date=${setup.testDate}`,
      );
      expect(res.status).toBe(200);
      const ids = res.data.map((a: any) => a.id);
      expect(ids).toContain(setup.appointmentA);
      expect(ids).toContain(setup.appointmentB);
    });

    it("regulärer Mitarbeiter sieht nur eigene Termine", async () => {
      const res = await apiGetAs<any[]>(
        setup.employeeAAuth,
        `/api/appointments?date=${setup.testDate}`,
      );
      expect(res.status).toBe(200);
      const ids = res.data.map((a: any) => a.id);
      expect(ids).toContain(setup.appointmentA);
      expect(ids).not.toContain(setup.appointmentB);
    });
  });

  describe("GET /api/customers/:id (Detail) — Admin-Sicht firmenweit", () => {
    it("Teamleiter darf Kunden-Detail eines fremd zugeordneten Kunden lesen", async () => {
      const res = await apiGetAs<any>(setup.leadAuth, `/api/customers/${setup.customerB}`);
      expect(res.status).toBe(200);
      expect(res.data.id).toBe(setup.customerB);
    });

    it("Teamleiter darf Kunden-Details (Stammdaten + Termine) für fremde Kunden öffnen", async () => {
      const res = await apiGetAs<any>(setup.leadAuth, `/api/customers/${setup.customerB}/details`);
      expect(res.status).toBe(200);
    });

    it("regulärer Mitarbeiter darf fremdes Kunden-Detail nicht lesen", async () => {
      const res = await apiGetAs<any>(setup.employeeAAuth, `/api/customers/${setup.customerB}`);
      expect(res.status).toBe(403);
    });
  });

  describe("GET /api/appointments/:id (Detail)", () => {
    it("Teamleiter darf Termin eines beliebigen Mitarbeiters einsehen", async () => {
      const res = await apiGetAs<any>(setup.leadAuth, `/api/appointments/${setup.appointmentB}`);
      expect(res.status).toBe(200);
      expect(res.data.id).toBe(setup.appointmentB);
    });

    it("regulärer Mitarbeiter darf fremde Termine nicht einsehen", async () => {
      const res = await apiGetAs<any>(
        setup.employeeAAuth,
        `/api/appointments/${setup.appointmentB}`,
      );
      expect(res.status).toBe(403);
    });
  });

  describe("Entfernte /api/team-Routen", () => {
    it("/api/team/members liefert keine Mitglieder-Liste mehr", async () => {
      const res = await apiGetAs<any>(setup.leadAuth, "/api/team/members");
      const isJsonResponse = !!(res.data && typeof res.data === "object" && "members" in (res.data as object));
      expect(isJsonResponse).toBe(false);
    });

    it("/api/team/weekly-availability liefert keine Verfügbarkeitsdaten mehr", async () => {
      const res = await apiGetAs<any>(
        setup.leadAuth,
        `/api/team/weekly-availability?startDate=${setup.testDate}&days=5`,
      );
      const isJsonResponse = !!(
        res.data && typeof res.data === "object" && ("days" in (res.data as object) || "members" in (res.data as object))
      );
      expect(isJsonResponse).toBe(false);
    });
  });
});
