/**
 * Task #379 — Travel-Suggestion-Scoping: für einen Termin darf nur ein Termin
 * DERSELBEN Mitarbeiterin als Vorgänger vorgeschlagen werden.
 *
 * ── Kontaminations-Härtung (Long-List 6hHGVqq95FjVVm7G) ─────────────────
 * Der Seed suchte ab Offset 30 den ersten Tag, an dem er ZWEI Termine anlegen
 * kann, und unterstellte dann, dort liege kein früherer Termin des eigenen
 * (Admin-)Users. In der geteilten Shard-DB — in CI ~185 Dateien pro Leg — ist
 * das keine Zusage, die er einfordern kann: irgendeine andere Datei seedet
 * einen Admin-Termin auf denselben Tag, `travel-suggestion` schlägt ihn völlig
 * korrekt als Vorgänger vor, und der Test meldet einen Scoping-Fehler, den es
 * nicht gibt. Die Prüfbedingung („zwei Termine anlegbar") deckte die Annahme
 * („kein eigener Termin an dem Tag") nicht ab.
 *
 * Gemessen vor der Härtung, Shard-1-Präfix von 51 Dateien in EINER geteilten
 * DB, je 6 Läufe: `main` 2/6 rot, PR-Branch 4/6 rot — beide Seiten, gleiche
 * Signatur (`expected 'appointment' to be 'home'`). In CI ist die Rate höher
 * (185 statt 51 Dateien), dort war `tests-shard (1)` zweimal in Folge rot.
 *
 * Zwei Lagen dagegen:
 *  1. Der Tag wird VOR der Anlage auf eigene Termine geprüft (`hatEigenenTermin`)
 *     und sonst übersprungen.
 *  2. Nach der Anlage steht eine Zusicherung, die eine Kontamination als solche
 *     BENENNT, statt sie als Scoping-Fehler erscheinen zu lassen.
 *
 * Warum nicht einfach ein frisch angelegter Mitarbeiter statt des geteilten
 * Admins: der Prüfgegenstand IST der Admin-Fall („eigener Admin-Termin", und
 * weiter unten „Admin dokumentiert den Termin einer anderen Mitarbeiterin").
 * Der Test mit `nonAdminId` als eigenem Mitarbeiter wäre stabil, würde aber
 * etwas anderes messen. Deshalb Tag härten statt Rolle tauschen.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  apiGet,
  apiPost,
  apiDelete,
  apiPatch,
  getAuthCookie,
  createTestEmployee,
  createTestCustomer,
  cleanupCustomer,
  deactivateTestEmployee,
} from "../test-utils";

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
let nonAdminId: number;
let customerId: number;
let hwServiceId: number;
const createdApptIds: number[] = [];

function nextWeekday(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const dow = d.getDay();
  if (dow === 0) d.setDate(d.getDate() + 1);
  else if (dow === 6) d.setDate(d.getDate() + 2);
  return d.toISOString().split("T")[0];
}

/**
 * IDs aller Termine, die am `date` dem EIGENEN (authentifizierten Admin-)User
 * zugewiesen sind.
 *
 * Bewusst die firmenweite Admin-Sicht (`?date=` ohne `viewAsEmployeeId`) plus
 * clientseitiger Filter: `viewAsEmployeeId` kombiniert im Backend den
 * Mitarbeiter- MIT einem Primärkunden-Filter
 * (`server/routes/appointments.ts:422-424`) und wäre für eine Vorbedingung zu
 * subtil — es könnte Termine übersehen, die genau den Fehlschlag auslösen.
 *
 * ── Der Filter spiegelt die Produktivlogik, nicht die Intuition ─────────
 * `assignedEmployeeId` ODER `performedByEmployeeId`. Der Vorgänger-Pool wird in
 * `server/routes/appointments.ts:1591` über
 * `getAppointmentsWithCustomers(date, undefined, targetEmployeeId)` gebaut; mit
 * `assignedOnly = undefined` liefert `buildEmployeeCondition`
 * (`server/storage/appointments-storage.ts:101`) genau
 * `or(assignedEmployeeId = X, performedByEmployeeId = X)`. Eine Vorprüfung, die
 * nur `assignedEmployeeId` kennt, übersieht deshalb genau die Termine, gegen
 * die sie schützen soll — der Test wäre weiterhin instabil, nur seltener.
 *
 * Nicht gefiltert werden muss dagegen nach `deleted_at` und `cancelled`: beide
 * schließt schon `getAppointmentsWithCustomers` aus
 * (`appointments-storage.ts:195`), auf beiden Seiten identisch.
 */
async function eigeneTermineAm(date: string): Promise<number[]> {
  const res = await apiGet<
    Array<{ id: number; assignedEmployeeId: number | null; performedByEmployeeId: number | null }>
  >(`/api/appointments?date=${date}`);
  if (res.status !== 200 || !Array.isArray(res.data)) return [];
  return res.data
    .filter((a) => a.assignedEmployeeId === auth.user.id || a.performedByEmployeeId === auth.user.id)
    .map((a) => a.id);
}

async function hatEigenenTermin(date: string): Promise<boolean> {
  return (await eigeneTermineAm(date)).length > 0;
}

