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
    await getAuthCookie();
    
    const customersRes = await apiGet<{ data: { id: number }[] }>("/api/customers?limit=1");
    if (customersRes.data?.data?.[0]) {
      testCustomerId = customersRes.data.data[0].id;
    } else {
      throw new Error("Kein Test-Kunde gefunden");
    }
    
    testDate = getFutureDate(14);
  });

  afterAll(async () => {
    if (testAppointmentId) {
      await apiDelete(`/api/appointments/${testAppointmentId}`);
    }
  });

  describe("Termin erstellen (POST /appointments/kundentermin)", () => {
    it("sollte einen neuen Kundentermin erstellen können", async () => {
      const { status, data } = await apiPost<Appointment>("/api/appointments/kundentermin", {
        customerId: testCustomerId,
        date: testDate,
        scheduledStart: "10:00",
        hauswirtschaftDauer: 60,
        alltagsbegleitungDauer: 30,
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
      const { status, data } = await apiPost<{ error: string }>("/api/appointments/kundentermin", {
        customerId: testCustomerId,
        date: testDate,
        scheduledStart: "10:30",
        hauswirtschaftDauer: 60,
      });

      expect(status).toBe(409);
      expect(data.error).toContain("Überschneidung");
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
      const newAppt = await apiPost<Appointment>("/api/appointments/kundentermin", {
        customerId: testCustomerId,
        date: getFutureDate(15),
        scheduledStart: "14:00",
        hauswirtschaftDauer: 30,
      });
      
      await apiPost(`/api/appointments/${newAppt.data.id}/start`, {});
      const { status, data } = await apiPost<{ error: string }>(`/api/appointments/${newAppt.data.id}/start`, {});

      expect(status).toBe(403);
      
      await apiDelete(`/api/appointments/${newAppt.data.id}`);
    });
  });

  describe("Termin dokumentieren (POST /appointments/:id/document)", () => {
    it("sollte einen Termin dokumentieren und Budget-Buchung erstellen", async () => {
      interface DocumentResponse extends Appointment {
        budgetTransaction?: {
          id: number;
          amountCents: number;
          transactionType: string;
        } | null;
        budgetWarning?: string | null;
      }
      
      const { status, data } = await apiPost<DocumentResponse>(
        `/api/appointments/${testAppointmentId}/document`,
        {
          hauswirtschaftActualDauer: 55,
          hauswirtschaftDetails: "Küche und Bad gereinigt",
          alltagsbegleitungActualDauer: 25,
          alltagsbegleitungDetails: "Spaziergang im Park",
          travelOriginType: "office",
          travelKilometers: 15,
          travelMinutes: 20,
        }
      );

      expect(status).toBe(200);
      expect(data.status).toBe("completed");
      expect(data.hauswirtschaftActualDauer).toBe(55);
      expect(data.alltagsbegleitungActualDauer).toBe(25);
      
      if (data.budgetTransaction) {
        expect(data.budgetTransaction.transactionType).toBe("consumption");
        expect(data.budgetTransaction.amountCents).toBeGreaterThan(0);
      }
    });

    it("sollte doppelte Dokumentation verhindern", async () => {
      const { status, data } = await apiPost<{ error: string }>(
        `/api/appointments/${testAppointmentId}/document`,
        {
          hauswirtschaftActualDauer: 60,
          hauswirtschaftDetails: "Test",
          travelOriginType: "office",
          travelKilometers: 10,
        }
      );

      expect(status).toBe(403);
      expect(data.error).toContain("ALREADY_COMPLETED");
    });
  });

  describe("Termin löschen (DELETE /appointments/:id)", () => {
    it("sollte dokumentierte Termine nicht löschen können", async () => {
      const { status } = await apiDelete(`/api/appointments/${testAppointmentId}`);
      expect([400, 403]).toContain(status);
    });

    it("sollte geplante Termine löschen können", async () => {
      const newAppt = await apiPost<Appointment>("/api/appointments/kundentermin", {
        customerId: testCustomerId,
        date: getFutureDate(20),
        scheduledStart: "16:00",
        hauswirtschaftDauer: 45,
      });

      const { status } = await apiDelete(`/api/appointments/${newAppt.data.id}`);
      expect(status).toBe(204);

      const getRes = await apiGet(`/api/appointments/${newAppt.data.id}`);
      expect(getRes.status).toBe(404);
    });
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
        },
        date: getFutureDate(21),
        scheduledStart: "11:00",
        erstberatungDauer: 90,
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
