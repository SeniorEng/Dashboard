/**
 * Task #1896 — Der Leistungsnachweis umfasst nur EIGENE Termine.
 *
 * Der GoBD-Kern: ein Leistungsnachweis weist einen Erbringer aus und wird von
 * einem Mitarbeiter unterschrieben. Solange die „Stammkraft-Ausnahme" galt
 * (`isPrimary` schaltete den Mitarbeiter-Filter komplett ab), bündelte die
 * Stammkraft eines Kunden die Termine ALLER Kollegen in ihren Nachweis und
 * unterschrieb sie — Dokument-Integrität dahin.
 *
 * Diese Datei prüft die Grenze an den Stellen, an denen sie wirkt:
 *  1. Vertretung bündelt ihre eigenen Termine (die Regel nimmt niemandem etwas).
 *  2. Die Stammkraft kann fremde Termine NICHT bündeln (der eigentliche Fix).
 *  3. Ein durch einen FREMDEN Nachweis abgedeckter Termin erzeugt keine
 *     Phantom-Aufgabe mehr.
 *  4. Übersichtszahl und tatsächlich erstellbarer Nachweis stimmen überein.
 *  5. Invariante: Erbringer und Unterzeichner können nicht auseinanderfallen.
 *
 * Alles über die echten HTTP-Endpunkte mit echten Nicht-Admin-Logins.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  apiPost,
  apiPatch,
  apiDelete,
  apiGetAs,
  apiPostAs,
  getAuthCookie,
  loginAs,
  uniqueId,
  createTestCustomer,
  createTestEmployee,
  cleanupCustomer,
} from "../test-utils";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
/** Werktag im laufenden Monat — vermeidet das Monatsabschluss-Gate. */
function pastWeekday(): Date {
  const now = new Date();
  for (let i = 1; i <= 10; i++) {
    const cand = new Date();
    cand.setDate(cand.getDate() - i);
    const dow = cand.getDay();
    if (dow !== 0 && dow !== 6 && cand.getMonth() === now.getMonth()) return cand;
  }
  return now;
}

let admin: Awaited<ReturnType<typeof getAuthCookie>>;
/** Stammkraft des Kunden (Primär) — sie durfte früher alles bündeln. */
let stammkraft: { id: number; email: string; password: string };
/** Vertretung (Backup) — sie leistet die Termine in diesem Test. */
let vertretung: { id: number; email: string; password: string };
/** Dritter Mitarbeiter — nur, weil die Zuordnungs-Route Backup2 verlangt. */
let backup2: { id: number; email: string; password: string };
let customerId: number;
let hwServiceId: number;
let year: number;
let month: number;
let dateStr: string;
const cleanupApptIds: number[] = [];
/** Termin mit `assigned = Stammkraft`, `performed = Vertretung`, dokumentiert. */
let divergentApptId: number;
const cleanupRecordIds: number[] = [];

async function createDocumentedAppointment(
  time: string,
  employeeId: number,
  performedByEmployeeId: number = employeeId,
): Promise<number> {
  const apptRes = await apiPost<any>("/api/appointments/kundentermin", {
    customerId,
    date: dateStr,
    scheduledStart: time,
    services: [{ serviceId: hwServiceId, durationMinutes: 30 }],
    assignedEmployeeId: employeeId,
    notes: `T1896-scope-${uniqueId()}`,
  });
  if (apptRes.status !== 201) {
    throw new Error(`appointment failed: ${apptRes.status} ${JSON.stringify(apptRes.data)}`);
  }
  cleanupApptIds.push(apptRes.data.id);
  const docRes = await apiPost<any>(`/api/appointments/${apptRes.data.id}/document`, {
    actualStart: time,
    travelOriginType: "home",
    travelKilometers: 0,
    customerKilometers: 0,
    services: [{ serviceId: hwServiceId, actualDurationMinutes: 30, details: "T1896" }],
    performedByEmployeeId,
  });
  if (docRes.status !== 200) {
    throw new Error(`document failed: ${docRes.status} ${JSON.stringify(docRes.data)}`);
  }
  return apptRes.data.id;
}

