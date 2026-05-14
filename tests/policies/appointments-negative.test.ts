/**
 * Negativ-Tests gegen die echten Routen — bestätigt, dass die Policy
 * im Backend tatsächlich greift (nicht nur als Modul existiert).
 *
 * Eine fremde Mitarbeiterin darf weder lesen, noch starten, noch löschen,
 * noch dokumentieren, noch wiedereröffnen — alles muss 403 sein.
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
  apiGet,
  apiPost,
  apiPostAs,
  apiPatchAs,
  apiDeleteAs,
  apiGetAs,
  loginAs,
  createTestCustomer,
  createTestEmployee,
} from "../test-utils";

describe("Termin-Policy — Negativ gegen Routen", () => {
  let strangerAuth: Awaited<ReturnType<typeof loginAs>>;
  let appointmentId: number;

  beforeAll(async () => {
    const customer = await createTestCustomer();
    const owner = await createTestEmployee({ nachnamePrefix: "PolicyOwner" });
    const stranger = await createTestEmployee({ nachnamePrefix: "PolicyStranger" });

    const futureDate = (() => {
      const d = new Date();
      d.setDate(d.getDate() + 14);
      while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
      return d.toISOString().slice(0, 10);
    })();

    const servicesRes = await apiGet<any[]>("/api/services/all");
    const hw = (servicesRes.data ?? []).find((s: any) => s?.code === "hauswirtschaft");
    if (!hw) throw new Error("Kein Hauswirtschafts-Service in Test-DB gefunden");

    const created = await apiPost<{ id: number }>("/api/appointments/kundentermin", {
      customerId: customer.id,
      date: futureDate,
      scheduledStart: "10:00",
      services: [{ serviceId: hw.id, durationMinutes: 60 }],
      assignedEmployeeId: owner.id,
    });
    expect([200, 201], JSON.stringify(created.data)).toContain(created.status);
    appointmentId = created.data.id;

    strangerAuth = await loginAs(stranger.email, stranger.password);
  }, 60000);

  it("Fremde Mitarbeiterin: GET liefert 403", async () => {
    const res = await apiGetAs(strangerAuth, `/api/appointments/${appointmentId}`);
    expect(res.status).toBe(403);
  });

  it("Fremde Mitarbeiterin: PATCH liefert 403", async () => {
    const res = await apiPatchAs(strangerAuth, `/api/appointments/${appointmentId}`, { notes: "hack" });
    expect(res.status).toBe(403);
  });

  it("Fremde Mitarbeiterin: POST /start liefert 403", async () => {
    const res = await apiPostAs(strangerAuth, `/api/appointments/${appointmentId}/start`, {});
    expect(res.status).toBe(403);
  });

  it("Fremde Mitarbeiterin: POST /end liefert 403", async () => {
    const res = await apiPostAs(strangerAuth, `/api/appointments/${appointmentId}/end`, {});
    expect(res.status).toBe(403);
  });

  it("Fremde Mitarbeiterin: POST /document liefert 403", async () => {
    const res = await apiPostAs(strangerAuth, `/api/appointments/${appointmentId}/document`, {
      services: [],
    });
    expect(res.status).toBe(403);
  });

  it("Fremde Mitarbeiterin: POST /reopen liefert 403", async () => {
    const res = await apiPostAs(strangerAuth, `/api/appointments/${appointmentId}/reopen`, {});
    expect(res.status).toBe(403);
  });

  it("Fremde Mitarbeiterin: DELETE liefert 403", async () => {
    const res = await apiDeleteAs(strangerAuth, `/api/appointments/${appointmentId}`);
    expect(res.status).toBe(403);
  });

  // CREATE — Negativ-Tests für die zentrale Create-Policy.
  it("CREATE: Termin am Samstag wird mit 400 abgelehnt (Wochenend-Policy)", async () => {
    const customer = await createTestCustomer();
    const owner = await createTestEmployee({ nachnamePrefix: "PolicyCreateOwner" });
    const sat = (() => {
      const d = new Date();
      d.setDate(d.getDate() + 14);
      while (d.getDay() !== 6) d.setDate(d.getDate() + 1);
      return d.toISOString().slice(0, 10);
    })();
    const services = await apiGet<any[]>("/api/services/all");
    const hw = (services.data ?? []).find((s: any) => s?.code === "hauswirtschaft");
    if (!hw) throw new Error("Kein Hauswirtschafts-Service");
    const res = await apiPost<any>("/api/appointments/kundentermin", {
      customerId: customer.id,
      date: sat,
      scheduledStart: "10:00",
      services: [{ serviceId: hw.id, durationMinutes: 60 }],
      assignedEmployeeId: owner.id,
    });
    expect(res.status).toBe(400);
  });

  it("CREATE: Fremde Mitarbeiterin darf bei nicht zugeordnetem Kunden keinen Termin anlegen (403)", async () => {
    const customer = await createTestCustomer();
    const services = await apiGet<any[]>("/api/services/all");
    const hw = (services.data ?? []).find((s: any) => s?.code === "hauswirtschaft");
    if (!hw) throw new Error("Kein Hauswirtschafts-Service");
    const futureDate = (() => {
      const d = new Date();
      d.setDate(d.getDate() + 21);
      while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
      return d.toISOString().slice(0, 10);
    })();
    const res = await apiPostAs<any>(strangerAuth, "/api/appointments/kundentermin", {
      customerId: customer.id,
      date: futureDate,
      scheduledStart: "10:00",
      services: [{ serviceId: hw.id, durationMinutes: 60 }],
      assignedEmployeeId: strangerAuth.user.id,
    });
    expect(res.status).toBe(403);
  });

  // OVERRIDE-CLOSED-MONTH — Negativ-Test: Nicht-Superadmin darf nicht in
  // einem geschlossenen Monat handeln. Wir markieren einen Vergangenheits-Monat
  // direkt in `employee_month_closings` als geschlossen und verifizieren, dass
  // ein PATCH auf einen Termin in diesem Monat mit MONTH_CLOSED scheitert.
  it("OVERRIDE-CLOSED-MONTH: Owner darf in abgeschlossenen Monat keinen Termin ändern (403, MONTH_CLOSED)", async () => {
    const { db } = await import("../../server/lib/db");
    const { employeeMonthClosings } = await import("@shared/schema/system");
    const { storage } = await import("../../server/storage");

    const owner = await createTestEmployee({ nachnamePrefix: "PolicyMonthOwner" });
    const customer = await createTestCustomer();
    const services = await apiGet<any[]>("/api/services/all");
    const hw = (services.data ?? []).find((s: any) => s?.code === "hauswirtschaft");
    if (!hw) throw new Error("Kein Hauswirtschafts-Service");

    // Termin im Vormonat (Werktag), damit wir den Monat sauber schließen können.
    const past = new Date();
    past.setDate(1);
    past.setMonth(past.getMonth() - 1);
    past.setDate(15);
    while (past.getDay() === 0 || past.getDay() === 6) past.setDate(past.getDate() + 1);
    const pastDate = past.toISOString().slice(0, 10);

    const created = await apiPost<{ id: number }>("/api/appointments/kundentermin", {
      customerId: customer.id,
      date: pastDate,
      scheduledStart: "10:00",
      services: [{ serviceId: hw.id, durationMinutes: 60 }],
      assignedEmployeeId: owner.id,
    });
    expect([200, 201], JSON.stringify(created.data)).toContain(created.status);
    const apptId = created.data.id;

    // Monat als geschlossen markieren (direkter DB-Insert reicht für die
    // `isMonthClosed`-Abfrage, die in `loadPolicyFlags` benutzt wird).
    await db.insert(employeeMonthClosings).values({
      userId: owner.id,
      year: past.getFullYear(),
      month: past.getMonth() + 1,
      closedByUserId: owner.id,
    }).onConflictDoNothing();

    const ownerAuth = await loginAs(owner.email, owner.password);
    const res = await apiPatchAs(ownerAuth, `/api/appointments/${apptId}`, {
      notes: "should fail because month closed",
    });
    expect(res.status).toBe(403);
    expect(String((res.data as any)?.error ?? "")).toMatch(/MONTH_CLOSED/);

    // Cleanup-Marker entfernen, damit andere Tests nicht stolpern.
    await storage.deleteAppointment(apptId).catch(() => {});
  });
});