async function tryCreate(date: string, time: string, employeeId: number, duration = 30): Promise<number | null> {
  const res = await apiPost<any>("/api/appointments/kundentermin", {
    customerId,
    date,
    scheduledStart: time,
    services: [{ serviceId: hwServiceId, durationMinutes: duration }],
    assignedEmployeeId: employeeId,
  });
  if (res.status === 201) {
    createdApptIds.push(res.data.id);
    return res.data.id;
  }
  return null;
}

describe("Travel-Suggestion Scoping (Task #379)", () => {
  let adminApptId: number;
  let foreignApptId: number;
  let appointmentDate: string;

  beforeAll(async () => {
    auth = await getAuthCookie();
    if (!auth.user.isAdmin) throw new Error("Default test user must be admin for this test.");

    const services = await apiGet<any[]>("/api/services/all");
    hwServiceId = services.data.find((s: any) => s.code === "hauswirtschaft")!.id;

    const emp = await createTestEmployee({ nachnamePrefix: "TravelScope" });
    nonAdminId = emp.id;

    const cust = await createTestCustomer({ nachname: `TravelScope_${Date.now()}` });
    customerId = cust.id as number;

    const assignRes = await apiPatch(`/api/admin/customers/${customerId}/assign`, {
      primaryEmployeeId: auth.user.id,
      backupEmployeeId: nonAdminId,
      backupEmployeeId2: null,
    });
    expect(assignRes.status).toBe(200);

    let foreign: number | null = null;
    let admin: number | null = null;
    const uebersprungen: string[] = [];
    for (let off = 30; off <= 120 && (!foreign || !admin); off++) {
      const d = nextWeekday(off);

      // Der Tag muss FREI von eigenen Terminen sein, bevor wir ihn nehmen —
      // sonst prüft der Test Fremddaten statt Scoping (siehe Docstring oben).
      if (await hatEigenenTermin(d)) {
        uebersprungen.push(d);
        continue;
      }

      const f = await tryCreate(d, "09:00", nonAdminId);
      if (!f) continue;
      const a = await tryCreate(d, "10:00", auth.user.id);
      if (!a) {
        await apiDelete(`/api/appointments/${f}`);
        continue;
      }
      foreign = f;
      admin = a;
      appointmentDate = d;
    }
    if (!foreign || !admin) {
      throw new Error(
        "Konnte keinen passenden Slot finden. Übersprungen wegen bereits " +
          `vorhandener eigener Termine: ${uebersprungen.length} Tage ` +
          `(${uebersprungen.slice(0, 5).join(", ")}${uebersprungen.length > 5 ? " …" : ""}).`,
      );
    }

    // Zusicherung statt Annahme: der gewählte Tag trägt außer unseren beiden
    // Terminen keinen weiteren des eigenen Users. Schlägt das an, hat zwischen
    // Prüfung und Anlage eine andere Datei dazwischengefunkt — dann soll der
    // Test das SAGEN und nicht als Scoping-Fehler erscheinen.
    const eigeneAmTag = await eigeneTermineAm(appointmentDate);
    expect(
      eigeneAmTag.filter((id) => id !== admin).length,
      `Am gewählten Tag ${appointmentDate} existieren weitere Termine des eigenen ` +
        `Users (${eigeneAmTag.join(", ")}). Das ist KEIN Scoping-Fehler, sondern ` +
        "Kontamination aus einer anderen Testdatei derselben Shard-DB — der " +
        "Vorbedingungs-Check oben hat sie nicht mehr gesehen.",
    ).toBe(0);
    foreignApptId = foreign;
    adminApptId = admin;
  });

  afterAll(async () => {
    for (const id of createdApptIds) {
      try { await apiDelete(`/api/appointments/${id}`); } catch {}
    }
    await cleanupCustomer(customerId);
    await deactivateTestEmployee(nonAdminId);
  });

  it("schlägt für eigenen Admin-Termin keinen fremden Termin als Vorgänger vor", async () => {
    const res = await apiGet<any>(`/api/appointments/${adminApptId}/travel-suggestion`);
    expect(res.status).toBe(200);
    expect(res.data.suggestedOrigin).toBe("home");
    expect(res.data.previousAppointmentId).toBeNull();
  });

  it("route-calculation lehnt fremde fromAppointmentId ab", async () => {
    const res = await apiGet<any>(
      `/api/appointments/${adminApptId}/route-calculation?originType=appointment&fromAppointmentId=${foreignApptId}`
    );
    expect(res.status).toBe(400);
  });

  it("Admin, der Termin einer anderen Mitarbeiterin dokumentiert, sieht nur deren Termine als Vorgänger-Pool", async () => {
    const res = await apiGet<any>(`/api/appointments/${foreignApptId}/travel-suggestion`);
    expect(res.status).toBe(200);
    expect(res.data.suggestedOrigin).toBe("home");
    expect(res.data.previousAppointmentId).toBeNull();
  });

  it("route-calculation akzeptiert eine fromAppointmentId derselben Mitarbeiterin", async () => {
    let secondId: number | null = null;
    for (const time of ["11:00", "11:30", "12:00", "12:30"]) {
      secondId = await tryCreate(appointmentDate, time, nonAdminId);
      if (secondId) break;
    }
    if (!secondId) throw new Error("Konnte keinen zweiten Termin für nonAdmin anlegen");
    const res = await apiGet<any>(
      `/api/appointments/${secondId}/route-calculation?originType=appointment&fromAppointmentId=${foreignApptId}`
    );
    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty("suggestedKilometers");
    expect(res.data).toHaveProperty("suggestedMinutes");
  });
});