beforeAll(async () => {
  admin = await getAuthCookie();

  const svcRes = await fetch(`${BASE_URL}/api/services/all`, { headers: { Cookie: admin.cookie } });
  const svcJson = (await svcRes.json()) as any[];
  hwServiceId = svcJson.find((s) => s.code === "hauswirtschaft")!.id;

  stammkraft = await createTestEmployee({ nachnamePrefix: "T1896_Stamm" });
  vertretung = await createTestEmployee({ nachnamePrefix: "T1896_Vertretung" });
  backup2 = await createTestEmployee({ nachnamePrefix: "T1896_Backup2" });

  const cust = await createTestCustomer({ nachname: `Privat-T1896S-${uniqueId()}` });
  customerId = cust.id as number;

  const assignRes = await apiPatch<any>(`/api/admin/customers/${customerId}/assign`, {
    primaryEmployeeId: stammkraft.id,
    backupEmployeeId: vertretung.id,
    backupEmployeeId2: backup2.id,
  });
  if (assignRes.status !== 200) {
    throw new Error(`assign failed: ${assignRes.status} ${JSON.stringify(assignRes.data)}`);
  }

  const day = pastWeekday();
  year = day.getFullYear();
  month = day.getMonth() + 1;
  dateStr = ymd(day);

  // Termin 1: zugewiesen UND geleistet von der VERTRETUNG.
  await createDocumentedAppointment("08:00", vertretung.id);

  // Termin 2 — DIVERGENZ: der STAMMKRAFT zugewiesen, aber von der Vertretung
  // GELEISTET (Feld „Durchgeführt von" beim Dokumentieren). Seit der Weiche vom
  // 09.08.2026 zählt bei dokumentierten Terminen ausschließlich der Erbringer:
  // der Termin gehört der Vertretung, nicht der Stammkraft. Unter dem früheren
  // flachen `assigned ODER performed` hätte ihn die Stammkraft besessen und
  // unterschrieben — obwohl die Vertretung ihn geleistet hat.
  divergentApptId = await createDocumentedAppointment("09:00", stammkraft.id, vertretung.id);

  // Die Stammkraft hat damit in diesem Monat bei diesem Kunden NULL eigene
  // Termine — obwohl ihr einer davon zugewiesen ist.
});

afterAll(async () => {
  for (const id of cleanupRecordIds) {
    try { await apiDelete(`/api/service-records/${id}`); } catch {}
  }
  for (const id of cleanupApptIds) {
    try { await apiDelete(`/api/appointments/${id}`); } catch {}
  }
  await cleanupCustomer(customerId);
});

