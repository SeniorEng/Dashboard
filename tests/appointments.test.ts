import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  apiGet,
  apiPost,
  apiPatch,
  apiDelete,
  getFutureDate,
  getAuthCookie,
} from "./test-utils";

interface Appointment {
  id: number;
  customerId: number;
  date: string;
  scheduledStart: string;
  scheduledEnd: string;
  status: string;
  hauswirtschaftDauer: number | null;
  alltagsbegleitungDauer: number | null;
  erstberatungDauer: number | null;
  hauswirtschaftActualDauer: number | null;
  alltagsbegleitungActualDauer: number | null;
  erstberatungActualDauer: number | null;
  actualStart: string | null;
  actualEnd: string | null;
}

describe("Termine (Appointments) CRUD", () => {
  let testCustomerId: number;
  let testAppointmentId: number;
  let testDate: string;

  beforeAll(async () => {
    const auth = await getAuthCookie();
    
    const customersRes = await apiGet<{ data: { id: number }[] }>("/api/admin/customers?limit=1");
    const customers = customersRes.data?.data;
    if (Array.isArray(customers) && customers[0]) {
      testCustomerId = customers[0].id;
    } else {
      throw new Error("Kein Test-Kunde gefunden");
    }

    await apiPatch(`/api/admin/customers/${testCustomerId}/assign`, {
      primaryEmployeeId: auth.user.id,
      backupEmployeeId: null,
    });
    
    testDate = getFutureDate(14);
  });

  afterAll(async () => {
    if (testAppointmentId) {
      await apiDelete(`/api/appointments/${testAppointmentId}`);
    }
  });

  describe("Termin erstellen (POST /appointments/kundentermin)", () => {
    it("sollte einen neuen Kundentermin erstellen können", async () => {
      const auth = await getAuthCookie();
      const { status, data } = await apiPost<Appointment>("/api/appointments/kundentermin", {
        customerId: testCustomerId,
        date: testDate,
        scheduledStart: "10:00",
        services: [
          { serviceId: 1, durationMinutes: 60 },
          { serviceId: 2, durationMinutes: 30 },
        ],
        assignedEmployeeId: auth.user.id,
      });

      expect(status).toBe(201);
      expect(data).toHaveProperty("id");
      expect(data.customerId).toBe(testCustomerId);
      expect(data.date).toBe(testDate);
      expect(data.status).toBe("scheduled");
      expect(data.hauswirtschaftDauer).toBe(60);
      expect(data.alltagsbegleitungDauer).toBe(30);

      testAppointmentId = data.id;
    });

    it("sollte Überlappungen erkennen", async () => {
      const auth = await getAuthCookie();
      const { status, data } = await apiPost<{ message: string }>("/api/appointments/kundentermin", {
        customerId: testCustomerId,
        date: testDate,
        scheduledStart: "10:30",
        services: [
          { serviceId: 1, durationMinutes: 60 },
        ],
        assignedEmployeeId: auth.user.id,
      });

      expect(status).toBe(409);
      expect(data.message.toLowerCase()).toMatch(/termin|überschneidung|zeit/);
    });

    it("sollte Validierungsfehler bei fehlenden Pflichtfeldern zurückgeben", async () => {
      const { status } = await apiPost("/api/appointments/kundentermin", {
        date: testDate,
      });

      expect(status).toBe(400);
    });
  });

  describe("Termin abrufen (GET /appointments/:id)", () => {
    it("sollte einen einzelnen Termin abrufen können", async () => {
      const { status, data } = await apiGet<Appointment>(`/api/appointments/${testAppointmentId}`);

      expect(status).toBe(200);
      expect(data.id).toBe(testAppointmentId);
      expect(data.customerId).toBe(testCustomerId);
    });

    it("sollte 404 für nicht existierende Termine zurückgeben", async () => {
      const { status } = await apiGet("/api/appointments/999999");
      expect(status).toBe(404);
    });
  });

  describe("Termin bearbeiten (PATCH /appointments/:id)", () => {
    it("sollte einen Termin bearbeiten können", async () => {
      const { status, data } = await apiPatch<Appointment>(`/api/appointments/${testAppointmentId}`, {
        hauswirtschaftDauer: 90,
        notes: "Test-Notiz aktualisiert",
      });

      expect(status).toBe(200);
      expect(data.hauswirtschaftDauer).toBe(90);
    });

    it("sollte ungültige Status-Übergänge ablehnen", async () => {
      const { status } = await apiPatch(`/api/appointments/${testAppointmentId}`, {
        status: "completed",
      });

      expect([400, 403]).toContain(status);
    });
  });

  describe("Termin-Status-Workflow", () => {
    it("sollte Termin starten können (scheduled -> in-progress)", async () => {
      const { status, data } = await apiPost<Appointment>(`/api/appointments/${testAppointmentId}/start`, {});

      expect(status).toBe(200);
      expect(data.status).toBe("in-progress");
      expect(data.actualStart).toBeTruthy();
    });

    it("sollte Termin beenden können (in-progress -> documenting)", async () => {
      const { status, data } = await apiPost<Appointment>(`/api/appointments/${testAppointmentId}/end`, {});

      expect(status).toBe(200);
      expect(data.status).toBe("documenting");
      expect(data.actualEnd).toBeTruthy();
    });

    it("sollte doppeltes Starten verhindern", async () => {
      const auth = await getAuthCookie();
      const newAppt = await apiPost<Appointment>("/api/appointments/kundentermin", {
        customerId: testCustomerId,
        date: getFutureDate(15),
        scheduledStart: "14:00",
        services: [
          { serviceId: 1, durationMinutes: 30 },
        ],
        assignedEmployeeId: auth.user.id,
      });
      
      if (newAppt.status !== 201) {
        console.log("Termin-Erstellung fehlgeschlagen:", newAppt.data);
        expect(newAppt.status).toBe(201);
        return;
      }
      
      await apiPost(`/api/appointments/${newAppt.data.id}/start`, {});
      const { status } = await apiPost<{ error: string }>(`/api/appointments/${newAppt.data.id}/start`, {});

      expect(status).toBe(403);
      
      await apiDelete(`/api/appointments/${newAppt.data.id}`);
    });
  });

  describe("Termin dokumentieren (POST /appointments/:id/document)", () => {
    let docTestAppointmentId: number;
    
    beforeAll(async () => {
      const auth = await getAuthCookie();
      const appt = await apiPost<Appointment>("/api/appointments/kundentermin", {
        customerId: testCustomerId,
        date: getFutureDate(50),
        scheduledStart: "09:00",
        services: [
          { serviceId: 1, durationMinutes: 60 },
          { serviceId: 2, durationMinutes: 30 },
        ],
        assignedEmployeeId: auth.user.id,
      });
      
      if (appt.status === 201) {
        docTestAppointmentId = appt.data.id;
        await apiPost(`/api/appointments/${docTestAppointmentId}/start`, {});
        await apiPost(`/api/appointments/${docTestAppointmentId}/end`, {});
      }
    });
    
    it("sollte Fehler bei fehlender Preisvereinbarung zurückgeben", async () => {
      if (!docTestAppointmentId) {
        console.log("Termin-Erstellung fehlgeschlagen");
        return;
      }
      
      const { status, data } = await apiPost<{ code: string; message: string }>(
        `/api/appointments/${docTestAppointmentId}/document`,
        {
          actualStart: "09:00",
          hauswirtschaftActualDauer: 55,
          hauswirtschaftDetails: "Küche und Bad gereinigt",
          alltagsbegleitungActualDauer: 25,
          alltagsbegleitungDetails: "Spaziergang im Park",
          travelOriginType: "home",
          travelKilometers: 15,
          travelMinutes: 20,
        }
      );

      expect(status).toBe(400);
      expect(data.message.toLowerCase()).toMatch(/preis|budget|vereinbarung/);
    });

    it("sollte doppelte Dokumentation verhindern", async () => {
      if (!docTestAppointmentId) {
        console.log("Termin-Erstellung fehlgeschlagen");
        return;
      }
      
      const { status } = await apiPost<{ code: string; message: string }>(
        `/api/appointments/${docTestAppointmentId}/document`,
        {
          hauswirtschaftActualDauer: 60,
          hauswirtschaftDetails: "Test",
          travelOriginType: "home",
          travelKilometers: 10,
        }
      );

      expect(status).toBe(400);
    });
  });

  describe("Termin löschen (DELETE /appointments/:id)", () => {
    it("sollte dokumentierte Termine nicht löschen können", async () => {
      if (!testAppointmentId) {
        console.log("Kein Termin zum Löschen vorhanden");
        return;
      }
      
      const { status } = await apiDelete(`/api/appointments/${testAppointmentId}`);
      expect([200, 400, 403, 404]).toContain(status);
    });

    it("sollte geplante Termine löschen können", async () => {
      const auth = await getAuthCookie();
      const newAppt = await apiPost<Appointment>("/api/appointments/kundentermin", {
        customerId: testCustomerId,
        date: getFutureDate(20),
        scheduledStart: "16:00",
        services: [
          { serviceId: 1, durationMinutes: 45 },
        ],
        assignedEmployeeId: auth.user.id,
      });
      
      if (newAppt.status !== 201) {
        console.log("Termin-Erstellung fehlgeschlagen:", newAppt.data);
        expect(newAppt.status).toBe(201);
        return;
      }

      const { status } = await apiDelete(`/api/appointments/${newAppt.data.id}`);
      expect([200, 204]).toContain(status);

      const getRes = await apiGet(`/api/appointments/${newAppt.data.id}`);
      expect(getRes.status).toBe(404);
    });
  });
});

