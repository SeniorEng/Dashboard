/**
 * Task #1089 — Sichert das in Task #1088 eingeführte Verhalten ab: Die
 * Admin-Interessenten-Liste (`GET /api/admin/prospects`) liefert pro Karte den
 * verknüpften Erstberatungstermin (Datum, Startzeit, Status, verantwortlicher
 * Mitarbeiter) im `erstberatung`-Block — gespeist aus
 * `prospectStorage.getErstberatungInfoForProspects`.
 *
 * Abgedeckte Garantien:
 *  - PL-1: Geplante Erstberatung erscheint mit Datum/Startzeit/Status und dem
 *    ZUGEWIESENEN Mitarbeiter (Attribution offen → assignedEmployeeId).
 *  - PL-2: Interessent ohne (nicht-stornierten) Erstberatungstermin liefert
 *    `erstberatung: null`.
 *  - PL-3: Bei mehreren Erstberatungen gewinnt deterministisch die AKTUELLSTE
 *    (spätestes Datum + Startzeit) — z. B. nach einer Umplanung.
 *  - PL-4: Bei abgeschlossener Erstberatung wird der DURCHFÜHRENDE Mitarbeiter
 *    (performedByEmployeeId) angezeigt, nicht der ursprünglich zugewiesene
 *    (Attribution completed → performedBy).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  apiGet,
  apiPost,
  apiDelete,
  getAuthCookie,
  uniqueId,
  createTestEmployee,
  deactivateTestEmployee,
} from "./test-utils";

let auth: Awaited<ReturnType<typeof getAuthCookie>>;

const cleanupApptIds: number[] = [];
const cleanupProspectIds: number[] = [];
const cleanupEmployeeIds: number[] = [];

const ERSTBERATUNG_TIMES = ["07:00", "16:00", "17:00", "06:30", "18:00"];

beforeAll(async () => {
  auth = await getAuthCookie();
});

afterAll(async () => {
  for (const id of cleanupApptIds) {
    try { await apiDelete(`/api/appointments/${id}`); } catch {}
  }
  for (const id of cleanupProspectIds) {
    try { await apiDelete(`/api/prospects/${id}`); } catch {}
  }
  for (const id of cleanupEmployeeIds) {
    await deactivateTestEmployee(id);
  }
});

interface ProspectListEntry {
  id: number;
  erstberatung: {
    date: string;
    scheduledStart: string;
    status: string;
    employeeName: string | null;
  } | null;
}

async function createProspect(suffix: string): Promise<{ id: number }> {
  const res = await apiPost<any>("/api/prospects/inline", {
    vorname: "Liste",
    nachname: `PL-${suffix}-${uniqueId()}`,
    telefon: "+4917600000000",
  });
  expect(res.status, `Prospect-Anlage ${suffix} muss 201 liefern`).toBe(201);
  cleanupProspectIds.push(res.data.id);
  return res.data;
}

/** HH:MM → HH:MM:SS, wie es der Server (time-Spalte) zurückgibt. */
function toHHMMSS(time: string): string {
  return time.length === 5 ? `${time}:00` : time;
}

/**
 * Legt für einen Interessenten einen Erstberatungstermin auf dem ersten freien
 * Slot im angegebenen Offset-Fenster an (Wochenenden werden auf den Werktag
 * verschoben). Liefert das tatsächlich verwendete Datum + (normalisierte)
 * Startzeit zurück, damit der Test exakt gegen die gebuchten Werte prüfen kann.
 */
async function createErstberatungOnFreeSlot(opts: {
  prospectId: number;
  assignedEmployeeId: number;
  offsetRange: [number, number];
  past?: boolean;
  durationMinutes?: number;
}): Promise<{ id: number; date: string; scheduledStart: string }> {
  const duration = opts.durationMinutes ?? 60;
  for (let offset = opts.offsetRange[0]; offset <= opts.offsetRange[1]; offset++) {
    const candidate = new Date();
    candidate.setDate(candidate.getDate() + (opts.past ? -offset : offset));
    const dow = candidate.getDay();
    if (dow === 0) candidate.setDate(candidate.getDate() + (opts.past ? -2 : 1));
    else if (dow === 6) candidate.setDate(candidate.getDate() + (opts.past ? -1 : 2));
    const dateStr = candidate.toISOString().split("T")[0];
    for (const time of ERSTBERATUNG_TIMES) {
      const res = await apiPost<any>("/api/appointments/prospect-erstberatung", {
        prospectId: opts.prospectId,
        date: dateStr,
        scheduledStart: time,
        erstberatungDauer: duration,
        assignedEmployeeId: opts.assignedEmployeeId,
      });
      if (res.status === 201) {
        const appt = res.data.appointment || res.data;
        cleanupApptIds.push(appt.id);
        return { id: appt.id, date: dateStr, scheduledStart: toHHMMSS(time) };
      }
    }
  }
  throw new Error("Kein freier Erstberatungs-Slot im Offset-Fenster gefunden");
}

async function getProspectFromList(prospectId: number): Promise<ProspectListEntry | undefined> {
  const res = await apiGet<any>("/api/admin/prospects");
  expect(res.status).toBe(200);
  const list = Array.isArray(res.data) ? res.data : res.data.data || [];
  return list.find((p: ProspectListEntry) => p.id === prospectId);
}

