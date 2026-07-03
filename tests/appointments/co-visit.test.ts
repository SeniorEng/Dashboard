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

/**
 * Task #1613 — Zwei-Kräfte-Einsatz (Co-Visit).
 *
 * Ein Kundentermin kann mit einer ZWEITEN Pflegekraft gebucht werden. Es
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
});
