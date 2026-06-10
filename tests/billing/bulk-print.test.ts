/**
 * Sammeldruck (Bulk-Print) Test-Coverage (Task #999)
 *
 * Sichert die Monats-Sammeldruck-Route `POST /api/billing/bulk-print` ab
 * (eingeführt in #996). Die Route bündelt alle Entwurfs-Rechnungen eines
 * Monats und markiert sie anschließend als „versendet" (Audit-Quelle
 * `bulk_print`). Abgedeckte Pfade:
 *   1. Merged-PDF (groupByPayer=false): liefert ein gültiges %PDF und
 *      markiert jeden enthaltenen Entwurf versendet (sentAt + Audit-Zeile).
 *   2. ZIP (groupByPayer=true): liefert application/zip mit je einer
 *      gemergten PDF pro Krankenkassen-/Selbstzahler-Gruppe.
 *   3. Per-Rechnung-Fehlerisolation: eine nicht renderbare Rechnung wird im
 *      `X-Bulk-Print-Summary`-Header als `error` gemeldet, ohne den Lauf
 *      abzubrechen — die gute Rechnung druckt + wird markiert.
 *   4. Leerer Monat: 404.
 *
 * Tests laufen seriell (fileParallelism: false) gegen eine isolierte
 * Wegwerf-Test-DB pro Worker. Jeder Test legt eigene Kunden an; Aufräumen
 * erfolgt über `purge-customers` (GoBD-Bypass für finalisierte Rechnungen)
 * im afterAll. Assertions zielen ausschließlich auf die in diesem Test
 * angelegten Rechnungen (per invoiceId), nie auf monatsweite Summen außer
 * dort, wo per Kassen-Filter exakt isoliert wird.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  apiGet,
  apiPost,
  getAuthCookie,
  uniqueId,
  createTestEmployee,
  deactivateTestEmployee,
  cleanupCustomer,
} from "../test-utils";
import { validSignatureDataUrl } from "../helpers/valid-signature";
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

/**
 * Liefert Jahr/Monat des jüngsten vergangenen Werktags. So liegt der
 * Abrechnungsmonat immer in der Vergangenheit (sofort dokumentierbar) und
 * existiert garantiert (auch am Monatsersten am Wochenende fällt er in den
 * Vormonat).
 */
function recentPastWeekdayAnchor(): { year: number; month: number } {
  const d = new Date();
  do {
    d.setDate(d.getDate() - 1);
  } while (d.getDay() === 0 || d.getDay() === 6);
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}

/**
 * Sucht einen freien (vergangenen) Werktag-Slot beim Test-Admin im
 * angegebenen Monat und legt einen Kundentermin an. Wirft deterministisch,
 * wenn nichts gefunden wird.
 */
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
        notes: `BP-${noteTag}-${uniqueId()}`,
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
    services: [{ serviceId, actualDurationMinutes: actualMinutes, details: "BP-Doc" }],
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
 * Erstellt eine echte, renderbare Pflegekassen-Entwurfs-Rechnung über den
 * vollen Flow (Termin → Doku → Leistungsnachweis → Signatur → generate).
 * Voller §45b-Topf (131 €) deckt eine 30-min-HW (~20 €) ohne Split.
 */
async function createPflegekasseDraft(
  providerId: number,
  year: number,
  month: number,
  tag: string,
): Promise<number> {
  const customerId = await createCustomer({
    vorname: "BP-PK",
    nachname: `Privat-${tag}-${uniqueId()}`,
    geburtsdatum: "1938-05-12",
    strasse: "Teststraße",
    nr: "5",
    plz: "10117",
    stadt: "Berlin",
    pflegegrad: 3,
    pflegegradSeit: "2024-01-01",
    billingType: "pflegekasse_privat",
    acceptsPrivatePayment: true,
    insurance: {
      providerId,
      versichertennummer: "A" + String(Math.floor(100000000 + Math.random() * 900000000)),
      validFrom: "2024-01-01",
    },
    budgets: {
      entlastungsbetrag45b: 13100,
      verhinderungspflege39: 0,
      pflegesachleistungen36: 0,
      validFrom: "2024-01-01",
    },
  });
  const appt = await createAppointmentInMonth(customerId, hwServiceId, 30, year, month, tag);
  await documentAppointment(appt.id, appt.time, hwServiceId, 30);
  await createAndSignServiceRecord(customerId, year, month);
  const ids = await generateInvoice(customerId, year, month);
  expect(ids.length, `${tag}: Pflegekassen-Rechnung darf nicht splitten`).toBe(1);
  return ids[0];
}

