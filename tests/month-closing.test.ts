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

describe("MC-2: Bereitschaftsprüfung", () => {
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

describe("MC-4: Admin-Monatsabschluss durchführen", () => {
  it("MC-4.1 – Abschluss ohne Zeiteinträge wird abgelehnt", async () => {
    const farFutureYear = currentYear + 5;
    const res = await apiPost<any>("/api/time-entries/admin/close-month", {
      year: farFutureYear,
      month: 1,
      userId: auth.user.id,
    });
    expect(res.status).toBe(400);
    expect(res.data.message).toBeTruthy();
  });

  it("MC-4.2 – Ungültige Eingabe wird abgelehnt", async () => {
    const res = await apiPost<any>("/api/time-entries/admin/close-month", {});
    expect(res.status).toBe(400);
  });
});

describe("MC-5: Monat wiedereröffnen", () => {
  it("MC-5.1 – Wiedereröffnung eines nicht-abgeschlossenen Monats wird abgelehnt", async () => {
    const farFutureYear = currentYear + 5;
    const res = await apiPost<any>("/api/time-entries/reopen-month", {
      year: farFutureYear,
      month: 1,
      userId: auth.user.id,
    });
    expect(res.status).toBe(400);
  });

  it("MC-5.2 – Ungültige Eingabe wird abgelehnt", async () => {
    const res = await apiPost<any>("/api/time-entries/reopen-month", {});
    expect(res.status).toBe(400);
  });
});

describe("MC-6: Batch-Monatsabschluss", () => {
  it("MC-6.1 – Batch-Abschluss ohne bereite Mitarbeiter liefert Ergebnis", async () => {
    const farFutureYear = currentYear + 5;
    const res = await apiPost<any>("/api/time-entries/admin/batch-close-month", {
      year: farFutureYear,
      month: 1,
    });
    expect(res.status).toBe(400);
  });

  it("MC-6.2 – Ungültige Eingabe wird abgelehnt", async () => {
    const res = await apiPost<any>("/api/time-entries/admin/batch-close-month", {});
    expect(res.status).toBe(400);
  });
});

describe("MC-7: Vorschau Auto-Pausen", () => {
  it("MC-7.1 – GET preview liefert Vorschau für Monat", async () => {
    const res = await apiGet<any>(`/api/time-entries/month-closing/${currentYear}/${currentMonth}/preview`);
    expect(res.status).toBe(200);
  });
});
