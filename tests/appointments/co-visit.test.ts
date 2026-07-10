import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  apiGet,
  apiPost,
  apiPatch,
  apiDelete,
  apiGetAs,
  loginAs,
  getAuthCookie,
  createTestCustomer,
  cleanupCustomer,
  createTestEmployee,
  assignEmployeeToCustomer,
  deactivateTestEmployee,
  getFutureDate,
} from "../test-utils";
import { validSignatureDataUrl } from "../helpers/valid-signature";

/**
 * Task #1613 — Zwei-Kräfte-Einsatz (Co-Visit).
 *
 * Ein Kundentermin kann mit einem ZWEITEN Mitarbeiter gebucht werden. Es
 * entstehen ZWEI verknüpfte Termine (gemeinsame coVisitGroupId, je ein
 * Mitarbeiter). Beide Legs sind voll eigenständig; die einzige echte
 * Sonderregel ist eine Kunden-Overlap-Ausnahme für das Paar. Employee-Overlap
 * bleibt hart.
 */

async function getAnyService(): Promise<{ id: number }> {
  const list = await apiGet<any[]>("/api/services");
  if (list.status === 200 && Array.isArray(list.data) && list.data.length > 0) {
    const active = list.data.find((s: any) => s.isActive !== false) || list.data[0];
    return { id: active.id as number };
  }
  throw new Error("Kein Service verfügbar (Referenzdaten fehlen)");
}

let empA: { id: number; email: string; password: string } | null = null;
let empB: { id: number; email: string; password: string } | null = null;
let empInactive: { id: number } | null = null;
const customerIds: number[] = [];

beforeAll(async () => {
  await getAuthCookie();
  empA = await createTestEmployee({ nachnamePrefix: "CoVisitA" });
  empB = await createTestEmployee({ nachnamePrefix: "CoVisitB" });
  empInactive = await createTestEmployee({ nachnamePrefix: "CoVisitInactive" });
});

afterAll(async () => {
  for (const id of customerIds) await cleanupCustomer(id);
  await deactivateTestEmployee(empA?.id);
  await deactivateTestEmployee(empB?.id);
  await deactivateTestEmployee(empInactive?.id);
});

describe("CV-1: Zwei-Kräfte-Einsatz Anlage", () => {
  it("CV-1.1 – erzeugt zwei verknüpfte Termine mit gemeinsamer coVisitGroupId, je ein Mitarbeiter", async () => {
    const customer = await createTestCustomer();
    customerIds.push(customer.id as number);
    await assignEmployeeToCustomer(customer.id as number, empA!.id);

    const service = await getAnyService();
    const date = getFutureDate(20);

    const res = await apiPost<any>("/api/appointments/kundentermin", {
      customerId: customer.id,
      date,
      scheduledStart: "09:00",
      services: [{ serviceId: service.id, durationMinutes: 60 }],
      assignedEmployeeId: empA!.id,
      secondAssignedEmployeeId: empB!.id,
    });
    expect(res.status).toBe(201);
    expect(res.data.coVisitGroupId).toBeTruthy();

    const list = await apiGet<any[]>(`/api/appointments?date=${date}&customerId=${customer.id}`);
    expect(list.status).toBe(200);
    const legs = list.data.filter((a: any) => a.coVisitGroupId === res.data.coVisitGroupId);
    expect(legs.length).toBe(2);

    const employeeIds = legs.map((a: any) => a.assignedEmployeeId).sort();
    expect(employeeIds).toEqual([empA!.id, empB!.id].sort());
    // Beide teilen exakt dieselbe Gruppe.
    expect(new Set(legs.map((a: any) => a.coVisitGroupId)).size).toBe(1);
  });

  it("CV-1.2 – Einzeltermin (ohne zweite Kraft) bleibt unverändert, coVisitGroupId = null", async () => {
    const customer = await createTestCustomer();
    customerIds.push(customer.id as number);
    await assignEmployeeToCustomer(customer.id as number, empA!.id);

    const service = await getAnyService();
    const date = getFutureDate(21);

    const res = await apiPost<any>("/api/appointments/kundentermin", {
      customerId: customer.id,
      date,
      scheduledStart: "09:00",
      services: [{ serviceId: service.id, durationMinutes: 60 }],
      assignedEmployeeId: empA!.id,
    });
    expect(res.status).toBe(201);
    expect(res.data.coVisitGroupId).toBeNull();
  });

  it("CV-1.3 – gleiche Kraft zweimal wird abgelehnt (400)", async () => {
    const customer = await createTestCustomer();
    customerIds.push(customer.id as number);
    await assignEmployeeToCustomer(customer.id as number, empA!.id);

    const service = await getAnyService();
    const date = getFutureDate(22);

    const res = await apiPost<any>("/api/appointments/kundentermin", {
      customerId: customer.id,
      date,
      scheduledStart: "09:00",
      services: [{ serviceId: service.id, durationMinutes: 60 }],
      assignedEmployeeId: empA!.id,
      secondAssignedEmployeeId: empA!.id,
    });
    expect(res.status).toBe(400);
  });

  it("CV-1.4 – inaktive zweite Kraft wird abgelehnt (400)", async () => {
    const customer = await createTestCustomer();
    customerIds.push(customer.id as number);
    await assignEmployeeToCustomer(customer.id as number, empA!.id);

    const service = await getAnyService();
    const date = getFutureDate(23);
    await deactivateTestEmployee(empInactive!.id);

    const res = await apiPost<any>("/api/appointments/kundentermin", {
      customerId: customer.id,
      date,
      scheduledStart: "09:00",
      services: [{ serviceId: service.id, durationMinutes: 60 }],
      assignedEmployeeId: empA!.id,
      secondAssignedEmployeeId: empInactive!.id,
    });
    expect(res.status).toBe(400);
  });
});

