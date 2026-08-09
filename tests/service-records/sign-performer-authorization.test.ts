/**
 * Task #1896 — Wer darf einen Leistungsnachweis unterschreiben?
 *
 * **Diese Datei ERSETZT den Vertrag aus Task #978.** #978 hatte den Kreis der
 * Unterzeichner über den zugeordneten Mitarbeiter hinaus erweitert: auch wer
 * einen der enthaltenen Termine geleistet (`performedByEmployeeId`) oder
 * zugewiesen bekommen hatte (`assignedEmployeeId`), durfte unterschreiben. Das
 * war nötig, SOLANGE ein Nachweis fremde Termine enthalten konnte — die
 * Stammkraft-Ausnahme bündelte die Termine aller Kollegen eines Kunden in einen
 * Nachweis.
 *
 * Seit #1896 ist der Umfang eines Nachweises auf die EIGENEN Termine begrenzt.
 * Damit ist der zugeordnete Mitarbeiter per Konstruktion auch der Erbringer,
 * und die #978-Erweiterung ließe nur noch genau das zu, was die GoBD-Regel
 * „Erbringer = Unterzeichner" verbietet: dass B unterschreibt, was A geleistet
 * hat. Sie ist deshalb zurückgenommen.
 *
 * Alrik hat die Weiche am 08.08.2026 entschieden; abgesichert durch die
 * Prod-Abfrage `docs/p1-1896-performer-vs-assigned-exposure.sql`
 * (`performed_by` und `assigned` fallen in KEINEM Termin auseinander — die
 * Verengung nimmt niemandem eine heute genutzte Unterschrift).
 *
 * Alle Fälle laufen über den echten HTTP-Endpoint mit nicht-Admin-Logins.
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
let owner: { id: number; email: string; password: string };
let bystander: { id: number; email: string; password: string };
let customerId: number;
let hwServiceId: number;
/** Nachweis, der `owner` gehört (über seinen eigenen Termin entstanden). */
let recordOwnedByOwnerId: number;
/** Nachweis, der dem Admin gehört — `owner` ist nur der Erbringer des Termins. */
let recordOwnedByAdminId: number;
const cleanupApptIds: number[] = [];

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";

async function createDocumentedAppointment(date: string, time: string, assignedEmployeeId: number): Promise<number> {
  const apptRes = await apiPost<any>("/api/appointments/kundentermin", {
    customerId,
    date,
    scheduledStart: time,
    services: [{ serviceId: hwServiceId, durationMinutes: 30 }],
    assignedEmployeeId,
    notes: `T1896-${uniqueId()}`,
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
    services: [{ serviceId: hwServiceId, actualDurationMinutes: 30, details: "T1896" }],
    performedByEmployeeId: assignedEmployeeId,
  });
  if (docRes.status !== 200) {
    throw new Error(`document failed: ${docRes.status} ${JSON.stringify(docRes.data)}`);
  }
  return apptRes.data.id;
}

