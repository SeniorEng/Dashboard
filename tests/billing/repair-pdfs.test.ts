/**
 * Sammel-Reparatur der „PDF-Fehler"-Rechnungen (Task #1834)
 *
 * Sichert die Route `POST /api/billing/repair-pdfs` ab. Sie ersetzt das
 * manuelle Einzel-Anklicken jeder Rechnung mit fehlendem PDF durch EINEN
 * Sammellauf. Kernzusagen:
 *   1. Reparatur: Rechnungen mit `pdf_path IS NULL` (dieselbe Selektion wie der
 *      Boot-Backfill `backfillInvoicePdfs`) werden über den bestehenden
 *      Self-Heal-Pfad `persistInvoicePdf` neu persistiert → `pdf_path` gesetzt.
 *   2. Idempotenz: Ein zweiter Lauf findet nichts mehr (`total === 0`), und die
 *      bereits versiegelte Rechnung wird NICHT neu gerendert — ihr `pdf_hash`
 *      bleibt stabil.
 *   3. Auswahl-Einschränkung: Mit `invoiceIds` werden nur die übergebenen
 *      Rechnungen repariert; andere „PDF-Fehler"-Rechnungen bleiben unangetastet.
 *
 * Die Route rendert echte PDFs über den Object-Storage-Sidecar. In der
 * no-Sidecar-CI ist `persistInvoicePdf` ein No-op (setzt kein `pdf_path`),
 * deshalb wird die gesamte Suite dort übersprungen (Object-Storage-Guard, wie
 * bei bulk-print & Co.).
 */

import { it, expect, beforeAll, afterAll } from "vitest";
import { describe } from "../helpers/object-storage";
import {
  apiGet,
  apiPost,
  getAuthCookie,
  uniqueId,
  cleanupCustomer,
} from "../test-utils";
import { validSignatureDataUrl } from "../helpers/valid-signature";
import { db } from "../../server/lib/db";
import { invoices } from "@shared/schema";
import { eq } from "drizzle-orm";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
let hwServiceId: number;
const cleanupCustomerIds: number[] = [];

// ---------- Date / Slot helpers ----------

function ymdLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const SEED_TIMES = [
  "00:00", "00:15", "00:30", "00:45", "01:00", "01:15", "01:30", "01:45",
  "02:00", "02:15", "02:30", "02:45", "03:00", "03:30", "04:00", "04:30",
  "05:00", "05:30", "21:00", "21:30", "22:00", "22:30", "23:00", "23:30",
];

function recentPastWeekdayAnchor(): { year: number; month: number } {
  const d = new Date();
  do {
    d.setDate(d.getDate() - 1);
  } while (d.getDay() === 0 || d.getDay() === 6);
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}

async function createAppointmentInMonth(
  customerId: number,
  serviceId: number,
  durationMinutes: number,
  year: number,
  month: number,
  noteTag: string,
): Promise<{ id: number; date: string; time: string }> {
  const today = new Date();
  const lastDay = new Date(year, month, 0).getDate();
  for (let day = lastDay; day >= 1; day--) {
    const cand = new Date(year, month - 1, day);
    if (cand > today) continue;
    const dow = cand.getDay();
    if (dow === 0 || dow === 6) continue;
    const dateStr = ymdLocal(cand);
    for (const time of SEED_TIMES) {
      const res = await apiPost<{ id: number }>("/api/appointments/kundentermin", {
        customerId,
        date: dateStr,
        scheduledStart: time,
        notes: `RP-${noteTag}-${uniqueId()}`,
        assignedEmployeeId: auth.user.id,
        services: [{ serviceId, durationMinutes }],
      });
      if (res.status === 201) {
        return { id: res.data.id, date: dateStr, time };
      }
    }
  }
  throw new Error(`createAppointmentInMonth(${year}-${month}, ${noteTag}): kein freier Werktag-Slot`);
}

async function createCustomer(payload: Record<string, unknown>): Promise<number> {
  const res = await apiPost<{ id: number }>("/api/admin/customers", payload);
  if (res.status !== 201) {
    throw new Error(`createCustomer failed: ${res.status} ${JSON.stringify(res.data)}`);
  }
  cleanupCustomerIds.push(res.data.id);
  return res.data.id;
}

