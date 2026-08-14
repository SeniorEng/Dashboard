import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  apiGet,
  apiPost,
  apiPostAs,
  apiDelete,
  loginAs,
  getAuthCookie,
  createTestCustomer,
  cleanupCustomer,
  createTestEmployee,
  assignEmployeeToCustomer,
  deactivateTestEmployee,
} from "../test-utils";
import { validSignatureDataUrl } from "../helpers/valid-signature";

/**
 * Task #1906 — Zwei-Kräfte-Einsatz ENTKOPPELN: ein Leg weicht, das andere wird
 * zum Einzeltermin und behält alles, was es hat.
 *
 * `POST /api/appointments/:id/decouple` — `:id` ist das WEICHENDE Leg; den
 * Survivor löst der Server aus der Gruppe auf (der Client kennt die Partner-ID
 * bewusst nicht, siehe Privacy-Invariante an `appointments.co_visit_group_id`).
 *
 * Die Operation zerfällt in zwei Teile, und genau diese Trennung prüfen die
 * Tests hier:
 *   (a) weichendes Leg löschen — unter den UNVERÄNDERTEN Guards des Löschpfads
 *       (Policy, Versiegelung, Storno-first). Entkoppeln ist ausdrücklich KEIN
 *       Weg um Storno-first oder die Versiegelung herum.
 *   (b) Survivor entkoppeln (`co_visit_group_id = NULL`) — reiner Metadaten-
 *       Write, sicher auch am signierten/abgerechneten Leg.
 *
 * Abgrenzung: die Lösch-KASKADE (`DELETE /:id`, all-or-nothing, Task
 * #1615/#1892) bleibt unverändert — ihre Tests stehen in `co-visit.test.ts` und
 * werden hier nicht angefasst.
 *
 * KALENDER-INVARIANTE (wie in `co-visit.test.ts`): jeder anlegende Test nutzt
 * eine EIGENE Uhrzeit, nicht einen eigenen Tag — `getPastWeekday`/`getFutureDate`
 * rollen Wochenenden, wodurch mehrere Offsets auf denselben Kalendertag fallen.
 * Belegte Slots in DIESER Datei (eigene Mitarbeiter-Fixtures, daher unabhängig
 * von den Slots der Schwester-Datei):
 *
 *   00:00 D-1 · 01:00 D-2 · 02:00 D-3 · 03:00 D-4
 *   04:00 D-5 · 05:00 D-6 · 06:00 D-7 · 07:00 D-8 · 08:00 D-5b · 09:00 D-9
 *
 * Die Termine dauern 60 Minuten — die Slots stehen deshalb eine VOLLE Stunde
 * auseinander. Mit 15-Minuten-Abständen überlappten sie sich gegenseitig und
 * der Mitarbeiter-Overlap-Check antwortete 409 statt 201.
 */

let admin: Awaited<ReturnType<typeof getAuthCookie>>;
let empA: { id: number; email: string; password: string };
let empB: { id: number; email: string; password: string };
const customerIds: number[] = [];

function getPastWeekday(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  const dow = d.getDay();
  if (dow === 0) d.setDate(d.getDate() - 2);
  else if (dow === 6) d.setDate(d.getDate() - 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function getAnyService(): Promise<{ id: number }> {
  const list = await apiGet<any[]>("/api/services");
  if (list.status === 200 && Array.isArray(list.data) && list.data.length > 0) {
    const active = list.data.find((s: any) => s.isActive !== false) || list.data[0];
    return { id: active.id as number };
  }
  throw new Error("Kein Service verfügbar (Referenzdaten fehlen)");
}

/** Legt einen Co-Visit in der Vergangenheit an und liefert beide Legs. */
async function createCoVisit(daysAgo: number, time: string) {
  const customer = await createTestCustomer();
  customerIds.push(customer.id as number);
  await assignEmployeeToCustomer(customer.id as number, empA.id);

  const service = await getAnyService();
  const date = getPastWeekday(daysAgo);

  const create = await apiPost<any>("/api/appointments/kundentermin", {
    customerId: customer.id,
    date,
    scheduledStart: time,
    services: [{ serviceId: service.id, durationMinutes: 60 }],
    assignedEmployeeId: empA.id,
    secondAssignedEmployeeId: empB.id,
  });
  expect(create.status, `create failed: ${JSON.stringify(create.data)}`).toBe(201);
  const groupId = create.data.coVisitGroupId as string;

  const list = await apiGet<any[]>(`/api/appointments?date=${date}&customerId=${customer.id}`);
  const legs = list.data.filter((a: any) => a.coVisitGroupId === groupId);
  expect(legs.length).toBe(2);
  return {
    customerId: customer.id as number,
    groupId,
    date,
    serviceId: service.id,
    legA: legs.find((a: any) => a.assignedEmployeeId === empA.id),
    legB: legs.find((a: any) => a.assignedEmployeeId === empB.id),
  };
}

async function documentLeg(id: number, serviceId: number, time: string): Promise<void> {
  const res = await apiPost<any>(`/api/appointments/${id}/document`, {
    actualStart: time,
    travelOriginType: "home",
    travelKilometers: 0,
    customerKilometers: 0,
    services: [{ serviceId, actualDurationMinutes: 60, details: "D-1906" }],
  });
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`documentLeg failed: ${res.status} ${JSON.stringify(res.data)}`);
  }
}

