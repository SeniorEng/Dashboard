import { describe, it, expect, beforeAll } from "vitest";
import {
  apiGet,
  apiPost,
  getAuthCookie,
} from "./test-utils";

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
const now = new Date();
const currentYear = now.getFullYear();
const currentMonth = now.getMonth() + 1;
const prevMonth = currentMonth === 1 ? 12 : currentMonth - 1;
const prevYear = currentMonth === 1 ? currentYear - 1 : currentYear;

beforeAll(async () => {
  auth = await getAuthCookie();
});

// Task #1496: Der Monatsabschluss läuft ausschließlich automatisch am Cutoff.
// Es gibt KEINE manuellen Abschluss-/Wiedereröffnungs-/Batch-Endpunkte mehr —
// die Routen sind reine Lese-/Status-Endpunkte.

describe("MC-1: Monatsabschluss laden", () => {
  it("MC-1.1 – GET month-closing liefert Status für eigenen Monat", async () => {
    const res = await apiGet<any>(`/api/time-entries/month-closing/${currentYear}/${currentMonth}`);
    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty("closing");
  });

  it("MC-1.2 – Ungültiger Monat wird abgelehnt (400)", async () => {
    const res = await apiGet<any>(`/api/time-entries/month-closing/${currentYear}/13`);
    expect(res.status).toBe(400);
  });
});

describe("MC-2: Bereitschaftsprüfung (Anzeige-Information)", () => {
  it("MC-2.1 – GET readiness liefert Bereitschaftsstatus", async () => {
    const res = await apiGet<any>(`/api/time-entries/month-closing/${currentYear}/${currentMonth}/readiness`);
    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty("hasTimeEntries");
    expect(res.data).toHaveProperty("openAppointments");
    expect(res.data).toHaveProperty("unsignedAppointments");
  });

  it("MC-2.2 – Admin-Readiness liefert Mitarbeiterliste", async () => {
    const res = await apiGet<any>(`/api/time-entries/month-closings/admin/${currentYear}/${currentMonth}/readiness`);
    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty("employees");
    expect(Array.isArray(res.data.employees)).toBe(true);
  });
});

describe("MC-3: Admin-Monatsabschlüsse laden", () => {
  it("MC-3.1 – GET admin month-closings liefert Liste", async () => {
    const res = await apiGet<any>(`/api/time-entries/month-closings/admin/${prevYear}/${prevMonth}`);
    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty("closings");
  });
});

describe("MC-4: Manuelle Abschluss-Endpunkte existieren NICHT mehr", () => {
  it("MC-4.1 – POST admin/close-month ist entfernt (kein 2xx)", async () => {
    const res = await apiPost<any>("/api/time-entries/admin/close-month", {
      year: currentYear + 5,
      month: 1,
      userId: auth.user.id,
    });
    expect(res.status).not.toBe(200);
    expect(res.status).not.toBe(201);
  });

  it("MC-4.2 – POST reopen-month ist entfernt (kein 2xx)", async () => {
    const res = await apiPost<any>("/api/time-entries/reopen-month", {
      year: currentYear + 5,
      month: 1,
      userId: auth.user.id,
      reason: "sollte nicht existieren",
    });
    expect(res.status).not.toBe(200);
    expect(res.status).not.toBe(201);
  });

  it("MC-4.3 – POST admin/batch-close-month ist entfernt (kein 2xx)", async () => {
    const res = await apiPost<any>("/api/time-entries/admin/batch-close-month", {
      year: currentYear + 5,
      month: 1,
    });
    expect(res.status).not.toBe(200);
    expect(res.status).not.toBe(201);
  });
});

describe("MC-5: Vorschau Auto-Pausen", () => {
  it("MC-5.1 – GET preview liefert Vorschau für Monat", async () => {
    const res = await apiGet<any>(`/api/time-entries/month-closing/${currentYear}/${currentMonth}/preview`);
    expect(res.status).toBe(200);
  });
});

describe("MC-6: Readiness-Lebenszyklus (ohne manuellen Close)", () => {
  const testYear = currentYear + 4;
  const testMonth = 6;

  it("MC-6.1 – Readiness vor Zeiteinträgen: hasTimeEntries=false", async () => {
    const res = await apiGet<any>(`/api/time-entries/month-closing/${testYear}/${testMonth}/readiness`);
    expect(res.status).toBe(200);
    expect(res.data.hasTimeEntries).toBe(false);
  });
});
