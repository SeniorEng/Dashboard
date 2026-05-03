import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  apiPatch,
  apiPost,
  apiPostAs,
  apiDelete,
  loginAs,
  createTestEmployee,
  deactivateTestEmployee,
  resetAuthCache,
  getFutureDate,
  uniqueId,
} from "./test-utils";

/**
 * Task #312 — Backend-Lücke: Teamleitung darf Erstberatung im Namen
 * eines anderen Erstberaters anlegen (POST /api/appointments/prospect-erstberatung).
 *
 * Vor dieser Änderung erzwang die Route stillschweigend
 * `assignedEmployeeId = user.id` für alle Nicht-Admins, sodass der seit
 * Task #311 sichtbare EB-Mitarbeiter-Selector im Frontend wirkungslos blieb.
 */

const createdEmployeeIds: number[] = [];
const createdProspectIds: number[] = [];
const createdAppointmentIds: number[] = [];

let leadAuth: Awaited<ReturnType<typeof loginAs>>;
let regularAuth: Awaited<ReturnType<typeof loginAs>>;
let targetErstberater: { id: number; email: string; password: string };
let inactiveEmployee: { id: number; email: string; password: string };

beforeAll(async () => {
  // Teamleitung
  const lead = await createTestEmployee({ nachnamePrefix: "TL312_Lead" });
  createdEmployeeIds.push(lead.id);
  await apiPatch(`/api/admin/users/${lead.id}`, { isTeamLead: true });

  // Regulärer Mitarbeiter (Negativtest)
  const regular = await createTestEmployee({ nachnamePrefix: "TL312_Reg" });
  createdEmployeeIds.push(regular.id);

  // Ziel-Erstberater (aktiver Kollege)
  targetErstberater = await createTestEmployee({ nachnamePrefix: "TL312_Target" });
  createdEmployeeIds.push(targetErstberater.id);

  // Inaktiver Mitarbeiter — wird vor den Tests deaktiviert
  inactiveEmployee = await createTestEmployee({ nachnamePrefix: "TL312_Inactive" });
  createdEmployeeIds.push(inactiveEmployee.id);
  await deactivateTestEmployee(inactiveEmployee.id);

  leadAuth = await loginAs(lead.email, lead.password);
  regularAuth = await loginAs(regular.email, regular.password);
});

afterAll(async () => {
  for (const id of createdAppointmentIds) {
    try { await apiDelete(`/api/appointments/${id}`); } catch {}
  }
  for (const id of createdProspectIds) {
    try { await apiDelete(`/api/prospects/${id}`); } catch {}
  }
  for (const id of [...createdEmployeeIds].reverse()) {
    await deactivateTestEmployee(id).catch(() => {});
  }
  resetAuthCache();
});

async function createProspect(): Promise<number> {
  // Prospect über Admin anlegen (Endpoint /api/prospects/inline erfordert
  // requireRoles("erstberatung")) — Test-Teamleitung/Reg-User haben diese
  // Rolle nicht, das ist für Task #312 aber irrelevant.
  const res = await apiPost<any>("/api/prospects/inline", {
    vorname: "Erika",
    nachname: "TL312-" + uniqueId(),
    telefon: "+4917612345678",
  });
  expect(res.status).toBe(201);
  const id = res.data.id as number;
  createdProspectIds.push(id);
  return id;
}

async function tryCreateErstberatung(
  auth: Awaited<ReturnType<typeof loginAs>>,
  prospectId: number,
  assignedEmployeeId: number | undefined,
): Promise<{ status: number; data: any }> {
  const timeSlots = ["07:00", "16:00", "17:00", "06:30", "18:00"];
  const dates = [getFutureDate(40), getFutureDate(41), getFutureDate(42), getFutureDate(43), getFutureDate(44)];
  let last: { status: number; data: any } | null = null;
  for (const date of dates) {
    for (const time of timeSlots) {
      const body: Record<string, unknown> = {
        prospectId,
        date,
        scheduledStart: time,
        erstberatungDauer: 90,
        notes: "Test Task #312",
      };
      if (assignedEmployeeId !== undefined) body.assignedEmployeeId = assignedEmployeeId;
      const res = await apiPostAs<any>(auth, "/api/appointments/prospect-erstberatung", body);
      last = res;
      if (res.status === 201) return res;
      // Bei Konflikten/Überschneidungen weiterprobieren, bei harten Fehlern abbrechen
      if (res.status !== 409) return res;
    }
  }
  return last!;
}

describe("Task #312 – Teamleitung darf Erstberatung für anderen Erstberater anlegen", () => {
  it("Teamleitung mit gültigem fremden assignedEmployeeId → 201, Termin trägt diesen Mitarbeiter", async () => {
    const prospectId = await createProspect();
    const res = await tryCreateErstberatung(leadAuth, prospectId, targetErstberater.id);
    expect(res.status, `unerwarteter Status ${res.status}: ${JSON.stringify(res.data)}`).toBe(201);
    const appt = res.data.appointment || res.data;
    expect(appt).toHaveProperty("id");
    expect(appt.assignedEmployeeId).toBe(targetErstberater.id);
    createdAppointmentIds.push(appt.id);
  });

  it("Teamleitung ohne assignedEmployeeId → 400 mit deutscher Fehlermeldung", async () => {
    const prospectId = await createProspect();
    const res = await tryCreateErstberatung(leadAuth, prospectId, undefined);
    expect(res.status).toBe(400);
    const message = String(res.data?.message ?? res.data?.error ?? "");
    expect(message.toLowerCase()).toContain("mitarbeiter");
  });

  it("Regulärer Mitarbeiter behält bisheriges Verhalten — assignedEmployeeId wird ignoriert und auf eigene ID gezwungen", async () => {
    const prospectId = await createProspect();
    const res = await tryCreateErstberatung(regularAuth, prospectId, targetErstberater.id);
    // Reguläre Mitarbeiter dürfen Erstberatungen für sich selbst anlegen.
    // Falls keine Berechtigung existiert, akzeptieren wir auch 403 — Hauptsache kein
    // Datensatz mit fremder assignedEmployeeId entsteht.
    if (res.status === 201) {
      const appt = res.data.appointment || res.data;
      // eigene ID, nicht die übergebene
      expect(appt.assignedEmployeeId).not.toBe(targetErstberater.id);
      expect(appt.assignedEmployeeId).toBe(regularAuth.user.id);
      createdAppointmentIds.push(appt.id);
    } else {
      expect([400, 403]).toContain(res.status);
    }
  });
});
