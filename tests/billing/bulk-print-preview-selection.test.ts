/**
 * Task #1632 — Auswahl-basierter Sammeldruck-VORSCHAU-Druck (READ-ONLY).
 *
 * Sichert den print-only Pfad der Route
 * `POST /api/billing/bulk-print-preview` mit dem optionalen `invoiceIds`-Feld
 * (eingeführt in #1630) ab. Anders als `/bulk-print` ändert diese Route
 * KEINEN Status (kein „versendet", kein sentAt, kein Audit-Mark). Abgedeckte
 * Pfade:
 *   1. Auswahl-Druck: `invoiceIds` druckt GENAU die druckbaren Entwürfe der
 *      Auswahl, filtert versendete/stornierte heraus, ändert KEINEN Status.
 *   2. Nicht-Auswahl (ohne IDs): das bisherige Monats-Verhalten bleibt
 *      unverändert (alle Monats-Entwürfe, ebenfalls status-neutral).
 *   3. Leere/nicht-druckbare Auswahl → 404 mit klarer Meldung statt leerer
 *      Datei.
 *
 * Tests laufen gegen eine isolierte Wegwerf-Test-DB pro Worker; jeder Test
 * legt eigene Kunden an (Cleanup via purge im afterAll). Assertions zielen
 * ausschließlich auf die hier angelegten Rechnungen (per invoiceId).
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
import { buildContentDisposition } from "@shared/domain/invoice-export-filename";
import { db } from "../../server/lib/db";
import { invoices, auditLog } from "@shared/schema";
import { eq, and, sql } from "drizzle-orm";

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
        notes: `PP-${noteTag}-${uniqueId()}`,
        assignedEmployeeId: auth.user.id,
        services: [{ serviceId, durationMinutes }],
      });
      if (res.status === 201) {
        return { id: res.data.id, date: dateStr, time };
      }
    }
  }
  throw new Error(
    `createAppointmentInMonth(${year}-${month}, ${noteTag}): kein freier Werktag-Slot im Monat`,
  );
}

// ---------- Billing-flow helpers ----------

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
    services: [{ serviceId, actualDurationMinutes: actualMinutes, details: "PP-Doc" }],
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

/**
 * Erstellt eine echte, renderbare Selbstzahler-Entwurfs-Rechnung über den
 * vollen Flow (Termin → Doku → Leistungsnachweis → Signatur → generate).
 */
async function createSelbstzahlerDraft(
  year: number,
  month: number,
  tag: string,
): Promise<{ customerId: number; invoiceId: number }> {
  const customerId = await createCustomer({
    vorname: "PP-SZ",
    nachname: `Privat-${tag}-${uniqueId()}`,
    geburtsdatum: "1942-03-10",
    email: `pp-sz-${uniqueId()}@test.local`,
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
  return { customerId, invoiceId: ids[0] };
}

// ---------- Preview invocation (binary response) ----------

interface PreviewResultEntry {
  invoiceId: number;
  invoiceNumber: string;
  customerId: number;
  status: "printed" | "error";
  message?: string;
}
interface PreviewSummary {
  total: number;
  printed: number;
  marked: number;
  errors: number;
  groupedByPayer: boolean;
  results: PreviewResultEntry[];
}

async function bulkPrintPreview(body: {
  billingMonth: number;
  billingYear: number;
  insuranceProviderId?: number;
  groupByPayer?: boolean;
  includeLeistungsnachweise?: boolean;
  invoiceIds?: number[];
}): Promise<{ status: number; contentType: string | null; contentDisposition: string | null; summary: PreviewSummary | null; buffer: Buffer; json: unknown }> {
  const cookieHeader = `${auth.cookie}; careconnect_csrf=${auth.csrfToken}`;
  const res = await fetch(`${BASE_URL}/api/billing/bulk-print-preview`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookieHeader,
      "x-csrf-token": auth.csrfToken,
    },
    body: JSON.stringify(body),
  });
  const buffer = Buffer.from(await res.arrayBuffer());
  const header = res.headers.get("x-bulk-print-summary");
  const summary = header ? (JSON.parse(decodeURIComponent(header)) as PreviewSummary) : null;
  const contentType = res.headers.get("content-type");
  const contentDisposition = res.headers.get("content-disposition");
  let json: unknown = null;
  if (contentType?.includes("application/json")) {
    try { json = JSON.parse(buffer.toString("utf8")); } catch { /* ignore */ }
  }
  return { status: res.status, contentType, contentDisposition, summary, buffer, json };
}