/** Erzeugt einen LN für genau dieses Leg und lässt ihn KUNDENSIGNIEREN. */
async function signLnForLeg(customerId: number, employeeId: number, legId: number, date: string): Promise<number> {
  const d = new Date(date);
  const sr = await apiPost<any>("/api/service-records", {
    customerId,
    employeeId,
    appointmentIds: [legId],
    year: d.getFullYear(),
    month: d.getMonth() + 1,
  });
  if (sr.status !== 201 && sr.status !== 200) {
    throw new Error(`service-record create failed: ${sr.status} ${JSON.stringify(sr.data)}`);
  }
  for (const signerType of ["employee", "customer"] as const) {
    const sig = await apiPost<any>(`/api/service-records/${sr.data.id}/sign`, {
      signerType,
      signatureData: validSignatureDataUrl(),
    });
    if (sig.status !== 200) {
      throw new Error(`sign(${signerType}) failed: ${sig.status} ${JSON.stringify(sig.data)}`);
    }
  }
  return sr.data.id as number;
}

async function fetchAppointment(id: number): Promise<any | null> {
  const res = await apiGet<any>(`/api/appointments/${id}`);
  return res.status === 200 ? res.data : null;
}

beforeAll(async () => {
  admin = await getAuthCookie();
  empA = await createTestEmployee({ nachnamePrefix: "DecoupleA" });
  empB = await createTestEmployee({ nachnamePrefix: "DecoupleB" });
});

afterAll(async () => {
  for (const id of customerIds) {
    try { await cleanupCustomer(id); } catch { /* best effort */ }
  }
  await deactivateTestEmployee(empA.id);
  await deactivateTestEmployee(empB.id);
});