describe("CV-2: Overlap-Regeln", () => {
  it("CV-2.1 – Employee-Overlap bleibt HART: zweite Kraft bereits gebucht => 409", async () => {
    const otherCustomer = await createTestCustomer();
    customerIds.push(otherCustomer.id as number);
    await assignEmployeeToCustomer(otherCustomer.id as number, empB!.id);

    const service = await getAnyService();
    const date = getFutureDate(24);

    // empB hat bereits einen eigenen Termin um 09:00.
    const pre = await apiPost<any>("/api/appointments/kundentermin", {
      customerId: otherCustomer.id,
      date,
      scheduledStart: "09:00",
      services: [{ serviceId: service.id, durationMinutes: 60 }],
      assignedEmployeeId: empB!.id,
    });
    expect(pre.status).toBe(201);

    // Co-Visit für einen ANDEREN Kunden mit empA + empB zur selben Zeit muss am
    // Employee-Overlap von empB scheitern.
    const customer = await createTestCustomer();
    customerIds.push(customer.id as number);
    await assignEmployeeToCustomer(customer.id as number, empA!.id);

    const res = await apiPost<any>("/api/appointments/kundentermin", {
      customerId: customer.id,
      date,
      scheduledStart: "09:00",
      services: [{ serviceId: service.id, durationMinutes: 60 }],
      assignedEmployeeId: empA!.id,
      secondAssignedEmployeeId: empB!.id,
    });
    expect(res.status).toBe(409);
  });

  it("CV-2.2 – Umplanen eines Legs bleibt trotz Partner-Overlap gültig (Kunden-Ausnahme greift auch beim Bearbeiten)", async () => {
    const customer = await createTestCustomer();
    customerIds.push(customer.id as number);
    await assignEmployeeToCustomer(customer.id as number, empA!.id);

    const service = await getAnyService();
    const date = getFutureDate(25);

    const create = await apiPost<any>("/api/appointments/kundentermin", {
      customerId: customer.id,
      date,
      scheduledStart: "09:00",
      services: [{ serviceId: service.id, durationMinutes: 60 }],
      assignedEmployeeId: empA!.id,
      secondAssignedEmployeeId: empB!.id,
    });
    expect(create.status).toBe(201);

    const list = await apiGet<any[]>(`/api/appointments?date=${date}&customerId=${customer.id}`);
    const legA = list.data.find((a: any) => a.coVisitGroupId === create.data.coVisitGroupId && a.assignedEmployeeId === empA!.id);
    expect(legA).toBeTruthy();

    // Leg A auf 09:15 verschieben — überschneidet weiterhin Leg B (09:00) für
    // denselben Kunden. Die Co-Visit-Kunden-Ausnahme muss auch hier greifen.
    const patch = await apiPatch<any>(`/api/appointments/${legA.id}`, {
      scheduledStart: "09:15",
    });
    expect(patch.status).toBe(200);
  });
});

