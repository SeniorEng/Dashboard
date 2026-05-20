/**
 * Phase-2 Bug-Tests — PDF-Hash bei Rechnungs-Generierung
 *
 * Heute befüllt POST /api/billing/generate die Spalte invoices.pdf_hash
 * NICHT — sie bleibt nach Generierung NULL. Die /pdf-Route rendert das PDF
 * jedes Mal neu, ohne Persistenz. Damit ist eine spätere Manipulationen-
 * Erkennung unmöglich.
 *
 * Erwartet (Phase-2): /generate persistiert pdf_hash = sha256(pdf-bytes)
 * (über computeDataHash, identisch zum Hash-Helper aus
 * server/services/signature-integrity.ts) genau auf den Bytes, die beim
 * GET /:id/pdf-Endpoint ausgeliefert werden.
 *
 * Mapping: Test → K-Punkt → Fix-Status
 *   PDF-Hash → it.fails (heute pdf_hash=NULL, kippt nach Persistenz-Fix)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { invoices as invoicesTable } from "../../shared/schema";
import { computeDataHash } from "../../server/services/signature-integrity";
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

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";

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
        notes: `PDFH-${tag}-${uniqueId()}`,
        assignedEmployeeId: auth.user.id,
        services: [{ serviceId: hwServiceId, durationMinutes: 30 }],
      });
      if (res.status === 201) {
        cleanupApptIds.push(res.data.id);
        return { id: res.data.id, date: dateStr, time };
      }
    }
  }
  throw new Error("findFreeSlotAndCreate(PDFH): kein freier Slot");
}

beforeAll(async () => {
  auth = await getAuthCookie();
  const services = await apiGet<any[]>("/api/services/all");
  hwServiceId = (services.data as any[]).find((s) => s.code === "hauswirtschaft")!.id;
  const cust = await createTestCustomer({
    nachname: `Privat-PDFH-${uniqueId()}`,
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

describe("PDF-Hash — invoices.pdf_hash wird bei Generierung befüllt", () => {
  it("PDFH.1 — pdf_hash != NULL und identisch zu computeDataHash(pdf-bytes)", async () => {
    const slot = await findFreeSlotAndCreate(customerId, "G");
    const docRes = await apiPost<any>(`/api/appointments/${slot.id}/document`, {
      actualStart: slot.time,
      travelOriginType: "home",
      travelKilometers: 0,
      customerKilometers: 0,
      services: [{ serviceId: hwServiceId, actualDurationMinutes: 30, details: "PDFH" }],
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
    // Auf das Erscheinen des pdf_hash warten (bis 30s).
    let row: { pdfHash: string | null } | undefined;
    for (let i = 0; i < 60; i++) {
      [row] = await db
        .select({ pdfHash: invoicesTable.pdfHash })
        .from(invoicesTable)
        .where(eq(invoicesTable.id, inv.id))
        .limit(1);
      if (row?.pdfHash) break;
      await new Promise((r) => setTimeout(r, 500));
    }

    expect(
      row?.pdfHash,
      `PDF-Hash-Bug: invoices.pdf_hash ist nach /generate ${row?.pdfHash === null ? "NULL" : `'${row?.pdfHash}'`} (erwartet sha256-Hex)`,
    ).not.toBeNull();
    expect(typeof row?.pdfHash).toBe("string");
    expect((row?.pdfHash || "").length, "sha256-Hex muss 64 Zeichen lang sein").toBe(64);

    // Hash gegen tatsächliche PDF-Bytes prüfen.
    const pdfRes = await fetch(`${BASE_URL}/api/billing/${inv.id}/pdf`, {
      headers: { Cookie: auth.cookie },
    });
    expect(pdfRes.status).toBe(200);
    const buf = Buffer.from(await pdfRes.arrayBuffer());
    expect(buf.byteLength, "PDF-Buffer muss > 1KB sein").toBeGreaterThan(1024);
    // computeDataHash akzeptiert zur Laufzeit auch Buffer (createHash.update
    // ist Buffer-tolerant); der Helper-Call entspricht dem zukünftigen Fix.
    const expectedHash = computeDataHash(buf as unknown as string);
    expect(
      row?.pdfHash,
      `PDF-Hash-Bug: persistierter Hash matcht nicht den /pdf-Bytes (gespeichert=${row?.pdfHash}, erwartet=${expectedHash})`,
    ).toBe(expectedHash);
  }, 60_000);
});