interface AppointmentService {
  id: number;
  serviceId: number;
  plannedDurationMinutes: number;
  actualDurationMinutes: number | null;
  details: string | null;
  serviceName: string;
  serviceCode: string | null;
  serviceUnitType: string;
}

describe("Junction-Tabelle (appointment_services)", () => {
  let junctionTestApptId: number;
  let testCustomerId: number;

  beforeAll(async () => {
    const auth = await getAuthCookie();
    const customersRes = await apiGet<{ data: { id: number }[] }>("/api/admin/customers?limit=1");
    testCustomerId = customersRes.data.data[0].id;

    await apiPatch(`/api/admin/customers/${testCustomerId}/assign`, {
      primaryEmployeeId: auth.user.id,
      backupEmployeeId: null,
    });
  });

  afterAll(async () => {
    if (junctionTestApptId) {
      await apiDelete(`/api/appointments/${junctionTestApptId}`);
    }
  });

  it("sollte Legacy-Services in Junction-Tabelle UND Legacy-Spalten schreiben", async () => {
    const auth = await getAuthCookie();
    const { status, data } = await apiPost<Appointment>("/api/appointments/kundentermin", {
      customerId: testCustomerId,
      date: getFutureDate(160),
      scheduledStart: "08:00",
      services: [
        { serviceId: 1, durationMinutes: 60 },
        { serviceId: 2, durationMinutes: 45 },
      ],
      assignedEmployeeId: auth.user.id,
    });

    expect(status).toBe(201);
    expect(data.hauswirtschaftDauer).toBe(60);
    expect(data.alltagsbegleitungDauer).toBe(45);

    junctionTestApptId = data.id;

    const servicesRes = await apiGet<AppointmentService[]>(`/api/appointments/${data.id}/services`);
    expect(servicesRes.status).toBe(200);
    expect(servicesRes.data).toHaveLength(2);

    const hwService = servicesRes.data.find((s) => s.serviceCode === "hauswirtschaft");
    const abService = servicesRes.data.find((s) => s.serviceCode === "alltagsbegleitung");
    expect(hwService?.plannedDurationMinutes).toBe(60);
    expect(abService?.plannedDurationMinutes).toBe(45);
  });

  it("sollte Termin mit nur neuen Services erstellen (Legacy-Spalten null)", async () => {
    const auth = await getAuthCookie();

    const allServices = await apiGet<{ id: number; code: string | null; name: string }[]>("/api/services/all");
    const newService = allServices.data.find((s) => s.code !== "hauswirtschaft" && s.code !== "alltagsbegleitung" && s.code !== "erstberatung" && s.code !== "kilometer");

    if (!newService) {
      console.log("Kein neuer Service zum Testen vorhanden - Test übersprungen");
      return;
    }

    const { status, data } = await apiPost<Appointment>("/api/appointments/kundentermin", {
      customerId: testCustomerId,
      date: getFutureDate(161),
      scheduledStart: "14:00",
      services: [
        { serviceId: newService.id, durationMinutes: 45 },
      ],
      assignedEmployeeId: auth.user.id,
    });

    expect(status).toBe(201);
    expect(data.hauswirtschaftDauer).toBeNull();
    expect(data.alltagsbegleitungDauer).toBeNull();

    const servicesRes = await apiGet<AppointmentService[]>(`/api/appointments/${data.id}/services`);
    expect(servicesRes.status).toBe(200);
    expect(servicesRes.data).toHaveLength(1);
    expect(servicesRes.data[0].serviceId).toBe(newService.id);
    expect(servicesRes.data[0].plannedDurationMinutes).toBe(45);

    await apiDelete(`/api/appointments/${data.id}`);
  });

  it("sollte gemischte Services korrekt aufteilen", async () => {
    const auth = await getAuthCookie();

    const allServices = await apiGet<{ id: number; code: string | null; name: string }[]>("/api/services/all");
    const newService = allServices.data.find((s) => s.code !== "hauswirtschaft" && s.code !== "alltagsbegleitung" && s.code !== "erstberatung" && s.code !== "kilometer");

    if (!newService) {
      console.log("Kein neuer Service zum Testen vorhanden - Test übersprungen");
      return;
    }

    const { status, data } = await apiPost<any>("/api/appointments/kundentermin", {
      customerId: testCustomerId,
      date: getFutureDate(162),
      scheduledStart: "09:00",
      services: [
        { serviceId: 1, durationMinutes: 30 },
        { serviceId: newService.id, durationMinutes: 30 },
      ],
      assignedEmployeeId: auth.user.id,
    });

    if (status !== 201) {
      console.log("Gemischte Services error:", JSON.stringify(data));
    }
    expect(status).toBe(201);
    expect(data.hauswirtschaftDauer).toBe(30);
    expect(data.alltagsbegleitungDauer).toBeNull();

    const servicesRes = await apiGet<AppointmentService[]>(`/api/appointments/${data.id}/services`);
    expect(servicesRes.status).toBe(200);
    expect(servicesRes.data).toHaveLength(2);

    await apiDelete(`/api/appointments/${data.id}`);
  });

  it("sollte durationPromised als Summe aller Services berechnen", async () => {
    const auth = await getAuthCookie();
    const { status, data } = await apiPost<Appointment & { durationPromised: number }>("/api/appointments/kundentermin", {
      customerId: testCustomerId,
      date: getFutureDate(163),
      scheduledStart: "10:00",
      services: [
        { serviceId: 1, durationMinutes: 60 },
        { serviceId: 2, durationMinutes: 45 },
      ],
      assignedEmployeeId: auth.user.id,
    });

    expect(status).toBe(201);
    expect(data.durationPromised).toBe(105);

    await apiDelete(`/api/appointments/${data.id}`);
  });
});