async function documentAppointment(
  appointmentId: number,
  startTime: string,
  serviceId: number,
  actualMinutes: number,
): Promise<void> {
  const res = await apiPost<unknown>(`/api/appointments/${appointmentId}/document`, {
    actualStart: startTime,
    travelOriginType: "home",
    travelKilometers: 0,
    customerKilometers: 0,
    services: [{ serviceId, actualDurationMinutes: actualMinutes, details: "RP-Doc" }],
  });
  if (res.status !== 200) {
    throw new Error(`documentAppointment(${appointmentId}) failed: ${res.status} ${JSON.stringify(res.data)}`);
  }
}

async function createAndSignServiceRecord(customerId: number, year: number, month: number): Promise<void> {
  const res = await apiPost<{ id: number }>("/api/service-records", {
    customerId,
    employeeId: auth.user.id,
    year,
    month,
  });
  if (res.status !== 201) {
    throw new Error(`createServiceRecord failed: ${res.status} ${JSON.stringify(res.data)}`);
  }
  const srId = res.data.id;
  for (const signerType of ["employee", "customer"] as const) {
    const signRes = await apiPost<unknown>(`/api/service-records/${srId}/sign`, {
      signerType,
      signatureData: validSignatureDataUrl(),
    });
    if (signRes.status !== 200) {
      throw new Error(`signServiceRecord(${srId}, ${signerType}) failed: ${signRes.status} ${JSON.stringify(signRes.data)}`);
    }
  }
}

async function generateInvoice(customerId: number, year: number, month: number): Promise<number[]> {
  const res = await apiPost<unknown>("/api/billing/generate", {
    customerId,
    billingMonth: month,
    billingYear: year,
  });
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`generateInvoice failed: ${res.status} ${JSON.stringify(res.data)}`);
  }
  const data = res.data as { splitInvoices?: boolean; invoices?: Array<{ id: number }> } | Array<{ id: number }> | { id: number };
  let list: Array<{ id: number }>;
  if (data && typeof data === "object" && "splitInvoices" in data && Array.isArray((data as { invoices?: Array<{ id: number }> }).invoices)) {
    list = (data as { invoices: Array<{ id: number }> }).invoices;
  } else if (Array.isArray(data)) {
    list = data;
  } else {
    list = [data as { id: number }];
  }
  return list.map(i => i.id);
}

/** Voller Flow → eine renderbare Selbstzahler-Entwurfs-Rechnung mit PDF. */
async function createSelbstzahlerInvoice(year: number, month: number, tag: string): Promise<number> {
  const customerId = await createCustomer({
    vorname: "RP-SZ",
    nachname: `Privat-${tag}-${uniqueId()}`,
    geburtsdatum: "1942-03-10",
    email: `rp-sz-${uniqueId()}@test.local`,
    strasse: "Teststraße",
    nr: "1",
    plz: "10115",
    stadt: "Berlin",
    pflegegrad: 2,
    pflegegradSeit: "2024-01-01",
    billingType: "selbstzahler",
    acceptsPrivatePayment: true,
  });
  const appt = await createAppointmentInMonth(customerId, hwServiceId, 30, year, month, tag);
  await documentAppointment(appt.id, appt.time, hwServiceId, 30);
  await createAndSignServiceRecord(customerId, year, month);
  const ids = await generateInvoice(customerId, year, month);
  expect(ids.length, `${tag}: Selbstzahler-Rechnung darf nicht splitten`).toBe(1);
  return ids[0];
}

interface RepairPdfsResponse {
  summary: { repaired: number; failed: number; remaining: number; total: number };
  results: Array<{ invoiceId: number; invoiceNumber: string; status: "repaired" | "failed"; reason?: string }>;
}

async function repairPdfs(invoiceIds?: number[]): Promise<{ status: number; data: RepairPdfsResponse }> {
  const body = invoiceIds && invoiceIds.length > 0 ? { invoiceIds } : {};
  const res = await apiPost<RepairPdfsResponse>("/api/billing/repair-pdfs", body);
  return { status: res.status, data: res.data };
}

async function getInvoicePdf(invoiceId: number): Promise<{ pdfPath: string | null; pdfHash: string | null } | undefined> {
  const rows = await db
    .select({ pdfPath: invoices.pdfPath, pdfHash: invoices.pdfHash })
    .from(invoices)
    .where(eq(invoices.id, invoiceId));
  return rows[0];
}

// Setzt pdf_path auf NULL — simuliert eine „PDF-Fehler"-Rechnung (fehlendes
// Objekt in Object Storage). Der GoBD-Trigger erlaubt draft-Updates.
async function nullifyPdfPath(invoiceId: number): Promise<void> {
  await db.update(invoices).set({ pdfPath: null }).where(eq(invoices.id, invoiceId));
}