describe("Leistungsnachweis-Umfang: nur eigene Termine (Task #1896)", () => {
  it(
    "Stammkraft: check-period zeigt NULL eigene Termine, obwohl der Kunde ihr zugeordnet ist",
    async () => {
      const auth = await loginAs(stammkraft.email, stammkraft.password);
      const res = await apiGetAs<any>(
        auth,
        `/api/service-records/check-period?customerId=${customerId}&year=${year}&month=${month}`,
      );
      expect(res.status, JSON.stringify(res.data)).toBe(200);
      // Der Termin der Vertretung gehört ihr nicht — er zählt nicht mit.
      expect(res.data.documentedCount).toBe(0);
      expect(res.data.canCreateRecord).toBe(false);
      expect(res.data.selectableAppointments).toEqual([]);
    },
    60_000,
  );

  it(
    "Stammkraft kann über den fremden Termin KEINEN Sammel-Nachweis anlegen",
    async () => {
      const auth = await loginAs(stammkraft.email, stammkraft.password);
      const res = await apiPostAs<any>(auth, "/api/service-records", {
        customerId,
        employeeId: stammkraft.id,
        year,
        month,
      });
      expect(res.status, JSON.stringify(res.data)).toBe(400);
      expect(String(res.data?.message)).toContain("keine dokumentierten Termine");
    },
    60_000,
  );

  it(
    "Stammkraft kann über den ihr ZUGEWIESENEN, aber fremd geleisteten Termin keinen Einzel-Nachweis anlegen",
    async () => {
      // Der schärfste Fall der Weiche: der Termin ist ihr zugewiesen. Unter dem
      // flachen `assigned ODER performed` wäre das ein 201 gewesen.
      const auth = await loginAs(stammkraft.email, stammkraft.password);
      const res = await apiPostAs<any>(auth, "/api/service-records/single", {
        customerId,
        appointmentId: divergentApptId,
      });
      expect(res.status, JSON.stringify(res.data)).toBe(403);
      expect(String(res.data?.message)).toContain("eigenen Termine");
    },
    60_000,
  );

  it(
    "DIVERGENZ: der zugewiesene-aber-fremd-geleistete Termin liegt im Umfang des ERBRINGERS",
    async () => {
      const stammAuth = await loginAs(stammkraft.email, stammkraft.password);
      const vertretungAuth = await loginAs(vertretung.email, vertretung.password);
      const path = `/api/service-records/check-period?customerId=${customerId}&year=${year}&month=${month}`;

      const beiStammkraft = await apiGetAs<any>(stammAuth, path);
      const beiVertretung = await apiGetAs<any>(vertretungAuth, path);

      const idsStamm = beiStammkraft.data.selectableAppointments.map((a: any) => a.id);
      const idsVertretung = beiVertretung.data.selectableAppointments.map((a: any) => a.id);

      expect(idsStamm, "der Zugewiesene darf den dokumentierten Termin NICHT bekommen").not.toContain(
        divergentApptId,
      );
      expect(idsVertretung, "der Erbringer bekommt ihn").toContain(divergentApptId);
    },
    60_000,
  );

  it(
    "Vertretung bündelt ihren eigenen Termin — Übersichtszahl und erstellbarer Nachweis stimmen überein",
    async () => {
      const auth = await loginAs(vertretung.email, vertretung.password);

      const check = await apiGetAs<any>(
        auth,
        `/api/service-records/check-period?customerId=${customerId}&year=${year}&month=${month}`,
      );
      expect(check.status, JSON.stringify(check.data)).toBe(200);
      expect(check.data.documentedCount).toBe(2);
      expect(check.data.canCreateRecord).toBe(true);

      const overview = await apiGetAs<any[]>(
        auth,
        `/api/service-records/overview?year=${year}&month=${month}`,
      );
      expect(overview.status).toBe(200);
      const row = overview.data.find((r: any) => r.customerId === customerId);
      expect(row, "Kunde fehlt in der Übersicht der Vertretung").toBeTruthy();
      // Die Zahl auf der Kachel MUSS zur Detailansicht passen — sonst bietet
      // die Übersicht einen Nachweis an, den der Dialog dahinter verweigert.
      expect(row.documentedCount).toBe(check.data.documentedCount);
      expect(row.uncoveredDocumentedCount).toBe(check.data.uncoveredDocumentedCount);
      expect(row.canCreateRecord).toBe(check.data.canCreateRecord);

      const created = await apiPostAs<any>(auth, "/api/service-records", {
        customerId,
        employeeId: vertretung.id,
        year,
        month,
      });
      expect(created.status, JSON.stringify(created.data)).toBe(201);
      cleanupRecordIds.push(created.data.id);
      expect(created.data.employeeId).toBe(vertretung.id);
    },
    60_000,
  );

  it(
    "der abgedeckte Termin erzeugt bei der Stammkraft keine Phantom-Aufgabe",
    async () => {
      const auth = await loginAs(stammkraft.email, stammkraft.password);

      // Der Nachweis der Vertretung ist KEINE offene Aufgabe der Stammkraft.
      const pending = await apiGetAs<any[]>(auth, "/api/service-records/pending");
      expect(pending.status).toBe(200);
      expect(
        pending.data.filter((r: any) => r.customerId === customerId),
        "fremder Nachweis darf nicht in den eigenen offenen Aufgaben stehen",
      ).toEqual([]);

      // Und er taucht auch nicht in der eigenen Nachweis-Liste auf.
      const own = await apiGetAs<any[]>(
        auth,
        `/api/service-records?year=${year}&month=${month}&customerId=${customerId}`,
      );
      expect(own.status).toBe(200);
      expect(own.data).toEqual([]);
    },
    60_000,
  );

  it(
    "Invariante wird ERZWUNGEN: wechselt der Erbringer nach der Anlage, ist der Nachweis nicht mehr unterschreibbar",
    async () => {
      // Der Weg, auf dem „Inhaber = Erbringer" NICHT aus dem Umfang folgt:
      // der Nachweis ist erst `pending`, also greift die Termin-Sperre noch
      // nicht. Reopen loest die Verknuepfung zum Nachweis NICHT, und die
      // erneute Dokumentation darf `performed_by` frei setzen. Ohne den Guard
      // im Sign-Pfad enthielte der Nachweis der Vertretung danach einen
      // Termin, den die Stammkraft geleistet hat — und die Vertretung duerfte
      // ihn unterschreiben.
      const recordId = cleanupRecordIds[0];
      expect(recordId, "Vorgängertest muss den Nachweis angelegt haben").toBeTruthy();

      const reopen = await apiPost<any>(`/api/appointments/${cleanupApptIds[0]}/reopen`, {});
      expect(reopen.status, JSON.stringify(reopen.data)).toBe(200);

      const redoc = await apiPost<any>(`/api/appointments/${cleanupApptIds[0]}/document`, {
        actualStart: "08:00",
        travelOriginType: "home",
        travelKilometers: 0,
        customerKilometers: 0,
        services: [{ serviceId: hwServiceId, actualDurationMinutes: 30, details: "T1896-redoc" }],
        performedByEmployeeId: stammkraft.id,
      });
      expect(redoc.status, JSON.stringify(redoc.data)).toBe(200);

      const auth = await loginAs(vertretung.email, vertretung.password);
      const sign = await apiPostAs<any>(auth, `/api/service-records/${recordId}/sign`, {
        signatureData: "data:image/png;base64,iVBORw0KGgo=",
        signerType: "employee",
        signingLocation: null,
      });
      expect(sign.status, JSON.stringify(sign.data)).toBe(409);
      expect(String(sign.data?.error)).toBe("FOREIGN_APPOINTMENTS");
    },
    60_000,
  );

  it(
    "Invariante: der Nachweis gehört dem Erbringer — und NUR der darf unterschreiben",
    async () => {
      const recordId = cleanupRecordIds[0];
      expect(recordId, "Vorgängertest muss den Nachweis angelegt haben").toBeTruthy();

      const stammAuth = await loginAs(stammkraft.email, stammkraft.password);
      const blocked = await apiPostAs<any>(stammAuth, `/api/service-records/${recordId}/sign`, {
        signatureData: "data:image/png;base64,iVBORw0KGgo=",
        signerType: "employee",
        signingLocation: null,
      });
      // 403 aus dem Unterzeichner-Guard — NICHT 400 aus der Signatur-Prüfung.
      // Die Reihenfolge ist der Beweis: die Grenze greift vor jeder inhaltlichen
      // Bewertung der Unterschrift.
      expect(blocked.status, JSON.stringify(blocked.data)).toBe(403);
      expect(String(blocked.data?.message)).toContain("zugeordnete Mitarbeiter");
    },
    60_000,
  );
});