function findResult(summary: PreviewSummary | null, invoiceId: number): PreviewResultEntry | undefined {
  return summary?.results.find(r => r.invoiceId === invoiceId);
}

async function getInvoiceRow(invoiceId: number): Promise<{ status: string; sentAt: Date | null } | undefined> {
  const rows = await db
    .select({ status: invoices.status, sentAt: invoices.sentAt })
    .from(invoices)
    .where(eq(invoices.id, invoiceId));
  return rows[0];
}

async function countBulkPrintAudit(invoiceId: number): Promise<number> {
  const rows = await db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.entityType, "invoice"),
        eq(auditLog.entityId, invoiceId),
        sql`${auditLog.metadata}->>'source' = 'bulk_print'`,
      ),
    );
  return rows.length;
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

describe("PP: Auswahl-Sammeldruck-Vorschau (POST /api/billing/bulk-print-preview mit invoiceIds)", () => {
  it("PP-1 — invoiceIds druckt GENAU die Auswahl, filtert versendete/stornierte heraus, ändert KEINEN Status", async () => {
    const { year, month } = recentPastWeekdayAnchor();

    // Drei druckbare Entwürfe im selben Monat.
    const { invoiceId: invA } = await createSelbstzahlerDraft(year, month, "S-A");
    const { invoiceId: invB } = await createSelbstzahlerDraft(year, month, "S-B");
    const { invoiceId: invC } = await createSelbstzahlerDraft(year, month, "S-C");

    // invC wird VOR dem Druck als „versendet" markiert → darf trotz Auswahl
    // NICHT gedruckt werden (nur druckbare Entwürfe).
    const markRes = await apiPost<unknown>(`/api/billing/${invC}/mark-sent`, {});
    expect(markRes.status, `mark-sent für ${invC}`).toBe(200);

    // Auswahl: A + C (nicht B). Erwartet: nur A wird gedruckt (C rausgefiltert).
    const out = await bulkPrintPreview({
      billingMonth: month,
      billingYear: year,
      invoiceIds: [invA, invC],
    });

    expect(out.status).toBe(200);
    expect(out.contentType).toContain("application/pdf");
    expect(out.buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");

    expect(out.summary).not.toBeNull();
    // Nur A ist ein druckbarer Entwurf der Auswahl.
    expect(out.summary!.total).toBe(1);
    expect(out.summary!.printed).toBe(1);
    expect(out.summary!.marked, "Vorschau markiert NIE").toBe(0);
    expect(out.summary!.errors).toBe(0);

    expect(findResult(out.summary, invA)?.status).toBe("printed");
    // C (versendet) und B (nicht ausgewählt) tauchen nicht im Summary auf.
    expect(findResult(out.summary, invC)).toBeUndefined();
    expect(findResult(out.summary, invB)).toBeUndefined();

    // KEIN Status geändert: A + B bleiben Entwurf, C bleibt versendet ohne
    // frischen sentAt-Overwrite; KEINE bulk_print-Audit-Zeile.
    expect((await getInvoiceRow(invA))?.status).toBe("entwurf");
    expect((await getInvoiceRow(invB))?.status).toBe("entwurf");
    expect((await getInvoiceRow(invC))?.status).toBe("versendet");
    for (const id of [invA, invB, invC]) {
      expect(await countBulkPrintAudit(id), `Rechnung ${id} darf keine bulk_print-Audit-Zeile bekommen`).toBe(0);
    }
  });

  it("PP-2 — ohne invoiceIds bleibt das Monats-Verhalten unverändert (alle Entwürfe, status-neutral)", async () => {
    const { year, month } = recentPastWeekdayAnchor();

    const { invoiceId: invA } = await createSelbstzahlerDraft(year, month, "M-A");
    const { invoiceId: invB } = await createSelbstzahlerDraft(year, month, "M-B");

    const out = await bulkPrintPreview({
      billingMonth: month,
      billingYear: year,
    });

    expect(out.status).toBe(200);
    expect(out.contentType).toContain("application/pdf");
    expect(out.buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");

    expect(out.summary).not.toBeNull();
    expect(out.summary!.marked).toBe(0);
    // Beide Monats-Entwürfe sind enthalten (Monats-Verhalten unverändert).
    expect(findResult(out.summary, invA)?.status).toBe("printed");
    expect(findResult(out.summary, invB)?.status).toBe("printed");

    // Status-neutral.
    expect((await getInvoiceRow(invA))?.status).toBe("entwurf");
    expect((await getInvoiceRow(invB))?.status).toBe("entwurf");
    expect(await countBulkPrintAudit(invA)).toBe(0);
    expect(await countBulkPrintAudit(invB)).toBe(0);
  });

  it("PP-3 — Auswahl nur aus nicht-druckbaren Rechnungen liefert 404 mit klarer Meldung (keine leere Datei)", async () => {
    const { year, month } = recentPastWeekdayAnchor();

    const { invoiceId: invA } = await createSelbstzahlerDraft(year, month, "E-A");
    // Als versendet markieren → nicht mehr druckbar (kein Entwurf).
    const markRes = await apiPost<unknown>(`/api/billing/${invA}/mark-sent`, {});
    expect(markRes.status).toBe(200);

    const out = await bulkPrintPreview({
      billingMonth: month,
      billingYear: year,
      invoiceIds: [invA],
    });

    // Klares 404-Feedback statt einer leeren/kaputten Datei.
    expect(out.status).toBe(404);
    expect(out.contentType, "Fehler kommt als JSON, nicht als PDF").not.toContain("application/pdf");
    const message = JSON.stringify(out.json ?? out.buffer.toString("utf8"));
    expect(message).toContain("Auswahl");

    // Weiterhin status-neutral (der Fehlpfad mutiert nichts).
    expect((await getInvoiceRow(invA))?.status).toBe("versendet");
  });

  it("PP-4 — Content-Disposition läuft über den umlaut-sicheren Helper (ASCII-Fallback + RFC-5987 filename*) (Task #1704)", async () => {
    const { year, month } = recentPastWeekdayAnchor();
    await createSelbstzahlerDraft(year, month, "CD-A");

    const out = await bulkPrintPreview({
      billingMonth: month,
      billingYear: year,
    });

    expect(out.status).toBe(200);
    expect(out.contentType).toContain("application/pdf");
    expect(out.contentDisposition, "Download trägt Content-Disposition").toBeTruthy();

    const monthSlug = `${String(month).padStart(2, "0")}-${year}`;
    const expectedFileName = `Sammeldruck-Vorschau-${monthSlug}.pdf`;
    const expectedHeader = buildContentDisposition(expectedFileName, "attachment");

    // Vertrag: der Header ist byte-identisch mit dem SSoT-Helper — ein Refactor
    // zurück auf das rohe `attachment; filename="…"` (ohne filename*) wird rot.
    expect(out.contentDisposition, "Content-Disposition == SSoT-Helper").toBe(expectedHeader);
    expect(out.contentDisposition!, "enthält ASCII filename=").toContain(`filename="${expectedFileName}"`);
    expect(out.contentDisposition!, "enthält RFC-5987 filename*").toContain("filename*=UTF-8''");
  });
});
