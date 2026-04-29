import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  apiPost,
  apiPatch,
  apiGet,
  apiPostAs,
  apiPatchAs,
  apiDeleteAs,
  apiGetAs,
  loginAs,
  createTestEmployee,
  createTestCustomer,
  deactivateTestEmployee,
  resetAuthCache,
  getAuthCookie,
} from "./test-utils";

/**
 * Task #252 — Schreibrechte der Teamleitung (flacher Marker, firmenweit).
 *
 * Konzept:
 *  - Teamleiter dürfen firmenweit Termine anlegen, jedem aktiven Mitarbeiter
 *    zuordnen, umplanen und löschen.
 *  - Bereits gestartete Termine bleiben für Teamleiter gesperrt.
 *  - Teamleiter dürfen Mitarbeiter-Kunden-Zuordnungen firmenweit ändern.
 *  - Kaufmännische Bereiche bleiben Admin-only.
 *  - Reguläre Mitarbeiter dürfen weiterhin nur eigene Termine bearbeiten und
 *    keine Kunden-Zuordnungen ändern.
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

beforeAll(async () => {
  const adminAuth = await getAuthCookie();

  const lead = await createTestEmployee({ nachnamePrefix: "TLS252_Lead" });
  createdEmployeeIds.push(lead.id);
  const employeeA = await createTestEmployee({ nachnamePrefix: "TLS252_EmpA" });
  createdEmployeeIds.push(employeeA.id);
  const employeeB = await createTestEmployee({ nachnamePrefix: "TLS252_EmpB" });
  createdEmployeeIds.push(employeeB.id);

  await apiPatch(`/api/admin/users/${lead.id}`, { isTeamLead: true });

  const leadAuth = await loginAs(lead.email, lead.password);
  const employeeAAuth = await loginAs(employeeA.email, employeeA.password);

  const customerARaw = await createTestCustomer({ nachname: `TLS252_CA_${Date.now()}` });
  const customerBRaw = await createTestCustomer({ nachname: `TLS252_CB_${Date.now()}` });
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

  const services = await apiGet<any[]>("/api/services");
  if (services.status !== 200 || !Array.isArray(services.data) || services.data.length === 0) {
    throw new Error("Keine Leistungen verfügbar — bitte Stammdaten initialisieren");
  }
  const serviceId = services.data[0].id;

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
    testDate: nextWeekday(2),
  };
});

afterAll(async () => {
  for (const id of [...createdEmployeeIds].reverse()) {
    await deactivateTestEmployee(id).catch(() => {});
  }
  resetAuthCache();
});

describe("Task #252 – Teamleitung Schreibrechte (firmenweit)", () => {
  describe("Termine anlegen", () => {
    it("Teamleiter darf Termin für Mitarbeiter eines fremden Kunden anlegen", async () => {
      const res = await apiPostAs<any>(setup.leadAuth, "/api/appointments/kundentermin", {
        customerId: setup.customerB,
        date: setup.testDate,
        scheduledStart: "08:00",
        services: [{ serviceId: setup.serviceId, durationMinutes: 60 }],
        assignedEmployeeId: setup.employeeB.id,
      });
      expect(res.status).toBe(201);
      expect(res.data.assignedEmployeeId).toBe(setup.employeeB.id);
    });

    it("Teamleiter erhält Validierungsfehler, wenn Mitarbeiter dem Kunden nicht zugeordnet ist", async () => {
      const res = await apiPostAs<any>(setup.leadAuth, "/api/appointments/kundentermin", {
        customerId: setup.customerB,
        date: setup.testDate,
        scheduledStart: "10:00",
        services: [{ serviceId: setup.serviceId, durationMinutes: 60 }],
        assignedEmployeeId: setup.employeeA.id,
      });
      expect(res.status).toBe(400);
      expect(String(res.data?.message ?? "")).toMatch(/zugeordnet/i);
    });

    it("regulärer Mitarbeiter darf keinen Termin für anderen Mitarbeiter anlegen", async () => {
      const res = await apiPostAs<any>(setup.employeeAAuth, "/api/appointments/kundentermin", {
        customerId: setup.customerB,
        date: setup.testDate,
        scheduledStart: "12:00",
        services: [{ serviceId: setup.serviceId, durationMinutes: 60 }],
        assignedEmployeeId: setup.employeeB.id,
      });
      expect([403, 404]).toContain(res.status);
    });
  });

  describe("Termine löschen", () => {
    it("Teamleiter darf Termin eines anderen Mitarbeiters löschen, wenn er noch nicht gestartet wurde", async () => {
      const created = await apiPost<any>("/api/appointments/kundentermin", {
        customerId: setup.customerB,
        date: setup.testDate,
        scheduledStart: "13:00",
        services: [{ serviceId: setup.serviceId, durationMinutes: 60 }],
        assignedEmployeeId: setup.employeeB.id,
      });
      expect(created.status).toBe(201);
      const apptId = created.data.id;

      const del = await apiDeleteAs(setup.leadAuth, `/api/appointments/${apptId}`);
      expect([200, 204]).toContain(del.status);
    });

    it("Teamleiter darf bereits gestartete Termine nicht löschen", async () => {
      const created = await apiPost<any>("/api/appointments/kundentermin", {
        customerId: setup.customerB,
        date: setup.testDate,
        scheduledStart: "14:00",
        services: [{ serviceId: setup.serviceId, durationMinutes: 60 }],
        assignedEmployeeId: setup.employeeB.id,
      });
      expect(created.status).toBe(201);
      const apptId = created.data.id;

      const start = await apiPost<any>(`/api/appointments/${apptId}/start`, {});
      expect(start.status).toBe(200);

      const del = await apiDeleteAs(setup.leadAuth, `/api/appointments/${apptId}`);
      expect(del.status).toBe(403);
      expect(String((del.data as any)?.error ?? "")).toMatch(/APPOINTMENT_STARTED|LOCKED/);
    });
  });

  describe("Kunden-Zuordnung firmenweit ändern", () => {
    it("Teamleiter darf Mitarbeiter-Zuordnung für beliebigen Kunden anpassen", async () => {
      const res = await apiPatchAs<any>(setup.leadAuth, `/api/customers/${setup.customerA}/assignment`, {
        primaryEmployeeId: setup.employeeA.id,
        backupEmployeeId: setup.employeeB.id,
        backupEmployeeId2: null,
      });
      expect(res.status).toBe(200);
      expect(res.data.backupEmployeeId).toBe(setup.employeeB.id);
    });

    it("regulärer Mitarbeiter darf keine Zuordnung ändern", async () => {
      const res = await apiPatchAs<any>(setup.employeeAAuth, `/api/customers/${setup.customerA}/assignment`, {
        primaryEmployeeId: setup.employeeA.id,
        backupEmployeeId: null,
        backupEmployeeId2: null,
      });
      expect(res.status).toBe(403);
    });
  });

  describe("Kaufmännische Bereiche bleiben Admin-only", () => {
    it("Teamleiter darf keine Mitarbeiter anlegen", async () => {
      const ts = Date.now();
      const res = await apiPostAs<any>(setup.leadAuth, "/api/admin/users", {
        email: `tl252-forbidden-${ts}@test.local`,
        password: "TestPasswort123!",
        vorname: "Test",
        nachname: `Forbidden_${ts}`,
        geburtsdatum: "1990-01-01",
        eintrittsdatum: "2024-01-01",
        isAdmin: false,
      });
      expect([401, 403]).toContain(res.status);
    });

    it("Teamleiter darf keine Kunden anlegen (kaufmännischer Stammdaten-Bereich)", async () => {
      const res = await apiPostAs<any>(setup.leadAuth, "/api/admin/customers", {
        vorname: "Test",
        nachname: `TL252_Forbidden_${Date.now()}`,
        geburtsdatum: "1940-01-15",
        strasse: "Teststr.",
        nr: "1",
        plz: "10115",
        stadt: "Berlin",
        telefon: "+4917600000000",
        pflegegrad: 3,
        pflegegradSeit: "2024-01-01",
        acceptsPrivatePayment: true,
      });
      expect([401, 403]).toContain(res.status);
    });
  });

  describe("Kunden-Stammdaten / Dokumente / Kontakte bleiben Admin/Zugeordnete-only", () => {
    it("Teamleiter darf KEINE Kunden-Stammdaten eines fremden Kunden ändern (PATCH /api/customers/:id)", async () => {
      const res = await apiPatchAs<any>(setup.leadAuth, `/api/customers/${setup.customerB}`, {
        telefon: "+4917699999999",
      });
      expect(res.status).toBe(403);
    });

    it("Teamleiter darf KEINEN Pflegegrad eines fremden Kunden setzen", async () => {
      const res = await apiPostAs<any>(setup.leadAuth, `/api/customers/${setup.customerB}/care-level`, {
        pflegegrad: 4,
        seitDatum: "2024-06-01",
      });
      expect(res.status).toBe(403);
    });

    it("Teamleiter darf KEINEN Vertragstext eines fremden Kunden ändern", async () => {
      const res = await apiPatchAs<any>(setup.leadAuth, `/api/customers/${setup.customerB}/contract`, {
        vereinbarteLeistungen: "TL252 darf das nicht",
      });
      expect(res.status).toBe(403);
    });

    it("Teamleiter darf KEINEN Kontakt eines fremden Kunden anlegen", async () => {
      const res = await apiPostAs<any>(setup.leadAuth, `/api/customers/${setup.customerB}/contacts`, {
        vorname: "Test",
        nachname: "Forbidden",
        telefon: "+4917600000000",
        beziehung: "Sohn/Tochter",
      });
      expect(res.status).toBe(403);
    });

    it("Teamleiter darf KEIN Dokument eines fremden Kunden hochladen", async () => {
      const res = await apiPostAs<any>(setup.leadAuth, `/api/customers/${setup.customerB}/documents`, {
        documentTypeId: 1,
        objectPath: ".private/test/forbidden.pdf",
        fileName: "forbidden.pdf",
      });
      expect(res.status).toBe(403);
    });
  });
});