async function createMonthlyRecord(employeeId: number, year: number, month: number): Promise<number> {
  const res = await apiPost<any>("/api/service-records", {
    customerId,
    employeeId,
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

  owner = await createTestEmployee({ nachnamePrefix: "T1896_Owner" });
  bystander = await createTestEmployee({ nachnamePrefix: "T1896_Bystander" });

  const cust = await createTestCustomer({ nachname: `Privat-T1896-${uniqueId()}` });
  customerId = cust.id as number;

  // Admin = Primär (die frühere „Stammkraft"), owner = Backup,
  // bystander = Backup2 → alle drei haben Kunden-Zugriff (canAccessCustomer).
  // Genau deshalb reicht Zugriff als Unterschrifts-Kriterium nicht.
  const assignRes = await apiPatch<any>(`/api/admin/customers/${customerId}/assign`, {
    primaryEmployeeId: admin.user.id,
    backupEmployeeId: owner.id,
    backupEmployeeId2: bystander.id,
  });
  if (assignRes.status !== 200) {
    throw new Error(`assign failed: ${assignRes.status} ${JSON.stringify(assignRes.data)}`);
  }

  const day = pastWeekday();
  const year = day.getFullYear();
  const month = day.getMonth() + 1;
  const dateStr = ymd(day);

  // Termin 1 gehört `owner` (zugewiesen UND geleistet) → sein eigener Nachweis.
  await createDocumentedAppointment(dateStr, "08:00", owner.id);
  recordOwnedByOwnerId = await createMonthlyRecord(owner.id, year, month);

  // Termin 2 gehört dem Admin → Nachweis auf den Admin. ERST DANACH wird
  // `performed_by` auf `owner` umgebogen: der Nachweis weist damit einen
  // Erbringer aus, der nicht sein Mitarbeiter ist — genau die Konstellation,
  // die #978 zum Unterschreiben freigab und #1896 wieder sperrt. Über die
  // Anwendung ist sie nach #1896 nicht mehr herstellbar, deshalb der
  // direkte DB-Eingriff.
  const appt2 = await createDocumentedAppointment(dateStr, "08:30", admin.user.id);
  recordOwnedByAdminId = await createMonthlyRecord(admin.user.id, year, month);
  await db
    .update(appointments)
    .set({ performedByEmployeeId: owner.id })
    .where(eq(appointments.id, appt2));
});

afterAll(async () => {
  for (const id of [recordOwnedByOwnerId, recordOwnedByAdminId]) {
    if (id) {
      try { await apiDelete(`/api/service-records/${id}`); } catch {}
    }
  }
  for (const id of cleanupApptIds) {
    try { await apiDelete(`/api/appointments/${id}`); } catch {}
  }
  await cleanupCustomer(customerId);
});

describe("Leistungsnachweis-Unterschrift: nur der zugeordnete Mitarbeiter (Task #1896)", () => {
  it(
    "blockiert den ERBRINGER eines enthaltenen Termins, wenn ihm der Nachweis nicht gehört (Rücknahme #978)",
    async () => {
      const auth = await loginAs(owner.email, owner.password);
      const res = await apiPostAs<any>(auth, `/api/service-records/${recordOwnedByAdminId}/sign`, {
        signatureData: VALID_SIGNATURE,
        signerType: "employee",
        signingLocation: null,
      });
      expect(res.status, JSON.stringify(res.data)).toBe(403);
      expect(String(res.data?.message)).toContain("zugeordnete Mitarbeiter");
    },
    60_000,
  );

  it(
    "blockiert einen fremden Mitarbeiter mit Kunden-Zugriff, aber ohne Bezug zum Nachweis",
    async () => {
      const auth = await loginAs(bystander.email, bystander.password);
      const res = await apiPostAs<any>(auth, `/api/service-records/${recordOwnedByOwnerId}/sign`, {
        signatureData: VALID_SIGNATURE,
        signerType: "employee",
        signingLocation: null,
      });
      expect(res.status).toBe(403);
      expect(String(res.data?.message)).toContain("zugeordnete Mitarbeiter");
    },
    60_000,
  );

  it(
    "lässt den zugeordneten Mitarbeiter seinen EIGENEN Nachweis unterschreiben",
    async () => {
      const auth = await loginAs(owner.email, owner.password);
      const res = await apiPostAs<any>(auth, `/api/service-records/${recordOwnedByOwnerId}/sign`, {
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
    "lässt den Admin weiterhin auch fremde Nachweise unterschreiben (Büro-Pfad bleibt)",
    async () => {
      const res = await apiPost<any>(`/api/service-records/${recordOwnedByAdminId}/sign`, {
        signatureData: VALID_SIGNATURE,
        signerType: "employee",
        signingLocation: null,
      });
      expect(res.status, JSON.stringify(res.data)).toBe(200);
    },
    60_000,
  );
});