describe("Task #1906 — Co-Visit entkoppeln", () => {
  it("D-1 – intaktes Paar: weichendes Leg weg, Survivor wird Einzeltermin", async () => {
    const { legA, legB } = await createCoVisit(60, "00:00");

    const res = await apiPost<any>(`/api/appointments/${legB.id}/decouple`, {});
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    expect(res.data.removedLegId).toBe(legB.id);
    // Die Antwort nennt die Partner-ID BEWUSST nicht: der Client kennt sie
    // nicht und soll sie nicht kennen (Privacy-Invariante der Gruppen-Spalte).
    expect(res.data.survivingLegId).toBeUndefined();
    expect(res.data.decoupledGroupId).toBeUndefined();

    // Weichendes Leg ist weg …
    expect(await fetchAppointment(legB.id)).toBeNull();
    // … und der Survivor ist entkoppelt: keine Gruppe, kein Partner-Name mehr.
    const survivor = await fetchAppointment(legA.id);
    expect(survivor).not.toBeNull();
    expect(survivor.coVisitGroupId).toBeNull();
    expect(survivor.coVisitPartnerName ?? null).toBeNull();
    expect(survivor.status).toBe("scheduled");
  });

  it("D-2 – Halbzustand: freies Leg weicht, dokumentiert+signiertes bleibt VOLLSTÄNDIG", async () => {
    // Die Form aus der Referenz-DB (Gruppe 8ebcc636…, 21.07.2026): ein Leg
    // dokumentiert und auf einem KUNDENSIGNIERTEN Nachweis, das andere nur
    // geplant. Genau hier scheitert der Löschpfad heute (der signierte Partner
    // bliebe stehen → `APPOINTMENT_CO_VISIT_LOCKED` bzw. stiller Halbzustand).
    const { customerId, legA, legB, date, serviceId } = await createCoVisit(61, "01:00");
    await documentLeg(legA.id, serviceId, "01:00");
    const srId = await signLnForLeg(customerId, empA.id, legA.id, date);

    const res = await apiPost<any>(`/api/appointments/${legB.id}/decouple`, {});
    expect(res.status, JSON.stringify(res.data)).toBe(200);

    const survivor = await fetchAppointment(legA.id);
    expect(survivor.coVisitGroupId).toBeNull();
    // Der Zustand des Survivors ist unangetastet — das ist der Kern des Features.
    expect(survivor.status).toBe("completed");

    // Der unterschriebene Leistungsnachweis bleibt unberührt und gültig.
    const sr = await apiGet<any>(`/api/service-records/${srId}`);
    expect(sr.status).toBe(200);
    expect(sr.data.status).toBe("completed");
    const srAppts = await apiGet<any[]>(`/api/service-records/${srId}/appointments`);
    expect(srAppts.status).toBe(200);
    expect(
      srAppts.data.some((a: any) => a.id === legA.id),
      "signiertes Leg muss im LN bleiben",
    ).toBe(true);
  });

  it("D-3 – signiertes Leg soll weichen, NICHT-Admin: abgelehnt, Kopplung bleibt", async () => {
    const { customerId, legA, legB, date, serviceId } = await createCoVisit(62, "02:00");
    await documentLeg(legA.id, serviceId, "02:00");
    await signLnForLeg(customerId, empA.id, legA.id, date);

    // empA ist die zugewiesene Kraft des versiegelten Legs — die Policy erlaubt
    // ihr das Löschen trotzdem nicht (`isLocked && !adminLike`).
    const asEmpA = await loginAs(empA.email, empA.password);
    const res = await apiPostAs<any>(asEmpA, `/api/appointments/${legA.id}/decouple`, {});
    // Deterministisch 403: die POLICY lehnt ab (`isLocked && !adminLike`), noch
    // vor der Transaktion. Würde hier 409 kommen, hätte die Policy versagt und
    // nur die transaktionale zweite Linie gegriffen — das soll auffallen.
    expect(res.status, JSON.stringify(res.data)).toBe(403);

    // Nichts darf sich bewegt haben — insbesondere ist der PARTNER noch gekoppelt.
    const stillThere = await fetchAppointment(legA.id);
    expect(stillThere).not.toBeNull();
    const partner = await fetchAppointment(legB.id);
    expect(partner.coVisitGroupId).not.toBeNull();
  });

  it("D-4 – signiertes Leg weicht, ADMIN: Korrektur-Zweig (reduktions-only)", async () => {
    const { customerId, legA, legB, date, serviceId } = await createCoVisit(63, "03:00");
    await documentLeg(legA.id, serviceId, "03:00");
    const srId = await signLnForLeg(customerId, empA.id, legA.id, date);

    const res = await apiPost<any>(`/api/appointments/${legA.id}/decouple`, {});
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    expect(res.data.removedLegId).toBe(legA.id);

    expect(await fetchAppointment(legA.id)).toBeNull();
    const survivor = await fetchAppointment(legB.id);
    expect(survivor.coVisitGroupId).toBeNull();

    // Der Nachweis wurde reduktions-only behandelt: das Leg ist heraus. Da er
    // nur dieses eine Leg trug, ist er jetzt leer und wurde entfernt.
    const sr = await apiGet<any>(`/api/service-records/${srId}`);
    expect([404, 200]).toContain(sr.status);
    if (sr.status === 200) {
      const srAppts = await apiGet<any[]>(`/api/service-records/${srId}/appointments`);
      const stillLinked = (srAppts.data ?? []).some((a: any) => a.id === legA.id);
      expect(stillLinked, "entferntes Leg darf nicht mehr im LN hängen").toBe(false);
    }
  });

  it("D-5 – VERWAISTE Gruppe (Leg trägt die Gruppe, Partner soft-gelöscht): abgelehnt, kein 500", async () => {
    // Der echte Verwaisten-Zustand — nicht der entkoppelte Survivor. Er
    // entsteht über den Kaskaden-Skip im Löschpfad: ein Partner mit EIGENEM
    // Ausgang (hier `completed`) bleibt beim Löschen stehen, und
    // `co_visit_group_id` wird dabei nirgends genullt. Genau diesen Zustand
    // beschreibt der Code-Kommentar als in Prod vorhanden.
    const { legA, legB, serviceId } = await createCoVisit(64, "04:00");
    await documentLeg(legA.id, serviceId, "04:00");

    // legB löschen: legA ist `completed`, wird also NICHT mitkaskadiert und
    // behält seine Gruppen-ID — ohne lebenden Partner.
    const del = await apiDelete(`/api/appointments/${legB.id}`);
    expect(del.status, JSON.stringify(del.data)).toBe(200);

    const orphan = await fetchAppointment(legA.id);
    expect(orphan).not.toBeNull();
    expect(orphan.coVisitGroupId, "Vorbedingung: Gruppe bleibt am Waisen").not.toBeNull();

    // Entkoppeln muss hier sauber ablehnen — es gibt nichts zu entkoppeln.
    const res = await apiPost<any>(`/api/appointments/${legA.id}/decouple`, {});
    expect([400, 409]).toContain(res.status);
    expect(res.status).not.toBe(500);
  });

  it("D-5b – entkoppelter Survivor ist kein Co-Visit mehr", async () => {
    const { legA, legB } = await createCoVisit(68, "08:00");
    expect((await apiPost<any>(`/api/appointments/${legB.id}/decouple`, {})).status).toBe(200);
    const second = await apiPost<any>(`/api/appointments/${legA.id}/decouple`, {});
    expect(second.status).toBe(400);
  });

  it("D-6 – Einzeltermin: abgelehnt (kein zweiter Löschpfad)", async () => {
    const customer = await createTestCustomer();
    customerIds.push(customer.id as number);
    await assignEmployeeToCustomer(customer.id as number, empA.id);
    const service = await getAnyService();
    const date = getPastWeekday(65);
    const create = await apiPost<any>("/api/appointments/kundentermin", {
      customerId: customer.id,
      date,
      scheduledStart: "05:00",
      services: [{ serviceId: service.id, durationMinutes: 60 }],
      assignedEmployeeId: empA.id,
    });
    expect(create.status).toBe(201);

    const res = await apiPost<any>(`/api/appointments/${create.data.id}/decouple`, {});
    expect(res.status).toBe(400);
    // Der Termin existiert unverändert weiter.
    expect(await fetchAppointment(create.data.id)).not.toBeNull();
  });

  it("D-7 – GoBD: abgerechnetes Leg weicht NICHT ohne Storno (kein Weg drumherum)", async () => {
    const { customerId, legA, legB, date, serviceId } = await createCoVisit(66, "06:00");
    await documentLeg(legA.id, serviceId, "06:00");
    await signLnForLeg(customerId, empA.id, legA.id, date);

    const d = new Date(date);
    const gen = await apiPost<any>("/api/billing/generate", {
      customerId,
      billingMonth: d.getMonth() + 1,
      billingYear: d.getFullYear(),
    });
    // Nur weiterprüfen, wenn wirklich eine Rechnung entstand — sonst prüft der
    // Test nicht, was er behauptet.
    expect(gen.status, `generate failed: ${JSON.stringify(gen.data)}`).toBe(200);

    const res = await apiPost<any>(`/api/appointments/${legA.id}/decouple`, {});
    expect(res.status).toBe(409);
    expect(String(res.data?.code ?? "")).toBe("APPOINTMENT_INVOICED");

    // Rollback: weder ist das Leg weg, noch ist der Partner entkoppelt.
    expect(await fetchAppointment(legA.id)).not.toBeNull();
    const partner = await fetchAppointment(legB.id);
    expect(partner.coVisitGroupId).not.toBeNull();
  });

  it("D-9 – GoBD: abgerechnet, aber NICHT mehr versiegelt → trotzdem abgelehnt", async () => {
    // Der Zustand, den der Versiegelungs-Zweig NICHT abdeckt: Rechnung aktiv,
    // Leistungsnachweis aber über die Admin-Route zurückgesetzt. Läge der
    // Storno-first-Guard (wie im Löschpfad) INNERHALB der Versiegelungs-
    // Prüfung, würde hier das Budget zurückgebucht, während die gestellte
    // Rechnung den Verbrauch weiter ausweist. Der Guard steht deshalb
    // unbedingt davor — das hält dieser Test fest.
    const { customerId, legA, legB, date, serviceId } = await createCoVisit(69, "09:00");
    await documentLeg(legA.id, serviceId, "09:00");
    const srId = await signLnForLeg(customerId, empA.id, legA.id, date);

    const d = new Date(date);
    const gen = await apiPost<any>("/api/billing/generate", {
      customerId,
      billingMonth: d.getMonth() + 1,
      billingYear: d.getFullYear(),
    });
    expect(gen.status, `generate failed: ${JSON.stringify(gen.data)}`).toBe(200);

    // Versiegelung VOLLSTÄNDIG aufheben — die Rechnung bleibt bestehen.
    // Beide Unterschriften müssen weg: `lockAndCheckAppointmentLocked` wertet
    // `employee_signed` UND `completed` als versiegelt, ein Zurücknehmen nur
    // der Kundenunterschrift lässt den Nachweis also gesperrt (und der Test
    // wäre auch mit dem alten, bedingten Guard grün gewesen — gemessen).
    for (const signerType of ["customer", "employee"] as const) {
      const revoke = await apiPost<any>(`/api/admin/revoke-signature/service_record/${srId}`, {
        signerType,
        reason: "D-9: Versiegelung aufheben, Rechnung bleibt",
      });
      expect(revoke.status, `revoke(${signerType}) failed: ${JSON.stringify(revoke.data)}`).toBe(200);
    }
    const srAfter = await apiGet<any>(`/api/service-records/${srId}`);
    expect(srAfter.data.status, "Vorbedingung: Nachweis darf NICHT mehr versiegelt sein")
      .not.toMatch(/^(employee_signed|completed)$/);

    const res = await apiPost<any>(`/api/appointments/${legA.id}/decouple`, {});
    expect(res.status, JSON.stringify(res.data)).toBe(409);
    expect(String(res.data?.code ?? "")).toBe("APPOINTMENT_INVOICED");

    // Nichts bewegt: Leg da, Partner weiter gekoppelt.
    expect(await fetchAppointment(legA.id)).not.toBeNull();
    expect((await fetchAppointment(legB.id)).coVisitGroupId).not.toBeNull();
  });

  it("D-8 – zwei gleichzeitige Entkopplungen aus entgegengesetzter Richtung: genau eine gewinnt", async () => {
    // Beide Aufrufe sperren dieselben zwei Termin-Zeilen. Weil
    // `lockAppointmentsForUpdate` intern nach `id` sortiert, ist die
    // Sperr-Reihenfolge unabhängig davon, welches Leg weicht — es kann kein
    // ABBA-Deadlock entstehen (die Inversion aus dem Löschpfad wird NICHT
    // geerbt). Genau eine Seite gewinnt, die andere findet keinen Partner mehr.
    const { legA, legB } = await createCoVisit(67, "07:00");

    const [resA, resB] = await Promise.all([
      apiPost<any>(`/api/appointments/${legA.id}/decouple`, {}),
      apiPost<any>(`/api/appointments/${legB.id}/decouple`, {}),
    ]);

    const statuses = [resA.status, resB.status].sort();
    expect(statuses.filter((s) => s === 200).length, `A=${resA.status} B=${resB.status}`).toBe(1);
    // Der Verlierer scheitert FACHLICH (409: die Gruppe wurde inzwischen
    // aufgelöst) — nicht mit einem Deadlock und nicht mit 500. Die Ablehnung
    // kommt aus der Prüfung HINTER der Gruppen-Sperre; vor dem Fix liefen beide
    // Aufrufe durch und löschten am Ende BEIDE Legs.
    const loser = [resA, resB].find((r) => r.status !== 200)!;
    expect([400, 404, 409], `Verlierer-Status ${loser.status}`).toContain(loser.status);
    expect(loser.status).not.toBe(500);

    // Genau ein Leg hat überlebt, und es ist entkoppelt.
    const [a, b] = [await fetchAppointment(legA.id), await fetchAppointment(legB.id)];
    const alive = [a, b].filter(Boolean);
    expect(alive.length).toBe(1);
    expect(alive[0].coVisitGroupId).toBeNull();
  });
});