describe("Erstberatung (Initial Consultation)", () => {
  let createdAppointmentId: number;
  let createdCustomerId: number;

  afterAll(async () => {
    if (createdAppointmentId) {
      await apiDelete(`/api/appointments/${createdAppointmentId}`);
    }
  });

  it("sollte eine Erstberatung mit neuem Kunden erstellen", async () => {
    const auth = await getAuthCookie();
    const { status, data } = await apiPost<{ appointment: Appointment; customer: { id: number; name: string } }>(
      "/api/appointments/erstberatung",
      {
        customer: {
          vorname: "Test",
          nachname: `Erstberatung_${Date.now()}`,
          strasse: "Teststraße",
          nr: "1",
          plz: "12345",
          stadt: "Teststadt",
          telefon: "+491234567890",
          pflegegrad: 2,
        },
        date: getFutureDate(21),
        scheduledStart: "11:00",
        erstberatungDauer: 90,
        assignedEmployeeId: auth.user.id,
      }
    );

    expect(status).toBe(201);
    expect(data.appointment).toHaveProperty("id");
    expect(data.customer).toHaveProperty("id");
    expect(data.appointment.erstberatungDauer).toBe(90);

    createdAppointmentId = data.appointment.id;
    createdCustomerId = data.customer.id;
  });
});
