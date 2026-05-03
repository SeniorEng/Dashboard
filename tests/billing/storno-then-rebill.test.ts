/**
 * Phase-2 Bug-Tests — K3: Nachberechnung nach Storno mit Storno-Verlinkung
 *
 * Heute erzeugt eine erneute Generierung nach Storno eine Rechnung mit
 * invoiceType = "rechnung" (oder im Doku-Pfad "nachberechnung", aber ohne
 * Verlinkung zur stornierten Original-Rechnung). Es fehlt das Feld
 * `referencedStornoInvoiceIds`, das die Beziehung zur stornierten Rechnung
 * dokumentiert.
 *
 * Erwartet (Phase-2):
 *   - Zweite Rechnung enthält T1 + T2 (alle Termine des Zeitraums).
 *   - invoiceType = "nachberechnung".
 *   - referencedStornoInvoiceIds enthält die ID von RE-001 (Original).
 *
 * Mapping: Test → K-Punkt → Fix-Status
 *   K3 → it.fails (heute keine Storno-Verlinkung, kippt nach K3-Fix)
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

function shiftToWeekday(d: Date): Date {
  const dow = d.getDay();
  if (dow === 0) d.setDate(d.getDate() - 2);
  else if (dow === 6) d.setDate(d.getDate() - 1);
  return d;
}

const SEED_TIMES = [
  "00:00", "00:15", "00:30", "00:45", "01:00", "01:15", "01:30", "01:45",
  "02:00", "02:15", "02:30", "02:45", "03:00", "03:30", "04:00", "04:30",
  "05:00", "05:30", "21:00", "21:30", "22:00", "22:30", "23:00", "23:30",
];

async function findFreeSlotInMonth(custId: number, year: number, month: number, exclude: string | null, tag: string): Promise<{ id: number; date: string; time: string }> {
  const today = new Date();
  const lastDay = new Date(year, month, 0).getDate();
  const tryCreate = async (dateStr: string) => {
    for (const time of SEED_TIMES) {
      const res = await apiPost<any>("/api/appointments/kundentermin", {
        customerId: custId,
        date: dateStr,
        scheduledStart: time,
        notes: `K3-${tag}-${uniqueId()}`,
        assignedEmployeeId: auth.user.id,
        services: [{ serviceId: hwServiceId, durationMinutes: 30 }],
      });
      if (res.status === 201) {
        cleanupApptIds.push(res.data.id);
        return { id: res.data.id, date: dateStr, time };
      }
    }
    return null;
  };
  for (let day = lastDay; day >= 1; day--) {
    const cand = new Date(year, month - 1, day);
    if (cand > today) continue;
    const dow = cand.getDay();
    if (dow === 0 || dow === 6) continue;
    const dateStr = ymd(cand);
    if (dateStr === exclude) continue;
    const created = await tryCreate(dateStr);
    if (created) return created;
  }
  for (let day = 1; day <= lastDay; day++) {
    const cand = new Date(year, month - 1, day);
    if (cand <= today) continue;
    const dow = cand.getDay();
    if (dow === 0 || dow === 6) continue;
    const dateStr = ymd(cand);
    if (dateStr === exclude) continue;
    const created = await tryCreate(dateStr);
    if (created) return created;
  }
  throw new Error(`findFreeSlotInMonth(${tag}): kein freier Slot`);
}

async function documentAppointment(id: number, time: string): Promise<void> {
  const res = await apiPost<any>(`/api/appointments/${id}/document`, {
    actualStart: time,
    travelOriginType: "home",
    travelKilometers: 0,
    customerKilometers: 0,
    services: [{ serviceId: hwServiceId, actualDurationMinutes: 30, details: "K3-Test" }],
  });
  if (res.status !== 200) throw new Error(`document failed: ${res.status} ${JSON.stringify(res.data)}`);
}

async function ensureSignedSr(custId: number, year: number, month: number): Promise<void> {
  // Prüfen, ob LN bereits existiert (sonst Status-Fehler beim Re-Signing).
  const list = await apiGet<any>(`/api/service-records?customerId=${custId}&year=${year}&month=${month}`);
  const existing = (Array.isArray(list.data) ? list.data : list.data?.data || []).find(
    (r: any) => r.customerId === custId && r.year === year && r.month === month,
  );
  let srId: number;
  if (existing) {
    srId = existing.id;
  } else {
    const cre = await apiPost<any>("/api/service-records", {
      customerId: custId,
      employeeId: auth.user.id,
      year,
      month,
    });
    if (cre.status !== 201) throw new Error(`SR create: ${JSON.stringify(cre.data)}`);
    srId = cre.data.id;
    cleanupSrIds.push(srId);
  }
  // Bereits signiert? Skip.
  const cur = await apiGet<any>(`/api/service-records/${srId}`);
  if (cur.data?.status === "completed") return;
  for (const signerType of ["employee", "customer"] as const) {
    if (cur.data?.status === "employee_signed" && signerType === "employee") continue;
    const sig = await apiPost<any>(`/api/service-records/${srId}/sign`, {
      signerType,
      signatureData: "data:image/png;base64,iVBORw0KGgo=",
    });
    if (sig.status !== 200) {
      // Wenn employee_signed schon vor war, ersten Signer überspringen
      if (signerType === "employee") continue;
      throw new Error(`SR sign(${signerType}): ${sig.status} ${JSON.stringify(sig.data)}`);
    }
  }
}

beforeAll(async () => {
  auth = await getAuthCookie();
  const services = await apiGet<any[]>("/api/services/all");
  hwServiceId = (services.data as any[]).find((s) => s.code === "hauswirtschaft")!.id;
  const cust = await createTestCustomer({ nachname: `Privat-K3Rebill-${uniqueId()}` });
  customerId = cust.id as number;
});

afterAll(async () => {
  for (const id of cleanupInvoiceIds) {
    try { await apiDelete(`/api/billing/${id}`); } catch {}
  }
  for (const id of cleanupApptIds) {
    try { await apiDelete(`/api/appointments/${id}`); } catch {}
  }
  for (const id of cleanupSrIds) {
    try { await apiDelete(`/api/service-records/${id}`); } catch {}
  }
  await cleanupCustomer(customerId);
});

describe("K3 — Nachberechnung nach Storno verlinkt Original-Rechnung", () => {
  it("K3.1 — Re-Generierung nach Storno: invoiceType=nachberechnung + referencedStornoInvoiceIds enthält Original", async () => {
    const today = new Date();
    const year = today.getFullYear();
    const month = today.getMonth() + 1;

    // Termin T1 (in vergangenem Werktag), dokumentieren, signieren, abrechnen.
    const t1 = await findFreeSlotInMonth(customerId, year, month, null, "T1");
    await documentAppointment(t1.id, t1.time);
    await ensureSignedSr(customerId, year, month);
    const gen1 = await apiPost<any>("/api/billing/generate", {
      customerId,
      billingMonth: month,
      billingYear: year,
    });
    expect(gen1.status, `gen1: ${JSON.stringify(gen1.data)}`).toBe(200);
    const inv1: any = gen1.data?.splitInvoices ? gen1.data.invoices[0]
      : Array.isArray(gen1.data) ? gen1.data[0]
      : gen1.data;
    expect(inv1?.id).toBeDefined();
    cleanupInvoiceIds.push(inv1.id);

    // T2 hinzufügen, dokumentieren.
    const t2 = await findFreeSlotInMonth(customerId, year, month, t1.date, "T2");
    await documentAppointment(t2.id, t2.time);

    // RE-001 stornieren.
    const stornoRes = await apiPatch<any>(`/api/billing/${inv1.id}/status`, { status: "storniert" });
    expect(stornoRes.status, `storno: ${JSON.stringify(stornoRes.data)}`).toBe(200);
    const list = await apiGet<any[]>(`/api/billing?customerId=${customerId}`);
    const stornoInv = (list.data as any[]).find(
      (i: any) => i.invoiceType === "stornorechnung" && i.stornierteRechnungId === inv1.id,
    );
    if (stornoInv) cleanupInvoiceIds.push(stornoInv.id);

    // SR ggf. neu signieren falls nötig (T2 ist nun ebenfalls dokumentiert).
    await ensureSignedSr(customerId, year, month);

    // Erneute Generierung.
    const gen2 = await apiPost<any>("/api/billing/generate", {
      customerId,
      billingMonth: month,
      billingYear: year,
    });
    expect(gen2.status, `gen2: ${JSON.stringify(gen2.data)}`).toBe(200);
    const inv2: any = gen2.data?.splitInvoices ? gen2.data.invoices[0]
      : Array.isArray(gen2.data) ? gen2.data[0]
      : gen2.data;
    expect(inv2?.id, "Re-Rechnung muss erzeugt sein").toBeDefined();
    cleanupInvoiceIds.push(inv2.id);

    // Phase-2 Erwartung: Nachberechnung mit Verlinkung.
    expect(inv2.invoiceType, `K3-Bug: invoiceType=${inv2.invoiceType}, erwartet 'nachberechnung'`).toBe("nachberechnung");
    expect(
      Array.isArray(inv2.referencedStornoInvoiceIds),
      `K3-Bug: referencedStornoInvoiceIds-Feld fehlt (got ${typeof inv2.referencedStornoInvoiceIds})`,
    ).toBe(true);
    expect(
      inv2.referencedStornoInvoiceIds,
      `K3-Bug: referencedStornoInvoiceIds enthält Original (${inv1.id}) nicht`,
    ).toContain(inv1.id);

    // Inhaltlich: zweite Rechnung enthält beide Termine.
    const detail = await apiGet<any>(`/api/billing/${inv2.id}`);
    const lineItems: any[] = detail.data?.lineItems || [];
    const apptIds = lineItems.map((li: any) => li.appointmentId).filter(Boolean);
    expect(apptIds, "Re-Rechnung muss T1 enthalten").toContain(t1.id);
    expect(apptIds, "Re-Rechnung muss T2 enthalten").toContain(t2.id);
  }, 90_000);
});
