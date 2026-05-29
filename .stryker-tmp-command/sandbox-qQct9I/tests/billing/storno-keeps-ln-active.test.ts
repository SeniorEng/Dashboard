// @ts-nocheck
import { validSignatureDataUrl } from "../helpers/valid-signature";
/**
 * Task #576 — Regressionstest: Storno darf den zugehörigen
 * Leistungsnachweis NICHT soft-löschen.
 *
 * Vor Task #576 hat der T05/K3-Block in `server/routes/billing.ts` bei
 * Partial-Signing (LN deckt nur N von M dokumentierten Terminen ab) den
 * gesamten LN auf `deleted_at = now()` gesetzt. Folge: der Kunde
 * verschwand aus `GET /api/billing/eligible-customers` (Filter
 * `activeOnly()`), und „Neue Rechnung erstellen" zeigte ihn nicht mehr
 * an. Genau das ist 2026-05-22 in Prod mit Kunde 117 (Egon) und 108
 * (Marvin) passiert.
 *
 * Erwartet:
 *   1. Nach Storno bleibt der LN aktiv (`deletedAt = null`,
 *      `status = "completed"`).
 *   2. Der Kunde erscheint weiterhin in `/api/billing/eligible-customers`.
 *   3. Die Partial-Signing-Sichtbarkeit ist im Response enthalten:
 *      `completedAppointments` und `coveredAppointments` sind gesetzt.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  apiGet,
  apiPost,
  apiPatch,
  apiDelete,
  getAuthCookie,
  uniqueId,
  createTestCustomer,
  cleanupCustomer,
} from "../test-utils";

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
let hwServiceId: number;
let customerId: number;
const cleanupApptIds: number[] = [];
const cleanupSrIds: number[] = [];
const cleanupInvoiceIds: number[] = [];

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const SEED_TIMES = [
  "00:00", "00:15", "00:30", "00:45", "01:00", "01:15", "01:30", "01:45",
  "02:00", "02:15", "02:30", "02:45", "03:00", "03:30", "04:00", "04:30",
  "05:00", "05:30", "21:00", "21:30", "22:00", "22:30", "23:00", "23:30",
];

async function findFreeSlot(custId: number, year: number, month: number, exclude: string | null, tag: string) {
  const today = new Date();
  const lastDay = new Date(year, month, 0).getDate();
  for (let day = lastDay; day >= 1; day--) {
    const cand = new Date(year, month - 1, day);
    if (cand > today) continue;
    const dow = cand.getDay();
    if (dow === 0 || dow === 6) continue;
    const dateStr = ymd(cand);
    if (dateStr === exclude) continue;
    for (const time of SEED_TIMES) {
      const res = await apiPost<any>("/api/appointments/kundentermin", {
        customerId: custId,
        date: dateStr,
        scheduledStart: time,
        notes: `#576-${tag}-${uniqueId()}`,
        assignedEmployeeId: auth.user.id,
        services: [{ serviceId: hwServiceId, durationMinutes: 30 }],
      });
      if (res.status === 201) {
        cleanupApptIds.push(res.data.id);
        return { id: res.data.id as number, date: dateStr, time };
      }
    }
  }
  throw new Error(`findFreeSlot(${tag}): kein freier Slot`);
}

async function documentAppt(id: number, time: string) {
  const res = await apiPost<any>(`/api/appointments/${id}/document`, {
    actualStart: time,
    travelOriginType: "home",
    travelKilometers: 0,
    customerKilometers: 0,
    services: [{ serviceId: hwServiceId, actualDurationMinutes: 30, details: "#576" }],
  });
  if (res.status !== 200) throw new Error(`document failed: ${JSON.stringify(res.data)}`);
}

async function createAndSignSr(custId: number, year: number, month: number): Promise<number> {
  const cre = await apiPost<any>("/api/service-records", {
    customerId: custId,
    employeeId: auth.user.id,
    year,
    month,
  });
  if (cre.status !== 201) throw new Error(`SR create: ${JSON.stringify(cre.data)}`);
  const srId = cre.data.id as number;
  cleanupSrIds.push(srId);
  for (const signerType of ["employee", "customer"] as const) {
    const sig = await apiPost<any>(`/api/service-records/${srId}/sign`, {
      signerType,
      signatureData: validSignatureDataUrl(),
    });
    if (sig.status !== 200) throw new Error(`SR sign(${signerType}): ${JSON.stringify(sig.data)}`);
  }
  return srId;
}

beforeAll(async () => {
  auth = await getAuthCookie();
  const services = await apiGet<any[]>("/api/services/all");
  hwServiceId = (services.data as any[]).find((s) => s.code === "hauswirtschaft")!.id;
  const cust = await createTestCustomer({ nachname: `Storno-Keeps-LN-${uniqueId()}` });
  customerId = cust.id as number;
});

afterAll(async () => {
  for (const id of cleanupInvoiceIds) { try { await apiDelete(`/api/billing/${id}`); } catch {} }
  for (const id of cleanupApptIds) { try { await apiDelete(`/api/appointments/${id}`); } catch {} }
  for (const id of cleanupSrIds) { try { await apiDelete(`/api/service-records/${id}`); } catch {} }
  await cleanupCustomer(customerId);
});

describe("#576 — Storno hält LN aktiv und Kunde eligible", () => {
  it("LN bleibt nach Storno aktiv (auch bei Partial-Signing) und Kunde bleibt eligible", async () => {
    const today = new Date();
    const year = today.getFullYear();
    const month = today.getMonth() + 1;

    // T1: dokumentieren + im LN erfassen + abrechnen.
    const t1 = await findFreeSlot(customerId, year, month, null, "T1");
    await documentAppt(t1.id, t1.time);
    const srId = await createAndSignSr(customerId, year, month);

    const gen = await apiPost<any>("/api/billing/generate", {
      customerId,
      billingMonth: month,
      billingYear: year,
    });
    expect(gen.status, `gen: ${JSON.stringify(gen.data)}`).toBe(200);
    const inv: any = gen.data?.splitInvoices ? gen.data.invoices[0]
      : Array.isArray(gen.data) ? gen.data[0]
      : gen.data;
    cleanupInvoiceIds.push(inv.id);

    // T2: zusätzlich dokumentieren — wird vom LN NICHT abgedeckt
    // (Partial-Signing-Setup). Ohne Task #576 würde der spätere Storno
    // den LN soft-löschen, weil `hasUnlinkedDoc=true`.
    const t2 = await findFreeSlot(customerId, year, month, t1.date, "T2");
    await documentAppt(t2.id, t2.time);

    // Storno der Rechnung.
    const stornoRes = await apiPatch<any>(`/api/billing/${inv.id}/status`, { status: "storniert" });
    expect(stornoRes.status, `storno: ${JSON.stringify(stornoRes.data)}`).toBe(200);
    const list = await apiGet<any[]>(`/api/billing?customerId=${customerId}`);
    const stornoInv = (list.data as any[]).find(
      (i: any) => i.invoiceType === "stornorechnung" && i.stornierteRechnungId === inv.id,
    );
    if (stornoInv) cleanupInvoiceIds.push(stornoInv.id);

    // Erwartung 1: LN ist NICHT soft-gelöscht.
    const srAfter = await apiGet<any>(`/api/service-records/${srId}`);
    expect(srAfter.status, `SR-Lookup nach Storno: ${srAfter.status}`).toBe(200);
    expect(srAfter.data?.status, "LN-Status muss erhalten bleiben").toBe("completed");
    expect(srAfter.data?.deletedAt ?? null, "LN darf nicht soft-gelöscht sein").toBeNull();

    // Erwartung 2: Kunde bleibt in eligible-customers sichtbar.
    const eligible = await apiGet<any[]>(`/api/billing/eligible-customers?month=${month}&year=${year}`);
    expect(eligible.status).toBe(200);
    const found = (eligible.data as any[]).find((c) => c.id === customerId);
    expect(found, `Kunde ${customerId} muss nach Storno weiterhin eligible sein`).toBeDefined();

    // Erwartung 3: Partial-Signing-Felder sind im Response.
    expect(typeof found.completedAppointments, "completedAppointments fehlt").toBe("number");
    expect(typeof found.coveredAppointments, "coveredAppointments fehlt").toBe("number");
    expect(found.completedAppointments).toBeGreaterThanOrEqual(2);
    expect(found.coveredAppointments).toBeLessThan(found.completedAppointments);
  }, 90_000);
});
