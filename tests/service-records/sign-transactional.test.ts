/**
 * Phase-2 Bug-Tests — LN-Sign-Tx: signServiceRecord muss transaktional sein
 *
 * Heute schreibt server/storage/service-records-storage.ts:signServiceRecord
 * den LN-Status und die Signaturdaten in einem einzigen db.update-Aufruf —
 * ohne explizite db.transaction-Klammer um den gesamten Sign-Vorgang
 * (inkl. potenzieller späterer Audit-/Folgewrites). Schlägt einer dieser
 * Folge-Writes fehl, bleibt die Signatur sichtbar bestehen, was zu
 * inkonsistentem Zustand führt.
 *
 * Erwartet (Phase-2): signServiceRecord wickelt alle Sign-Writes innerhalb
 * von db.transaction(...) ab — schlägt ein Schritt fehl, ist auch die
 * Signatur nicht persistiert.
 *
 * Test-Strategie:
 *   - In-Process-Test (vergleichbar tests/public-signing-tx.test.ts):
 *     Spy auf db.transaction injiziert einen Wrapped-tx, der den ZWEITEN
 *     update-Aufruf innerhalb der Transaktion künstlich wirft. Heute (kein
 *     tx) wird der Spy NIE aufgerufen, also passiert kein Fehler — das
 *     `expect(rejects).toThrow()` schlägt fehl, `it.fails` bleibt grün.
 *   - Sobald signServiceRecord seine Writes in db.transaction kapselt,
 *     greift der Spy, der zweite Write wirft, die Transaktion wird
 *     zurückgerollt → Signatur ist NULL und Status pending → Test passiert,
 *     `it.fails` kippt auf Rot (erinnert daran, `it.fails` zu `it` zu
 *     wechseln).
 *
 * Mapping: Test → K-Punkt → Fix-Status
 *   LN-Sign-Tx → it.fails (heute keine Tx-Klammer, kippt nach Tx-Fix)
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { monthlyServiceRecords } from "../../shared/schema";
import * as srStorage from "../../server/storage/service-records-storage";
import {
  apiGet,
  apiPost,
  apiDelete,
  getAuthCookie,
  uniqueId,
  createTestCustomer,
  createTestEmployee,
  deactivateTestEmployee,
  cleanupCustomer,
} from "../test-utils";

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
let hwServiceId: number;
let customerId: number;
let employeeId: number;
let serviceRecordId: number;
const cleanupApptIds: number[] = [];

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
  const services = await apiGet<any[]>("/api/services/all");
  hwServiceId = (services.data as any[]).find((s) => s.code === "hauswirtschaft")!.id;
  const emp = await createTestEmployee({ nachnamePrefix: "LNTx" });
  employeeId = emp.id;
  const cust = await createTestCustomer({ nachname: `Privat-LNTx-${uniqueId()}` });
  customerId = cust.id as number;

  // Termin in der Vergangenheit anlegen + dokumentieren.
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
        notes: `LNTx-${uniqueId()}`,
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
  if (!created) throw new Error("LNTx setup: kein freier Slot gefunden");
  const docRes = await apiPost<any>(`/api/appointments/${created.id}/document`, {
    actualStart: created.time,
    travelOriginType: "home",
    travelKilometers: 0,
    customerKilometers: 0,
    services: [{ serviceId: hwServiceId, actualDurationMinutes: 30, details: "LNTx" }],
  });
  if (docRes.status !== 200) throw new Error(`document failed: ${docRes.status} ${JSON.stringify(docRes.data)}`);

  const d = new Date(created.date);
  const sr = await apiPost<any>("/api/service-records", {
    customerId,
    employeeId: auth.user.id,
    year: d.getFullYear(),
    month: d.getMonth() + 1,
  });
  if (sr.status !== 201) throw new Error(`SR create failed: ${sr.status} ${JSON.stringify(sr.data)}`);
  serviceRecordId = sr.data.id;
});

afterAll(async () => {
  if (serviceRecordId) {
    try { await apiDelete(`/api/service-records/${serviceRecordId}`); } catch {}
  }
  for (const id of cleanupApptIds) {
    try { await apiDelete(`/api/appointments/${id}`); } catch {}
  }
  await cleanupCustomer(customerId);
  await deactivateTestEmployee(employeeId);
});

describe("LN-Sign-Tx — signServiceRecord ist transaktional", () => {
  it(
    "LN-Sign-Tx.1 — Bei mid-tx-Fehler bleibt Status=pending und Signatur=NULL",
    async () => {
      const originalTx = (db as any).transaction.bind(db);
      const spy = vi.spyOn(db as any, "transaction").mockImplementation(async (fn: any, ...rest: any[]) => {
        return originalTx(async (tx: any) => {
          let updateCount = 0;
          const wrappedTx: any = new Proxy(tx, {
            get(target, prop, receiver) {
              if (prop === "update") {
                return (...args: any[]) => {
                  updateCount++;
                  if (updateCount >= 2) {
                    throw new Error("__LN_SIGN_TX_INJECT__");
                  }
                  return (target as any).update(...args);
                };
              }
              return Reflect.get(target, prop, receiver);
            },
          });
          return fn(wrappedTx);
        }, ...rest);
      });

      try {
        await expect(
          srStorage.signServiceRecord(
            serviceRecordId,
            "data:image/png;base64,iVBORw0KGgo=",
            "employee",
            auth.user.id,
            "127.0.0.1",
            null,
          ),
        ).rejects.toThrow();

        // Rollback-Verifikation: Status muss pending bleiben, Signatur NULL.
        const [row] = await db
          .select({
            status: monthlyServiceRecords.status,
            employeeSignatureData: monthlyServiceRecords.employeeSignatureData,
          })
          .from(monthlyServiceRecords)
          .where(eq(monthlyServiceRecords.id, serviceRecordId))
          .limit(1);
        expect(row?.status, "Status muss nach Rollback pending sein").toBe("pending");
        expect(row?.employeeSignatureData, "Signatur muss nach Rollback NULL sein").toBeNull();
      } finally {
        spy.mockRestore();
      }
    },
    30_000,
  );
});