describe("CV-4: Absage-/Löschung-Kaskade (Task #1615)", () => {
  async function createCoVisit(dayOffset: number): Promise<{ customerId: number; groupId: string; legA: any; legB: any; date: string }> {
    const customer = await createTestCustomer();
    customerIds.push(customer.id as number);
    await assignEmployeeToCustomer(customer.id as number, empA!.id);

    const service = await getAnyService();
    const date = getFutureDate(dayOffset);

    const create = await apiPost<any>("/api/appointments/kundentermin", {
      customerId: customer.id,
      date,
      scheduledStart: "10:00",
      services: [{ serviceId: service.id, durationMinutes: 60 }],
      assignedEmployeeId: empA!.id,
      secondAssignedEmployeeId: empB!.id,
    });
    expect(create.status).toBe(201);
    const groupId = create.data.coVisitGroupId as string;

    const list = await apiGet<any[]>(`/api/appointments?date=${date}&customerId=${customer.id}`);
    const legs = list.data.filter((a: any) => a.coVisitGroupId === groupId);
    expect(legs.length).toBe(2);
    const legA = legs.find((a: any) => a.assignedEmployeeId === empA!.id);
    const legB = legs.find((a: any) => a.assignedEmployeeId === empB!.id);
    return { customerId: customer.id as number, groupId, legA, legB, date };
  }

  it("CV-4.1 – Absage eines Legs sagt den Partner-Leg mit ab (kein halb-abgesagter Einsatz)", async () => {
    const { groupId, legA, legB, date, customerId } = await createCoVisit(40);

    const patch = await apiPatch<any>(`/api/appointments/${legA.id}`, { status: "cancelled" });
    expect(patch.status).toBe(200);

    // Beide Legs müssen jetzt storniert sein.
    const list = await apiGet<any[]>(`/api/appointments?date=${date}&customerId=${customerId}&includeAll=true`);
    const legs = list.data.filter((a: any) => a.coVisitGroupId === groupId);
    // Falls die Liste stornierte ausblendet, prüfen wir die Legs einzeln.
    const [a, b] = await Promise.all([
      apiGet<any>(`/api/appointments/${legA.id}`),
      apiGet<any>(`/api/appointments/${legB.id}`),
    ]);
    expect(a.data.status).toBe("cancelled");
    expect(b.data.status).toBe("cancelled");
    void legs;
  });

  it("CV-4.2 – Löschen eines Legs löscht den Partner-Leg mit", async () => {
    const { legA, legB } = await createCoVisit(41);

    const del = await apiDelete(`/api/appointments/${legA.id}`);
    expect(del.status).toBe(200);
    expect((del.data as any).coVisitCascadedLegIds).toContain(legB.id);

    // Beide Legs sind weg (404).
    const [a, b] = await Promise.all([
      apiGet<any>(`/api/appointments/${legA.id}`),
      apiGet<any>(`/api/appointments/${legB.id}`),
    ]);
    expect(a.status).toBe(404);
    expect(b.status).toBe(404);
  });

  it("CV-4.3 – Einzeltermin ohne Partner löscht ohne Kaskade", async () => {
    const customer = await createTestCustomer();
    customerIds.push(customer.id as number);
    await assignEmployeeToCustomer(customer.id as number, empA!.id);
    const service = await getAnyService();
    const date = getFutureDate(42);

    const create = await apiPost<any>("/api/appointments/kundentermin", {
      customerId: customer.id,
      date,
      scheduledStart: "10:00",
      services: [{ serviceId: service.id, durationMinutes: 60 }],
      assignedEmployeeId: empA!.id,
    });
    expect(create.status).toBe(201);

    const del = await apiDelete(`/api/appointments/${create.data.id}`);
    expect(del.status).toBe(200);
    expect((del.data as any).coVisitCascadedLegIds).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // Task #1620 — Ein Partner-Leg mit eigenem, echtem Ausgang (completed) oder
  // auf einem unterschriebenen (versiegelten) Leistungsnachweis bleibt von der
  // Absage-/Löschung-Kaskade UNANGETASTET. Das ist GoBD-korrekt und ein legitimes
  // reales Ergebnis (ein halb-durchgeführter Einsatz). Der handelnde Leg
  // storniert/löscht trotzdem sauber, ohne Fehler und ohne den versiegelten
  // Partner still stillschweigend mit-zu-mutieren.
  // ---------------------------------------------------------------------------

  // Vergangene Werktags-Datum (dokumentieren/unterschreiben verlangt einen
  // nicht in der Zukunft liegenden Termin).
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

  async function createPastCoVisit(daysAgo: number): Promise<{ customerId: number; groupId: string; legA: any; legB: any; date: string; serviceId: number }> {
    const customer = await createTestCustomer();
    customerIds.push(customer.id as number);
    await assignEmployeeToCustomer(customer.id as number, empA!.id);

    const service = await getAnyService();
    const date = getPastWeekday(daysAgo);

    const create = await apiPost<any>("/api/appointments/kundentermin", {
      customerId: customer.id,
      date,
      scheduledStart: "10:00",
      services: [{ serviceId: service.id, durationMinutes: 60 }],
      assignedEmployeeId: empA!.id,
      secondAssignedEmployeeId: empB!.id,
    });
    expect(create.status, `create failed: ${JSON.stringify(create.data)}`).toBe(201);
    const groupId = create.data.coVisitGroupId as string;

    const list = await apiGet<any[]>(`/api/appointments?date=${date}&customerId=${customer.id}`);
    const legs = list.data.filter((a: any) => a.coVisitGroupId === groupId);
    expect(legs.length).toBe(2);
    const legA = legs.find((a: any) => a.assignedEmployeeId === empA!.id);
    const legB = legs.find((a: any) => a.assignedEmployeeId === empB!.id);
    return { customerId: customer.id as number, groupId, legA, legB, date, serviceId: service.id };
  }

  async function documentLeg(id: number, serviceId: number): Promise<void> {
    const res = await apiPost<any>(`/api/appointments/${id}/document`, {
      actualStart: "10:00",
      travelOriginType: "home",
      travelKilometers: 0,
      customerKilometers: 0,
      services: [{ serviceId, actualDurationMinutes: 60, details: "CV-1620" }],
    });
    if (res.status !== 200 && res.status !== 201) {
      throw new Error(`documentLeg failed: ${res.status} ${JSON.stringify(res.data)}`);
    }
  }

  async function signLnForLeg(customerId: number, employeeId: number, legId: number, date: string): Promise<void> {
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
        throw new Error(`service-record sign(${signerType}) failed: ${sig.status} ${JSON.stringify(sig.data)}`);
      }
    }
  }

  it("CV-4.4 – Absage: abgeschlossener Partner-Leg bleibt unverändert, handelnder Leg storniert", async () => {
    const { legA, legB, serviceId } = await createPastCoVisit(40);

    // Partner-Leg B abschließen (completed) — eigener echter Ausgang.
    await documentLeg(legB.id, serviceId);
    const beforeB = await apiGet<any>(`/api/appointments/${legB.id}`);
    expect(beforeB.data.status).toBe("completed");

    // Leg A absagen.
    const patch = await apiPatch<any>(`/api/appointments/${legA.id}`, { status: "cancelled" });
    expect(patch.status, `patch failed: ${JSON.stringify(patch.data)}`).toBe(200);

    const [a, b] = await Promise.all([
      apiGet<any>(`/api/appointments/${legA.id}`),
      apiGet<any>(`/api/appointments/${legB.id}`),
    ]);
    // Handelnder Leg ist storniert, abgeschlossener Partner UNVERÄNDERT.
    expect(a.data.status).toBe("cancelled");
    expect(b.data.status).toBe("completed");
  });

  it("CV-4.5 – Absage: Partner-Leg mit unterschriebenem LN (versiegelt) bleibt unangetastet", async () => {
    const { customerId, legA, legB, date, serviceId } = await createPastCoVisit(43);

    // Partner-Leg B dokumentieren + LN beidseitig unterschreiben (versiegelt/locked).
    await documentLeg(legB.id, serviceId);
    await signLnForLeg(customerId, empB!.id, legB.id, date);

    const patch = await apiPatch<any>(`/api/appointments/${legA.id}`, { status: "cancelled" });
    expect(patch.status, `patch failed: ${JSON.stringify(patch.data)}`).toBe(200);

    const [a, b] = await Promise.all([
      apiGet<any>(`/api/appointments/${legA.id}`),
      apiGet<any>(`/api/appointments/${legB.id}`),
    ]);
    expect(a.data.status).toBe("cancelled");
    // Versiegelter Partner darf NICHT storniert werden.
    expect(b.data.status).toBe("completed");
  });

  it("CV-4.6 – Löschen: abgeschlossener Partner-Leg bleibt bestehen, handelnder Leg wird gelöscht", async () => {
    const { legA, legB, serviceId } = await createPastCoVisit(46);

    await documentLeg(legB.id, serviceId);

    const del = await apiDelete(`/api/appointments/${legA.id}`);
    expect(del.status, `delete failed: ${JSON.stringify(del.data)}`).toBe(200);
    // Der abgeschlossene Partner darf NICHT mitkaskadiert werden.
    expect((del.data as any).coVisitCascadedLegIds ?? []).not.toContain(legB.id);

    const [a, b] = await Promise.all([
      apiGet<any>(`/api/appointments/${legA.id}`),
      apiGet<any>(`/api/appointments/${legB.id}`),
    ]);
    expect(a.status).toBe(404);
    expect(b.status).toBe(200);
    expect(b.data.status).toBe("completed");
  });

  it("CV-4.7 – Löschen: Partner-Leg mit unterschriebenem LN (versiegelt) bleibt bestehen", async () => {
    const { customerId, legA, legB, date, serviceId } = await createPastCoVisit(49);

    await documentLeg(legB.id, serviceId);
    await signLnForLeg(customerId, empB!.id, legB.id, date);

    const del = await apiDelete(`/api/appointments/${legA.id}`);
    expect(del.status, `delete failed: ${JSON.stringify(del.data)}`).toBe(200);
    expect((del.data as any).coVisitCascadedLegIds ?? []).not.toContain(legB.id);

    const [a, b] = await Promise.all([
      apiGet<any>(`/api/appointments/${legA.id}`),
      apiGet<any>(`/api/appointments/${legB.id}`),
    ]);
    expect(a.status).toBe(404);
    // Versiegelter Partner bleibt bestehen und unverändert.
    expect(b.status).toBe(200);
    expect(b.data.status).toBe("completed");
  });
});