// `generate` persistiert das PDF in einem Hintergrund-Task (nicht synchron).
// Für ein deterministisches Setup warten wir, bis `pdf_path` gesetzt ist,
// bevor wir es gezielt entfernen (sonst rennt der Backfill mit dem Nullify).
async function waitForPdfPath(invoiceId: number, timeoutMs = 30_000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await getInvoicePdf(invoiceId);
    if (row?.pdfPath) return row.pdfPath;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

// ============================================================

beforeAll(async () => {
  auth = await getAuthCookie();
  const servicesRes = await apiGet<Array<{ id: number; code: string }>>("/api/services");
  if (servicesRes.status !== 200 || !Array.isArray(servicesRes.data)) {
    throw new Error("Service-Katalog konnte nicht geladen werden");
  }
  const hw = servicesRes.data.find(s => s.code === "hauswirtschaft");
  if (!hw) throw new Error("Pflicht-Service 'hauswirtschaft' fehlt in der Test-DB");
  hwServiceId = hw.id;
});

afterAll(async () => {
  for (const id of cleanupCustomerIds) {
    await cleanupCustomer(id);
  }
});

describe("RP: Sammel-Reparatur (POST /api/billing/repair-pdfs)", () => {
  it("RP-1 — repariert eine Rechnung mit pdf_path NULL und ist danach idempotent (pdf_hash stabil)", async () => {
    const { year, month } = recentPastWeekdayAnchor();
    const invoiceId = await createSelbstzahlerInvoice(year, month, "R1");

    // Auf den Hintergrund-Persist von `generate` warten, damit das Nullify
    // deterministisch ist (kein Race mit dem Backfill).
    const persistedPath = await waitForPdfPath(invoiceId);
    expect(persistedPath, "generate sollte das PDF (im Hintergrund) persistieren").toBeTruthy();
    const sealedHash = (await getInvoicePdf(invoiceId))?.pdfHash ?? null;

    // pdf_path entfernen → wird zur „PDF-Fehler"-Rechnung.
    await nullifyPdfPath(invoiceId);
    expect((await getInvoicePdf(invoiceId))?.pdfPath).toBeNull();

    // Sammel-Reparatur auf genau diese Rechnung eingeschränkt.
    const run = await repairPdfs([invoiceId]);
    expect(run.status).toBe(200);
    const entry = run.data.results.find(r => r.invoiceId === invoiceId);
    expect(entry, "Rechnung muss im Ergebnis stehen").toBeDefined();
    expect(entry!.status).toBe("repaired");
    expect(run.data.summary.repaired).toBeGreaterThanOrEqual(1);

    // pdf_path wieder gesetzt, pdf_hash unverändert (kein Re-Seal).
    const after = await getInvoicePdf(invoiceId);
    expect(after?.pdfPath, "pdf_path muss nach Reparatur gesetzt sein").toBeTruthy();
    expect(after?.pdfHash, "pdf_hash der versiegelten Rechnung bleibt stabil").toBe(sealedHash);

    // Zweiter Lauf: nichts mehr zu tun (bereits repariert wird nicht neu gerendert).
    const second = await repairPdfs([invoiceId]);
    expect(second.status).toBe(200);
    expect(second.data.summary.total).toBe(0);
    expect(second.data.summary.repaired).toBe(0);
    expect(second.data.results.length).toBe(0);
  });

  it("RP-2 — invoiceIds schränkt die Reparatur ein: andere PDF-Fehler-Rechnung bleibt unangetastet", async () => {
    const { year, month } = recentPastWeekdayAnchor();
    const invA = await createSelbstzahlerInvoice(year, month, "R2A");
    const invB = await createSelbstzahlerInvoice(year, month, "R2B");

    await nullifyPdfPath(invA);
    await nullifyPdfPath(invB);

    // Nur A reparieren.
    const run = await repairPdfs([invA]);
    expect(run.status).toBe(200);
    expect(run.data.results.some(r => r.invoiceId === invA && r.status === "repaired")).toBe(true);
    expect(run.data.results.some(r => r.invoiceId === invB), "B darf nicht mitrepariert werden").toBe(false);

    expect((await getInvoicePdf(invA))?.pdfPath, "A repariert").toBeTruthy();
    expect((await getInvoicePdf(invB))?.pdfPath, "B unangetastet").toBeNull();

    // Aufräumen: B ebenfalls reparieren, damit kein Rückstand bleibt.
    await repairPdfs([invB]);
  });
});
