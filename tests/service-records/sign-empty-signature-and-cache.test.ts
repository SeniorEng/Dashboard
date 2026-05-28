/**
 * Task #749 — Regression: signServiceRecord
 *
 * 1) Lehnt leere/triviale Signaturen mit EmptySignatureError ab und schreibt
 *    keinerlei Sign-State (Status bleibt pending, Signature-Spalten NULL).
 * 2) Bei gültiger Unterschrift werden Cache-Felder (LN + Invoice-PDF +
 *    ZUGFeRD-Fingerprint) auf NULL gesetzt — aber NUR für Rechnungen im
 *    Status `entwurf` desselben Kunden/Monats/Jahres. Versendete Rechnungen
 *    bleiben GoBD-konform unangetastet.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import zlib from "node:zlib";
import { db } from "../../server/lib/db";
import {
  monthlyServiceRecords,
  invoices as invoicesTable,
} from "../../shared/schema";
import * as srStorage from "../../server/storage/service-records-storage";
import { EmptySignatureError } from "../../server/storage/service-records-storage";
import {
  apiPost,
  apiDelete,
  getAuthCookie,
  uniqueId,
  createTestCustomer,
  createTestEmployee,
  deactivateTestEmployee,
  cleanupCustomer,
} from "../test-utils";

function crc32(): number { return 0; }
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const c = Buffer.alloc(4); c.writeUInt32BE(crc32(), 0);
  return Buffer.concat([len, t, data, c]);
}
function pngDataUrl(width: number, height: number, opaquePixels: number): string {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); ihdr.writeUInt8(6, 9);
  ihdr.writeUInt8(0, 10); ihdr.writeUInt8(0, 11); ihdr.writeUInt8(0, 12);
  const rowBytes = 1 + width * 4;
  const raw = Buffer.alloc(rowBytes * height);
  let placed = 0;
  for (let y = 0; y < height; y++) {
    raw[y * rowBytes] = 0;
    for (let x = 0; x < width; x++) {
      const off = y * rowBytes + 1 + x * 4;
      if (placed < opaquePixels) {
        // Vary colors so the deflate output doesn't compress to nothing
        // (the validator enforces a min decoded-byte payload).
        raw[off] = (placed * 31) & 0xff;
        raw[off + 1] = (placed * 67) & 0xff;
        raw[off + 2] = (placed * 113) & 0xff;
        raw[off + 3] = 255;
        placed++;
      }
    }
  }
  const idat = zlib.deflateSync(raw, { level: 0 });
  const png = Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
  return `data:image/png;base64,${png.toString("base64")}`;
}

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
let hwServiceId: number;
let customerId: number;
let employeeId: number;
let serviceRecordId: number;
let year: number;
let month: number;
const cleanupApptIds: number[] = [];
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

beforeAll(async () => {
  auth = await getAuthCookie();
  const svcRes = await fetch(`${process.env.TEST_BASE_URL || "http://localhost:5000"}/api/services/all`, {
    headers: { Cookie: auth.cookie },
  });
  const svcJson = await svcRes.json() as any[];
  hwServiceId = svcJson.find((s) => s.code === "hauswirtschaft")!.id;

  const emp = await createTestEmployee({ nachnamePrefix: "LNCache" });
  employeeId = emp.id;
  const cust = await createTestCustomer({ nachname: `Privat-LNCache-${uniqueId()}` });
  customerId = cust.id as number;

  let created: { id: number; date: string; time: string } | null = null;
  outer: for (let offset = 1; offset <= 30 && !created; offset++) {
    const cand = new Date();
    cand.setDate(cand.getDate() - offset);
    shiftToWeekday(cand);
    const dateStr = ymd(cand);
    for (const time of SEED_TIMES) {
      const res = await apiPost<any>("/api/appointments/kundentermin", {
        customerId,
        date: dateStr,
        scheduledStart: time,
        notes: `LNCache-${uniqueId()}`,
        assignedEmployeeId: auth.user.id,
        services: [{ serviceId: hwServiceId, durationMinutes: 30 }],
      });
      if (res.status === 201) {
        created = { id: res.data.id, date: dateStr, time };
        cleanupApptIds.push(res.data.id);
        break outer;
      }
    }
  }
  if (!created) throw new Error("LNCache setup: kein freier Slot gefunden");
  const docRes = await apiPost<any>(`/api/appointments/${created.id}/document`, {
    actualStart: created.time,
    travelOriginType: "home",
    travelKilometers: 0,
    customerKilometers: 0,
    services: [{ serviceId: hwServiceId, actualDurationMinutes: 30, details: "LNCache" }],
  });
  if (docRes.status !== 200) throw new Error(`document failed: ${docRes.status} ${JSON.stringify(docRes.data)}`);

  const d = new Date(created.date);
  year = d.getFullYear();
  month = d.getMonth() + 1;
  const sr = await apiPost<any>("/api/service-records", {
    customerId,
    employeeId: auth.user.id,
    year,
    month,
  });
  if (sr.status !== 201) throw new Error(`SR create failed: ${sr.status} ${JSON.stringify(sr.data)}`);
  serviceRecordId = sr.data.id;
});

afterAll(async () => {
  for (const id of cleanupInvoiceIds) {
    try { await db.delete(invoicesTable).where(eq(invoicesTable.id, id)); } catch {}
  }
  if (serviceRecordId) {
    try { await apiDelete(`/api/service-records/${serviceRecordId}`); } catch {}
  }
  for (const id of cleanupApptIds) {
    try { await apiDelete(`/api/appointments/${id}`); } catch {}
  }
  await cleanupCustomer(customerId);
  await deactivateTestEmployee(employeeId);
});

async function insertCachedInvoice(status: "entwurf" | "versendet"): Promise<number> {
  const suffix = uniqueId();
  const [row] = await db.insert(invoicesTable).values({
    invoiceNumber: `TEST-${suffix}`,
    customerId,
    billingType: "private",
    invoiceType: "rechnung",
    billingMonth: month,
    billingYear: year,
    recipientName: `Test ${suffix}`,
    status,
    leistungsnachweisPath: `/test/ln-${suffix}.pdf`,
    leistungsnachweisHash: `hash-ln-${suffix}`,
    leistungsnachweisDataFingerprint: `fp-ln-${suffix}`,
    pdfPath: `/test/pdf-${suffix}.pdf`,
    pdfHash: `hash-pdf-${suffix}`,
    pdfDataFingerprint: `fp-pdf-${suffix}`,
  } as any).returning({ id: invoicesTable.id });
  cleanupInvoiceIds.push(row.id);
  return row.id;
}

describe("signServiceRecord — empty signature + cache invalidation (Task #749)", () => {
  it(
    "rejects empty-canvas PNG with EmptySignatureError and does not mutate sign state",
    async () => {
      const empty = pngDataUrl(40, 20, 0);
      await expect(
        srStorage.signServiceRecord(serviceRecordId, empty, "employee", auth.user.id, "127.0.0.1", null),
      ).rejects.toBeInstanceOf(EmptySignatureError);

      const [row] = await db
        .select({
          status: monthlyServiceRecords.status,
          employeeSignatureData: monthlyServiceRecords.employeeSignatureData,
        })
        .from(monthlyServiceRecords)
        .where(eq(monthlyServiceRecords.id, serviceRecordId))
        .limit(1);
      expect(row?.status).toBe("pending");
      expect(row?.employeeSignatureData).toBeNull();
    },
    30_000,
  );

  it(
    "nulls LN + PDF cache fields on entwurf invoices and leaves versendet invoices untouched",
    async () => {
      const entwurfId = await insertCachedInvoice("entwurf");
      const versendetId = await insertCachedInvoice("versendet");

      const real = pngDataUrl(100, 40, 2000);
      await srStorage.signServiceRecord(serviceRecordId, real, "employee", auth.user.id, "127.0.0.1", null);

      const [entwurf] = await db.select({
        ln: invoicesTable.leistungsnachweisPath,
        lnH: invoicesTable.leistungsnachweisHash,
        lnFp: invoicesTable.leistungsnachweisDataFingerprint,
        pdf: invoicesTable.pdfPath,
        pdfH: invoicesTable.pdfHash,
        pdfFp: invoicesTable.pdfDataFingerprint,
      }).from(invoicesTable).where(eq(invoicesTable.id, entwurfId)).limit(1);
      expect(entwurf?.ln).toBeNull();
      expect(entwurf?.lnH).toBeNull();
      expect(entwurf?.lnFp).toBeNull();
      expect(entwurf?.pdf).toBeNull();
      expect(entwurf?.pdfH).toBeNull();
      expect(entwurf?.pdfFp).toBeNull();

      const [versendet] = await db.select({
        ln: invoicesTable.leistungsnachweisPath,
        pdf: invoicesTable.pdfPath,
        pdfH: invoicesTable.pdfHash,
        pdfFp: invoicesTable.pdfDataFingerprint,
      }).from(invoicesTable).where(eq(invoicesTable.id, versendetId)).limit(1);
      expect(versendet?.ln, "GoBD: versendet darf NICHT invalidiert werden").not.toBeNull();
      expect(versendet?.pdf, "GoBD: versendet-PDF darf NICHT invalidiert werden").not.toBeNull();
      expect(versendet?.pdfH).not.toBeNull();
      expect(versendet?.pdfFp).not.toBeNull();
    },
    30_000,
  );
});