/**
 * Erstellt eine echte, renderbare Selbstzahler-Entwurfs-Rechnung über den
 * vollen Flow.
 */
async function createSelbstzahlerDraft(
  year: number,
  month: number,
  tag: string,
): Promise<{ customerId: number; invoiceId: number }> {
  const customerId = await createCustomer({
    vorname: "BP-SZ",
    nachname: `Privat-${tag}-${uniqueId()}`,
    geburtsdatum: "1942-03-10",
    email: `bp-sz-${uniqueId()}@test.local`,
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

async function createDedicatedProvider(tag: string): Promise<{ id: number; name: string }> {
  const name = `BPKasse${tag}`;
  const ik = String(Date.now()).slice(-9).padStart(9, "0");
  const res = await apiPost<{ id: number; name: string }>("/api/admin/insurance-providers", {
    name,
    ikNummer: ik,
    isPrivate: false,
  });
  if (res.status !== 201) {
    throw new Error(`createDedicatedProvider failed: ${res.status} ${JSON.stringify(res.data)}`);
  }
  return { id: res.data.id, name: res.data.name };
}

// ---------- Bulk-print invocation (binary response) ----------

interface BulkPrintResultEntry {
  invoiceId: number;
  invoiceNumber: string;
  customerId: number;
  status: "printed" | "error";
  message?: string;
}
interface BulkPrintSummary {
  total: number;
  printed: number;
  marked: number;
  errors: number;
  groupedByPayer: boolean;
  results: BulkPrintResultEntry[];
}

async function bulkPrint(body: {
  billingMonth: number;
  billingYear: number;
  insuranceProviderId?: number;
  groupByPayer?: boolean;
}, opts?: { failInvoicePdfIds?: number[] }): Promise<{ status: number; contentType: string | null; summary: BulkPrintSummary | null; buffer: Buffer }> {
  const cookieHeader = `${auth.cookie}; careconnect_csrf=${auth.csrfToken}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Cookie: cookieHeader,
    "x-csrf-token": auth.csrfToken,
  };
  // BP-3 — gezielter Render-Fault: nur diese Rechnungs-IDs scheitern in der
  // Render-Phase (Self-Heal kann einen bloß kaputten pdfPath sonst reparieren).
  if (opts?.failInvoicePdfIds?.length) {
    headers["x-test-fail-invoice-pdf"] = opts.failInvoicePdfIds.join(",");
  }
  const res = await fetch(`${BASE_URL}/api/billing/bulk-print`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const buffer = Buffer.from(await res.arrayBuffer());
  const header = res.headers.get("x-bulk-print-summary");
  const summary = header ? (JSON.parse(decodeURIComponent(header)) as BulkPrintSummary) : null;
  return {
    status: res.status,
    contentType: res.headers.get("content-type"),
    summary,
    buffer,
  };
}

function findResult(summary: BulkPrintSummary | null, invoiceId: number): BulkPrintResultEntry | undefined {
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

describe("BP: Sammeldruck (POST /api/billing/bulk-print)", () => {
  it("BP-1 — Merged-PDF (groupByPayer=false): gültiges %PDF, markiert jeden Entwurf versendet + Audit", async () => {
    const { year, month } = recentPastWeekdayAnchor();
    const provider = await createDedicatedProvider(`M${Date.now().toString(36)}`);

    const invA = await createPflegekasseDraft(provider.id, year, month, "M-A");
    const invB = await createPflegekasseDraft(provider.id, year, month, "M-B");

    const out = await bulkPrint({
      billingMonth: month,
      billingYear: year,
      insuranceProviderId: provider.id,
      groupByPayer: false,
    });

    expect(out.status).toBe(200);
    expect(out.contentType).toContain("application/pdf");
    // Gültiges PDF: %PDF-Magic am Anfang.
    expect(out.buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");

    // Per-Kassen-Filter isoliert exakt meine zwei Rechnungen.
    expect(out.summary).not.toBeNull();
    expect(out.summary!.total).toBe(2);
    expect(out.summary!.printed).toBe(2);
    expect(out.summary!.marked).toBe(2);
    expect(out.summary!.errors).toBe(0);
    expect(out.summary!.groupedByPayer).toBe(false);

    for (const invId of [invA, invB]) {
      const entry = findResult(out.summary, invId);
      expect(entry, `Rechnung ${invId} muss im Summary stehen`).toBeDefined();
      expect(entry!.status).toBe("printed");

      const row = await getInvoiceRow(invId);
      expect(row?.status, `Rechnung ${invId} muss versendet sein`).toBe("versendet");
      expect(row?.sentAt, `Rechnung ${invId} muss sentAt tragen`).toBeTruthy();

      expect(await countBulkPrintAudit(invId), `Rechnung ${invId} braucht eine bulk_print-Audit-Zeile`).toBeGreaterThanOrEqual(1);
    }
  });

  it("BP-2 — ZIP (groupByPayer=true): application/zip mit je einer PDF pro Payer-Gruppe", async () => {
    const { year, month } = recentPastWeekdayAnchor();
    const provider = await createDedicatedProvider(`Z${Date.now().toString(36)}`);

    const kasseInv = await createPflegekasseDraft(provider.id, year, month, "Z-K");
    const { invoiceId: szInv } = await createSelbstzahlerDraft(year, month, "Z-S");

    const out = await bulkPrint({
      billingMonth: month,
      billingYear: year,
      groupByPayer: true,
    });

    expect(out.status).toBe(200);
    expect(out.contentType).toContain("application/zip");
    // ZIP-Magic „PK\x03\x04".
    expect(out.buffer.subarray(0, 2).toString("latin1")).toBe("PK");

    expect(out.summary).not.toBeNull();
    expect(out.summary!.groupedByPayer).toBe(true);

    const kasseEntry = findResult(out.summary, kasseInv);
    const szEntry = findResult(out.summary, szInv);
    expect(kasseEntry?.status, "Kassen-Rechnung muss gedruckt sein").toBe("printed");
    expect(szEntry?.status, "Selbstzahler-Rechnung muss gedruckt sein").toBe("printed");

    // ZIP entpacken und Gruppen-PDFs prüfen.
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(out.buffer);
    const entries = Object.values(zip.files).filter(f => !f.dir);
    expect(entries.length, "ZIP braucht mindestens 2 Payer-Gruppen").toBeGreaterThanOrEqual(2);

    const names = entries.map(e => e.name);
    expect(
      names.some(n => n.includes(provider.name)),
      `ZIP muss eine Gruppe für Kasse '${provider.name}' enthalten (Namen: ${names.join(", ")})`,
    ).toBe(true);
    expect(
      names.some(n => n.includes("Selbstzahler")),
      `ZIP muss eine Selbstzahler-Gruppe enthalten (Namen: ${names.join(", ")})`,
    ).toBe(true);

    // Jeder ZIP-Eintrag ist ein gültiges PDF.
    for (const entry of entries) {
      const content = await entry.async("nodebuffer");
      expect(content.subarray(0, 5).toString("latin1"), `${entry.name} muss ein PDF sein`).toBe("%PDF-");
    }

    // Beide Rechnungen sind versendet + Audit.
    for (const invId of [kasseInv, szInv]) {
      const row = await getInvoiceRow(invId);
      expect(row?.status, `Rechnung ${invId} muss versendet sein`).toBe("versendet");
      expect(row?.sentAt).toBeTruthy();
      expect(await countBulkPrintAudit(invId)).toBeGreaterThanOrEqual(1);
    }
  });

  it("BP-3 — Fehlerisolation: eine nicht renderbare Rechnung wird als error gemeldet, der Lauf läuft weiter", async () => {
    const { year, month } = recentPastWeekdayAnchor();

    // Gute, renderbare Selbstzahler-Rechnung.
    const { invoiceId: goodInv } = await createSelbstzahlerDraft(year, month, "E-GOOD");

    // Kaputte Entwurfs-Rechnung: ein gezielter Render-Fault (Header
    // `x-test-fail-invoice-pdf`, s.u.) lässt NUR diese Rechnung in der
    // Render-Phase scheitern ⇒ „Rechnungs-PDF konnte nicht geladen werden".
    // Ein bloß kaputter pdfPath taugt seit dem Self-Heal-Re-Render nicht mehr
    // als Fixture (persistInvoicePdf erzeugt das fehlende Objekt neu). Direkter
    // INSERT ist GoBD-konform (Trigger sperren nur UPDATE/DELETE finalisierter
    // Zeilen).
    const brokenCustomerId = await createCustomer({
      vorname: "BP-BROKEN",
      nachname: `Privat-E-BAD-${uniqueId()}`,
      geburtsdatum: "1940-01-01",
      email: `bp-broken-${uniqueId()}@test.local`,
      strasse: "Teststraße",
      nr: "9",
      plz: "10115",
      stadt: "Berlin",
      pflegegrad: 2,
      pflegegradSeit: "2024-01-01",
      billingType: "selbstzahler",
      acceptsPrivatePayment: true,
    });
    const inserted = await db
      .insert(invoices)
      .values({
        invoiceNumber: `BP-BROKEN-${uniqueId()}`,
        customerId: brokenCustomerId,
        billingType: "selbstzahler",
        invoiceType: "rechnung",
        billingMonth: month,
        billingYear: year,
        recipientName: "BP Broken Test",
        status: "entwurf",
        pdfPath: "/objects/invoices/__bulkprint_nonexistent__.pdf",
        netAmountCents: 100,
        vatAmountCents: 19,
        grossAmountCents: 119,
      })
      .returning({ id: invoices.id });
    const brokenInv = inserted[0].id;

    const out = await bulkPrint({
      billingMonth: month,
      billingYear: year,
      groupByPayer: false,
    }, { failInvoicePdfIds: [brokenInv] });

    // Lauf NICHT abgebrochen: gültiges PDF trotz Einzel-Fehler.
    expect(out.status).toBe(200);
    expect(out.contentType).toContain("application/pdf");
    expect(out.buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");

    expect(out.summary).not.toBeNull();
    expect(out.summary!.errors).toBeGreaterThanOrEqual(1);

    const goodEntry = findResult(out.summary, goodInv);
    expect(goodEntry?.status, "Gute Rechnung muss gedruckt sein").toBe("printed");

    const brokenEntry = findResult(out.summary, brokenInv);
    expect(brokenEntry, "Kaputte Rechnung muss im Summary stehen").toBeDefined();
    expect(brokenEntry!.status).toBe("error");
    expect(brokenEntry!.message, "Fehlermeldung muss gesetzt sein").toBeTruthy();

    // Gute Rechnung versendet; kaputte bleibt Entwurf (nicht markiert).
    const goodRow = await getInvoiceRow(goodInv);
    expect(goodRow?.status).toBe("versendet");
    expect(goodRow?.sentAt).toBeTruthy();

    const brokenRow = await getInvoiceRow(brokenInv);
    expect(brokenRow?.status, "Kaputte Rechnung darf NICHT versendet werden").toBe("entwurf");
    expect(brokenRow?.sentAt).toBeFalsy();
  });

  it("BP-4 — Leerer Monat liefert 404", async () => {
    const out = await bulkPrint({
      billingMonth: 1,
      billingYear: 2099,
      groupByPayer: false,
    });
    expect(out.status).toBe(404);
  });
});
