/**
 * Task #978 — Regression: Wer darf einen Leistungsnachweis unterschreiben?
 *
 * Bug: Der Sign-Endpoint (`POST /api/service-records/:id/sign`) verglich nur
 * `existingRecord.employeeId === req.user.id` und blockierte damit den
 * Vertretungs-/Backup-Mitarbeiter, der den Termin tatsächlich geleistet hat,
 * mit HTTP 403 — obwohl der Leistungsnachweis weiterhin dem ursprünglich
 * zugeordneten Mitarbeiter "gehört".
 *
 * Fix: Unterschreiben darf der zugeordnete Mitarbeiter (record.employeeId)
 * ODER wer einen der enthaltenen Termine geleistet (performedByEmployeeId)
 * bzw. zugewiesen bekommen hat (assignedEmployeeId). Admins immer. Ein
 * fremder Mitarbeiter mit Kunden-Zugriff, aber ohne Bezug zu den Terminen,
 * bleibt blockiert.
 *
 * Beide Fälle laufen über den echten HTTP-Endpoint mit nicht-Admin-Logins.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import zlib from "node:zlib";
import { eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { appointments } from "../../shared/schema";
import {
  apiPost,
  apiPatch,
  apiDelete,
  apiPostAs,
  getAuthCookie,
  loginAs,
  uniqueId,
  createTestCustomer,
  createTestEmployee,
  cleanupCustomer,
} from "../test-utils";

// --- Valider Mini-PNG (genug opake Pixel, damit die Signatur-Validierung
//     greift) — identische Erzeugung wie in sign-empty-signature-and-cache. ---
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const c = Buffer.alloc(4); c.writeUInt32BE(0, 0);
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
const VALID_SIGNATURE = pngDataUrl(100, 40, 2000);

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function pastWeekday(): Date {
  const d = new Date();
  for (let i = 1; i <= 10; i++) {
    const cand = new Date();
    cand.setDate(cand.getDate() - i);
    const dow = cand.getDay();
    // Im selben Monat bleiben (Monatsabschluss-Gate vermeiden) und Werktag.
    if (dow !== 0 && dow !== 6 && cand.getMonth() === d.getMonth()) return cand;
  }
  // Fallback: heute (falls Monatsanfang) — ggf. Wochenende, aber selber Monat.
  return d;
}

let admin: Awaited<ReturnType<typeof getAuthCookie>>;
let performer: { id: number; email: string; password: string };
let bystander: { id: number; email: string; password: string };
let customerId: number;
let hwServiceId: number;
let recordForPerformerId: number;
let recordForAssigneeId: number;
let recordForBystanderId: number;
const cleanupApptIds: number[] = [];

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";

async function createDocumentedAppointment(date: string, time: string): Promise<number> {
  const apptRes = await apiPost<any>("/api/appointments/kundentermin", {
    customerId,
    date,
    scheduledStart: time,
    services: [{ serviceId: hwServiceId, durationMinutes: 30 }],
    assignedEmployeeId: admin.user.id,
    notes: `T978-${uniqueId()}`,
  });
  if (apptRes.status !== 201) {
    throw new Error(`appointment failed: ${apptRes.status} ${JSON.stringify(apptRes.data)}`);
  }
  cleanupApptIds.push(apptRes.data.id);
  const docRes = await apiPost<any>(`/api/appointments/${apptRes.data.id}/document`, {
    actualStart: time,
    travelOriginType: "home",
    travelKilometers: 0,
    customerKilometers: 0,
    services: [{ serviceId: hwServiceId, actualDurationMinutes: 30, details: "T978" }],
  });
  if (docRes.status !== 200) {
    throw new Error(`document failed: ${docRes.status} ${JSON.stringify(docRes.data)}`);
  }
  return apptRes.data.id;
}

async function createMonthlyRecord(year: number, month: number): Promise<number> {
  const res = await apiPost<any>("/api/service-records", {
    customerId,
    employeeId: admin.user.id,
    year,
    month,
  });
  if (res.status !== 201) {
    throw new Error(`SR create failed: ${res.status} ${JSON.stringify(res.data)}`);
  }
  return res.data.id;
}

beforeAll(async () => {
  admin = await getAuthCookie();

  const svcRes = await fetch(`${BASE_URL}/api/services/all`, { headers: { Cookie: admin.cookie } });
  const svcJson = (await svcRes.json()) as any[];
  hwServiceId = svcJson.find((s) => s.code === "hauswirtschaft")!.id;

  performer = await createTestEmployee({ nachnamePrefix: "T978_Performer" });
  bystander = await createTestEmployee({ nachnamePrefix: "T978_Bystander" });

  const cust = await createTestCustomer({ nachname: `Privat-T978-${uniqueId()}` });
  customerId = cust.id as number;

  // Admin = Primär, performer = Backup, bystander = Backup2.
  // → beide Nicht-Admins haben Kunden-Zugriff (canAccessCustomer), aber nur
  //   performer wird unten als tatsächlicher Leistender markiert.
  const assignRes = await apiPatch<any>(`/api/admin/customers/${customerId}/assign`, {
    primaryEmployeeId: admin.user.id,
    backupEmployeeId: performer.id,
    backupEmployeeId2: bystander.id,
  });
  if (assignRes.status !== 200) {
    throw new Error(`assign failed: ${assignRes.status} ${JSON.stringify(assignRes.data)}`);
  }

  const day = pastWeekday();
  const year = day.getFullYear();
  const month = day.getMonth() + 1;
  const dateStr = ymd(day);

  // Termin 1 → eigener Monatsnachweis (gehört Admin), danach als von
  // `performer` geleistet markieren.
  const appt1 = await createDocumentedAppointment(dateStr, "08:00");
  recordForPerformerId = await createMonthlyRecord(year, month);
  await db
    .update(appointments)
    .set({ performedByEmployeeId: performer.id })
    .where(eq(appointments.id, appt1));

  // Termin 2 → dritter Allow-Pfad: `performer` ist dem Termin ZUGEWIESEN
  // (assignedEmployeeId), hat ihn aber nicht geleistet (performedBy = null).
  const appt2 = await createDocumentedAppointment(dateStr, "08:30");
  recordForAssigneeId = await createMonthlyRecord(year, month);
  await db
    .update(appointments)
    .set({ assignedEmployeeId: performer.id, performedByEmployeeId: null })
    .where(eq(appointments.id, appt2));

  // Termin 3 (nach Anlage der Vorgänger, damit er separat abgedeckt wird) →
  // Monatsnachweis bleibt `performer`-/`bystander`-fremd (zugeordnet/geleistet
  // = Admin).
  await createDocumentedAppointment(dateStr, "09:00");
  recordForBystanderId = await createMonthlyRecord(year, month);
});

afterAll(async () => {
  for (const id of [recordForPerformerId, recordForAssigneeId, recordForBystanderId]) {
    if (id) {
      try { await apiDelete(`/api/service-records/${id}`); } catch {}
    }
  }
  for (const id of cleanupApptIds) {
    try { await apiDelete(`/api/appointments/${id}`); } catch {}
  }
  await cleanupCustomer(customerId);
});

describe("service-record sign authorization (Task #978)", () => {
  it(
    "lässt den tatsächlich leistenden (Backup-)Mitarbeiter unterschreiben, auch wenn ihm der Nachweis nicht gehört",
    async () => {
      const authPerformer = await loginAs(performer.email, performer.password);
      const res = await apiPostAs<any>(authPerformer, `/api/service-records/${recordForPerformerId}/sign`, {
        signatureData: VALID_SIGNATURE,
        signerType: "employee",
        signingLocation: null,
      });
      expect(res.status, JSON.stringify(res.data)).toBe(200);
      expect(res.data?.employeeSignedAt ?? res.data?.status).toBeTruthy();
    },
    60_000,
  );

  it(
    "lässt den dem Termin ZUGEWIESENEN Mitarbeiter unterschreiben, auch ohne gesetztes performedBy",
    async () => {
      const authAssignee = await loginAs(performer.email, performer.password);
      const res = await apiPostAs<any>(authAssignee, `/api/service-records/${recordForAssigneeId}/sign`, {
        signatureData: VALID_SIGNATURE,
        signerType: "employee",
        signingLocation: null,
      });
      expect(res.status, JSON.stringify(res.data)).toBe(200);
      expect(res.data?.employeeSignedAt ?? res.data?.status).toBeTruthy();
    },
    60_000,
  );

  it(
    "blockiert einen fremden Mitarbeiter (Zugriff, aber kein Bezug zu den Terminen) mit 403 und klarer Meldung",
    async () => {
      const authBystander = await loginAs(bystander.email, bystander.password);
      const res = await apiPostAs<any>(authBystander, `/api/service-records/${recordForBystanderId}/sign`, {
        signatureData: VALID_SIGNATURE,
        signerType: "employee",
        signingLocation: null,
      });
      expect(res.status).toBe(403);
      expect(String(res.data?.message)).toContain("zugeordnete oder der ausführende Mitarbeiter");
    },
    60_000,
  );
});