async function resolveDisplayName(userId: number): Promise<string> {
  const res = await apiGet<any>(`/api/admin/users/${userId}`);
  expect(res.status).toBe(200);
  return res.data.displayName;
}

describe("PL-1: Geplante Erstberatung erscheint in der Interessenten-Liste", () => {
  it("PL-1.1 – Liste liefert Datum, Startzeit, Status und zugewiesenen Mitarbeiter", async () => {
    const prospect = await createProspect("sched");
    const eb = await createErstberatungOnFreeSlot({
      prospectId: prospect.id,
      assignedEmployeeId: auth.user.id,
      offsetRange: [18, 40],
    });

    const expectedName = await resolveDisplayName(auth.user.id);

    const entry = await getProspectFromList(prospect.id);
    expect(entry, "Interessent muss in der Admin-Liste auftauchen").toBeDefined();
    expect(entry!.erstberatung, "erstberatung-Block muss befüllt sein").not.toBeNull();
    expect(entry!.erstberatung!.date).toBe(eb.date);
    expect(entry!.erstberatung!.scheduledStart).toBe(eb.scheduledStart);
    expect(entry!.erstberatung!.status).toBe("scheduled");
    expect(entry!.erstberatung!.employeeName).toBe(expectedName);
  });
});

describe("PL-2: Interessent ohne Erstberatung liefert erstberatung: null", () => {
  it("PL-2.1 – Ohne verknüpften Termin ist der erstberatung-Block null", async () => {
    const prospect = await createProspect("none");
    const entry = await getProspectFromList(prospect.id);
    expect(entry, "Interessent muss in der Admin-Liste auftauchen").toBeDefined();
    expect(entry!.erstberatung).toBeNull();
  });
});

describe("PL-3: Bei mehreren Erstberatungen gewinnt die aktuellste", () => {
  it("PL-3.1 – Spätestes Datum + Startzeit wird angezeigt (Umplanungs-Fall)", async () => {
    const prospect = await createProspect("multi");

    const earlier = await createErstberatungOnFreeSlot({
      prospectId: prospect.id,
      assignedEmployeeId: auth.user.id,
      offsetRange: [18, 28],
    });
    const later = await createErstberatungOnFreeSlot({
      prospectId: prospect.id,
      assignedEmployeeId: auth.user.id,
      offsetRange: [45, 60],
    });

    // Sanity: das zweite Datum muss echt nach dem ersten liegen, sonst prüft
    // der Test nicht den "most current"-Pfad.
    expect(later.date > earlier.date, "later.date muss nach earlier.date liegen").toBe(true);

    const entry = await getProspectFromList(prospect.id);
    expect(entry!.erstberatung, "erstberatung-Block muss befüllt sein").not.toBeNull();
    expect(entry!.erstberatung!.date).toBe(later.date);
    expect(entry!.erstberatung!.scheduledStart).toBe(later.scheduledStart);
  });
});

describe("PL-4: Abgeschlossene Erstberatung zeigt den durchführenden Mitarbeiter", () => {
  it("PL-4.1 – completed ⇒ performedBy statt assigned", async () => {
    const performer = await createTestEmployee({ nachnamePrefix: "PLPerformer" });
    cleanupEmployeeIds.push(performer.id);
    const performerName = await resolveDisplayName(performer.id);
    const assignedName = await resolveDisplayName(auth.user.id);
    // Sonst prüft der Test nicht wirklich den performedBy-vs-assigned-Unterschied.
    expect(performerName).not.toBe(assignedName);

    const prospect = await createProspect("completed");
    const eb = await createErstberatungOnFreeSlot({
      prospectId: prospect.id,
      assignedEmployeeId: auth.user.id,
      offsetRange: [3, 20],
      past: true,
    });

    const servicesRes = await apiGet<any[]>(`/api/appointments/${eb.id}/services`);
    expect(servicesRes.status).toBe(200);
    expect(servicesRes.data.length, "Erstberatung muss einen Service haben").toBeGreaterThan(0);
    const serviceId = servicesRes.data[0].serviceId;

    const docRes = await apiPost<any>(`/api/appointments/${eb.id}/document`, {
      performedByEmployeeId: performer.id,
      actualStart: eb.scheduledStart.slice(0, 5),
      travelOriginType: "home",
      travelKilometers: 0,
      customerKilometers: 0,
      services: [{ serviceId, actualDurationMinutes: 60, details: "Erstberatung durchgeführt" }],
    });
    expect(docRes.status, `Dokumentation muss 200 liefern, war ${docRes.status} (${JSON.stringify(docRes.data)})`).toBe(200);

    const entry = await getProspectFromList(prospect.id);
    expect(entry!.erstberatung, "erstberatung-Block muss befüllt sein").not.toBeNull();
    expect(entry!.erstberatung!.status).toBe("completed");
    expect(entry!.erstberatung!.employeeName).toBe(performerName);
    expect(entry!.erstberatung!.employeeName).not.toBe(assignedName);
  });
});
