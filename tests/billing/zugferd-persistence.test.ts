/**
 * Tier-A3 — Persistenz von ZUGFeRD-XML + PDF-Hash auf der Rechnungs-Zeile.
 *
 * Nach POST /api/billing/generate MUSS invoices.zugferd_xml den XML-Inhalt
 * der eingebetteten Factur-X-Datei enthalten und invoices.pdf_hash den
 * SHA-256 des persistierten PDFs. Außerdem muss verifyInvoiceIntegrity()
 * für die frisch erzeugte Rechnung xmlMatch=true und pdfHashMatch=true
 * liefern, da PDF + XML deterministisch re-renderbar sind.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { invoices as invoicesTable } from "../../shared/schema";
import {
  apiGet,
  apiPost,
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
const SEED_TIMES = ["00:00", "00:30", "01:00", "01:30", "02:00", "21:00", "21:30", "22:00", "22:30", "23:00", "23:30"];

async function findFreeSlotAndCreate(custId: number, tag: string): Promise<{ id: number; date: string; time: string }> {
  for (let offset = 1; offset <= 60; offset++) {
    const cand = new Date();
    cand.setDate(cand.getDate() - offset);
    shiftToWeekday(cand);
    const dateStr = ymd(cand);
    for (const time of SEED_TIMES) {
      const res = await apiPost<any>("/api/appointments/kundentermin", {
        customerId: custId,
        date: dateStr,
        scheduledStart: time,
        notes: `ZFP-${tag}-${uniqueId()}`,
        assignedEmployeeId: auth.user.id,
        services: [{ serviceId: hwServiceId, durationMinutes: 30 }],
      });
      if (res.status === 201) {
        cleanupApptIds.push(res.data.id);
        return { id: res.data.id, date: dateStr, time };
      }
    }
  }
  throw new Error("findFreeSlotAndCreate(ZFP): kein freier Slot");
}

beforeAll(async () => {
  auth = await getAuthCookie();
  const services = await apiGet<any[]>("/api/services/all");
  hwServiceId = (services.data as any[]).find((s) => s.code === "hauswirtschaft")!.id;
  const cust = await createTestCustomer({
    nachname: `Privat-ZFP-${uniqueId()}`,
    billingType: "selbstzahler",
    acceptsPrivatePayment: true,
  });
  customerId = cust.id as number;
});

afterAll(async () => {
  for (const id of cleanupInvoiceIds) {
    try { await apiDelete(`/api/billing/${id}`); } catch {}
  }
  for (const id of cleanupSrIds) {
    try { await apiDelete(`/api/service-records/${id}`); } catch {}
  }
  for (const id of cleanupApptIds) {
    try { await apiDelete(`/api/appointments/${id}`); } catch {}
  }
  await cleanupCustomer(customerId);
});

describe("ZUGFeRD-Persistenz — invoices.zugferd_xml + Integrity-Verifier", () => {
  it("ZFP.1 — /generate persistiert zugferd_xml und re-render matcht (Integrity-Check ok)", async () => {
    const slot = await findFreeSlotAndCreate(customerId, "G");
    const docRes = await apiPost<any>(`/api/appointments/${slot.id}/document`, {
      actualStart: slot.time,
      travelOriginType: "home",
      travelKilometers: 0,
      customerKilometers: 0,
      services: [{ serviceId: hwServiceId, actualDurationMinutes: 30, details: "ZFP" }],
    });
    expect(docRes.status, `document: ${JSON.stringify(docRes.data)}`).toBe(200);

    const d = new Date(slot.date);
    const year = d.getFullYear();
    const month = d.getMonth() + 1;

    const sr = await apiPost<any>("/api/service-records", {
      customerId,
      employeeId: auth.user.id,
      year,
      month,
    });
    expect(sr.status, `SR create: ${JSON.stringify(sr.data)}`).toBe(201);
    cleanupSrIds.push(sr.data.id);
    for (const signerType of ["employee", "customer"] as const) {
      const sig = await apiPost<any>(`/api/service-records/${sr.data.id}/sign`, {
        signerType,
        signatureData: "data:image/png;base64,iVBORw0KGgo=",
      });
      expect(sig.status, `sign(${signerType}): ${JSON.stringify(sig.data)}`).toBe(200);
    }

    const gen = await apiPost<any>("/api/billing/generate", {
      customerId,
      billingMonth: month,
      billingYear: year,
    });
    expect(gen.status, `generate: ${JSON.stringify(gen.data)}`).toBe(200);
    const inv: any = gen.data?.splitInvoices ? gen.data.invoices[0]
      : Array.isArray(gen.data) ? gen.data[0]
      : gen.data;
    expect(inv?.id, "Rechnung muss erzeugt sein").toBeDefined();
    cleanupInvoiceIds.push(inv.id);

    // Task #544: persistInvoicePdf läuft nach /generate im Hintergrund.
    // Auf das Erscheinen von zugferd_xml warten (bis 30s).
    let row: { zugferdXml: string | null; pdfHash: string | null } | undefined;
    for (let i = 0; i < 60; i++) {
      [row] = await db
        .select({ zugferdXml: invoicesTable.zugferdXml, pdfHash: invoicesTable.pdfHash })
        .from(invoicesTable)
        .where(eq(invoicesTable.id, inv.id))
        .limit(1);
      if (row?.zugferdXml && row?.pdfHash) break;
      await new Promise((r) => setTimeout(r, 500));
    }

    expect(
      row?.zugferdXml,
      `ZUGFeRD-Persistenz-Bug: invoices.zugferd_xml ist nach /generate NULL`,
    ).not.toBeNull();
    expect(typeof row?.zugferdXml).toBe("string");
    expect(
      (row?.zugferdXml || "").length,
      "zugferd_xml muss substanziellen XML-Inhalt enthalten",
    ).toBeGreaterThan(500);
    expect(row?.zugferdXml).toContain("CrossIndustryInvoice");
    expect(row?.pdfHash, "pdf_hash darf nach /generate nicht NULL sein").not.toBeNull();

    // Integrity-Verifier muss xmlMatch=true und pdfHashMatch=true liefern.
    const { verifyInvoiceIntegrity } = await import("../../server/services/invoice-integrity-verifier");
    const result = await verifyInvoiceIntegrity(inv.id);
    expect(result, "Verifier liefert Ergebnis").not.toBeNull();
    expect(result?.xmlMatch, "Re-render-XML muss byte-genau gegen persistiertes XML matchen").toBe(true);
    expect(result?.pdfHashMatch, "Re-render-PDF-Hash muss gegen persistierten pdfHash matchen").toBe(true);
  }, 60_000);
});