describe("CV-3: Privacy-Invariante (coVisitGroupId erweitert NIE die Sichtbarkeit)", () => {
  it("CV-3.1 – zweite Kraft sieht nur ihren eigenen Leg, nicht den Partner-Leg", async () => {
    const customer = await createTestCustomer();
    customerIds.push(customer.id as number);
    // NUR empA ist dem Kunden zugeordnet; empB bekommt nur seinen eigenen Leg.
    await assignEmployeeToCustomer(customer.id as number, empA!.id);

    const service = await getAnyService();
    const date = getFutureDate(26);

    const create = await apiPost<any>("/api/appointments/kundentermin", {
      customerId: customer.id,
      date,
      scheduledStart: "14:00",
      services: [{ serviceId: service.id, durationMinutes: 60 }],
      assignedEmployeeId: empA!.id,
      secondAssignedEmployeeId: empB!.id,
    });
    expect(create.status).toBe(201);
    const groupId = create.data.coVisitGroupId;

    // empB (nicht-Admin, NICHT dem Kunden zugeordnet) darf ausschließlich den
    // eigenen Leg sehen — die gemeinsame coVisitGroupId darf den Partner-Leg
    // NICHT sichtbar machen.
    const authB = await loginAs(empB!.email, empB!.password);
    const listB = await apiGetAs<any[]>(authB, `/api/appointments?date=${date}`);
    expect(listB.status).toBe(200);

    const groupLegsVisibleToB = listB.data.filter((a: any) => a.coVisitGroupId === groupId);
    // Genau ein Leg — der eigene (empB) — sichtbar. Der Partner-Leg (empA) fehlt.
    expect(groupLegsVisibleToB.length).toBe(1);
    expect(groupLegsVisibleToB[0].assignedEmployeeId).toBe(empB!.id);
    expect(listB.data.some((a: any) => a.assignedEmployeeId === empA!.id)).toBe(false);
  });

  it("CV-3.2 – beteiligte Kraft erhält den Partner-NAMEN am eigenen Leg (Task #1736), NICHT den Partner-Leg", async () => {
    const customer = await createTestCustomer();
    customerIds.push(customer.id as number);
    await assignEmployeeToCustomer(customer.id as number, empA!.id);

    const service = await getAnyService();
    const date = getFutureDate(27);

    const create = await apiPost<any>("/api/appointments/kundentermin", {
      customerId: customer.id,
      date,
      scheduledStart: "15:00",
      services: [{ serviceId: service.id, durationMinutes: 60 }],
      assignedEmployeeId: empA!.id,
      secondAssignedEmployeeId: empB!.id,
    });
    expect(create.status).toBe(201);
    const groupId = create.data.coVisitGroupId;

    // empB (nicht-Admin) sieht NUR seinen eigenen Leg — dieser trägt jetzt aber
    // den abgeleiteten Partner-NAMEN (empA), damit sich beide abstimmen können.
    const authB = await loginAs(empB!.email, empB!.password);
    const listB = await apiGetAs<any[]>(authB, `/api/appointments?date=${date}`);
    expect(listB.status).toBe(200);

    const ownLeg = listB.data.find(
      (a: any) => a.coVisitGroupId === groupId && a.assignedEmployeeId === empB!.id,
    );
    expect(ownLeg).toBeTruthy();
    // Reiner Name des Partners (empA) — kein weiterer Partner-Termin-Payload.
    expect(typeof ownLeg.coVisitPartnerName).toBe("string");
    expect(ownLeg.coVisitPartnerName).toContain("CoVisitA");
    // Scope-Non-Expansion bleibt: der Partner-Leg (empA) selbst ist unsichtbar.
    expect(listB.data.some((a: any) => a.assignedEmployeeId === empA!.id)).toBe(false);

    // Einzeltermin-Gegenprobe: ein Leg ohne Partner liefert null.
    const soloCustomer = await createTestCustomer();
    customerIds.push(soloCustomer.id as number);
    await assignEmployeeToCustomer(soloCustomer.id as number, empB!.id);
    const solo = await apiPost<any>("/api/appointments/kundentermin", {
      customerId: soloCustomer.id,
      date,
      scheduledStart: "17:00",
      services: [{ serviceId: service.id, durationMinutes: 60 }],
      assignedEmployeeId: empB!.id,
    });
    expect(solo.status).toBe(201);
    const soloRead = await apiGet<any>(`/api/appointments/${solo.data.id}`);
    expect(soloRead.data.coVisitGroupId).toBeNull();
    expect(soloRead.data.coVisitPartnerName ?? null).toBeNull();
  });
});
