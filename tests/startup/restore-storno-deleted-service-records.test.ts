/**
 * Task #578 — Sicherheitstests für die Backfill-Migration
 * `restore-storno-deleted-service-records` (Task #576).
 *
 * Statt der hardcodierten Prod-IDs (8 / 48) arbeitet der Test mit eigenen,
 * dynamisch angelegten Test-Fixtures (Customer + Employee + Service-Record)
 * und injiziert sie über `restoreServiceRecordsByTuples({ expectedRecords, … })`.
 *
 * Geprüft werden alle vier in der Skill-Spec definierten Verteidigungen:
 *   1. **Happy Path**: passendes Tupel + Fenster + Akteur → reaktiviert + Audit.
 *   2. **One-Shot-Guard**: zweiter Lauf ist No-Op (Idempotenz).
 *   3. **Tuple-Mismatch**: falsche customerId → kein Restore.
 *   4. **Fenster-Mismatch**: deletedAt außerhalb des Incident-Fensters → kein Restore.
 *   5. **Fehlender Audit-Akteur**: kein Super-/Admin in DB → Skip ohne Mutation.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../server/lib/db";
import {
  customers,
  monthlyServiceRecords,
  users,
  auditLog,
} from "@shared/schema";
import {
  restoreServiceRecordsByTuples,
  type ExpectedRecord,
} from "../../server/startup/restore-storno-deleted-service-records";
import {
  assertSecondRunIsNoOp,
  assertNoOpForMismatch,
  assertSkipsWithoutAuditActor,
  type BackfillSnapshot,
} from "./backfill-guard-pattern";
import { uniqueId } from "../test-utils";

const TAG = `t578-${uniqueId()}`;
const WINDOW_START = new Date("2099-01-01T00:00:00.000Z");
const WINDOW_END = new Date("2099-01-31T23:59:59.999Z");
const INSIDE_WINDOW = new Date("2099-01-15T12:00:00.000Z");
const OUTSIDE_WINDOW = new Date("2099-06-15T12:00:00.000Z");

let customerId: number;
let otherCustomerId: number;
let employeeId: number;
let recordIds: number[] = [];
const createdUserIds: number[] = [];
const createdCustomerIds: number[] = [];
const flippedAdminUserIds: number[] = [];
const flippedSuperUserIds: number[] = [];

async function insertCustomer(label: string): Promise<number> {
  const [row] = await db.insert(customers).values({
    name: `T578-${label}-${TAG}`,
    address: `Backfill-Teststraße 1, 10115 Berlin`,
    vorname: "T578",
    nachname: `${label}-${TAG}`,
    billingType: "selbstzahler",
  } as any).returning({ id: customers.id });
  createdCustomerIds.push(row.id);
  return row.id;
}

async function insertEmployee(): Promise<number> {
  const [row] = await db.insert(users).values({
    email: `t578-${TAG}@example.invalid`,
    passwordHash: "x".repeat(20),
    displayName: `T578 Employee ${TAG}`,
  } as any).returning({ id: users.id });
  createdUserIds.push(row.id);
  return row.id;
}

async function insertSoftDeletedRecord(
  cId: number,
  eId: number,
  year: number,
  month: number,
  deletedAt: Date,
  status: string = "completed",
): Promise<number> {
  const [row] = await db.insert(monthlyServiceRecords).values({
    customerId: cId,
    employeeId: eId,
    year,
    month,
    recordType: "monthly",
    status,
    deletedAt,
  } as any).returning({ id: monthlyServiceRecords.id });
  return row.id;
}

async function snapshotState(ids: number[]): Promise<BackfillSnapshot> {
  if (ids.length === 0) return { data: [], auditCount: 0 };
  const rows = await db
    .select({
      id: monthlyServiceRecords.id,
      customerId: monthlyServiceRecords.customerId,
      employeeId: monthlyServiceRecords.employeeId,
      year: monthlyServiceRecords.year,
      month: monthlyServiceRecords.month,
      status: monthlyServiceRecords.status,
      deletedAtIsNull: sql<boolean>`${monthlyServiceRecords.deletedAt} IS NULL`,
    })
    .from(monthlyServiceRecords)
    .where(inArray(monthlyServiceRecords.id, ids))
    .orderBy(monthlyServiceRecords.id);

  const audits = await db
    .select({ entityId: auditLog.entityId })
    .from(auditLog)
    .where(and(
      eq(auditLog.action, "service_record_resurrected"),
      eq(auditLog.entityType, "service_record"),
      inArray(auditLog.entityId, ids),
    ));

  return { data: rows, auditCount: audits.length };
}

async function resetRecordToSoftDeleted(id: number, deletedAt: Date): Promise<void> {
  await db.update(monthlyServiceRecords)
    .set({ deletedAt })
    .where(eq(monthlyServiceRecords.id, id));
  // audit_log ist GoBD-unveränderbar (Trigger, Task #824) — Löschen nur über
  // den transaktions-lokalen Bypass-GUC.
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL app.allow_audit_log_mutation = 'on'`);
    await tx.delete(auditLog).where(and(
      eq(auditLog.action, "service_record_resurrected"),
      eq(auditLog.entityType, "service_record"),
      eq(auditLog.entityId, id),
    ));
  });
}

beforeAll(async () => {
  customerId = await insertCustomer("customer");
  otherCustomerId = await insertCustomer("other");
  employeeId = await insertEmployee();
});

beforeEach(async () => {
  // Frische Records pro Test, damit der One-Shot-Guard zwischen Tests sauber ist.
  const a = await insertSoftDeletedRecord(customerId, employeeId, 2099, 1, INSIDE_WINDOW);
  const b = await insertSoftDeletedRecord(customerId, employeeId, 2099, 2, INSIDE_WINDOW);
  recordIds = [a, b];
});

afterEach(async () => {
  if (recordIds.length > 0) {
    // audit_log ist GoBD-unveränderbar (Trigger, Task #824) — Löschen nur über
    // den transaktions-lokalen Bypass-GUC.
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL app.allow_audit_log_mutation = 'on'`);
      await tx.delete(auditLog).where(and(
        eq(auditLog.action, "service_record_resurrected"),
        eq(auditLog.entityType, "service_record"),
        inArray(auditLog.entityId, recordIds),
      ));
    });
    await db.delete(monthlyServiceRecords).where(inArray(monthlyServiceRecords.id, recordIds));
    recordIds = [];
  }
});

afterAll(async () => {
  // Sicherheitsnetz: ggf. übrig gebliebenen Akteur-Flag-Flip rückgängig machen.
  for (const id of flippedSuperUserIds) {
    try { await db.update(users).set({ isSuperAdmin: true }).where(eq(users.id, id)); } catch {}
  }
  for (const id of flippedAdminUserIds) {
    try { await db.update(users).set({ isAdmin: true }).where(eq(users.id, id)); } catch {}
  }
  for (const id of createdUserIds) {
    try { await db.delete(users).where(eq(users.id, id)); } catch {}
  }
  for (const id of createdCustomerIds) {
    try { await db.delete(customers).where(eq(customers.id, id)); } catch {}
  }
});

function expectedFor(ids: number[]): ReadonlyArray<ExpectedRecord> {
  return [
    { id: ids[0], customerId, year: 2099, month: 1 },
    { id: ids[1], customerId, year: 2099, month: 2 },
  ];
}

describe("Task #578 — restore-storno-deleted-service-records Sicherheits-Tests", () => {
  it("Happy Path: passende Tupel werden reaktiviert + Audit-Eintrag geschrieben", async () => {
    const result = await restoreServiceRecordsByTuples({
      expectedRecords: expectedFor(recordIds),
      incidentWindow: { start: WINDOW_START, end: WINDOW_END },
    });

    expect(result.skipReason).toBeNull();
    expect(new Set(result.restoredIds)).toEqual(new Set(recordIds));

    const snap = await snapshotState(recordIds);
    expect(snap.auditCount).toBe(2);
    for (const row of snap.data as Array<{ deletedAtIsNull: boolean }>) {
      expect(row.deletedAtIsNull).toBe(true);
    }
  });

  it("One-Shot-Guard: zweiter Lauf ist No-Op (keine zusätzlichen Audit-Einträge)", async () => {
    await assertSecondRunIsNoOp({
      label: "restore-storno",
      run: () => restoreServiceRecordsByTuples({
        expectedRecords: expectedFor(recordIds),
        incidentWindow: { start: WINDOW_START, end: WINDOW_END },
      }),
      snapshot: () => snapshotState(recordIds),
    });
  });

  it("Tuple-Mismatch (falsche customerId): Migration ist No-Op", async () => {
    await assertNoOpForMismatch({
      label: "restore-storno (tuple)",
      mutate: async () => {/* nichts zu mutieren, Mismatch kommt aus expectedRecords */},
      restore: async () => {/* nichts zurückzusetzen */},
      run: () => restoreServiceRecordsByTuples({
        // customerId verbogen: zeigt auf einen anderen, real existierenden Kunden
        expectedRecords: [
          { id: recordIds[0], customerId: otherCustomerId, year: 2099, month: 1 },
          { id: recordIds[1], customerId: otherCustomerId, year: 2099, month: 2 },
        ],
        incidentWindow: { start: WINDOW_START, end: WINDOW_END },
      }),
      snapshot: () => snapshotState(recordIds),
    });

    const result = await restoreServiceRecordsByTuples({
      expectedRecords: [
        { id: recordIds[0], customerId: otherCustomerId, year: 2099, month: 1 },
      ],
      incidentWindow: { start: WINDOW_START, end: WINDOW_END },
    });
    expect(result.restoredIds).toEqual([]);
    expect(result.skipReason).toBe("no_candidates");
  });

  it("Fenster-Mismatch (deletedAt außerhalb des Incident-Fensters): No-Op", async () => {
    await assertNoOpForMismatch({
      label: "restore-storno (window)",
      mutate: async () => {
        // Records auf einen Zeitpunkt AUSSERHALB des konfigurierten Fensters setzen.
        for (const id of recordIds) {
          await db.update(monthlyServiceRecords)
            .set({ deletedAt: OUTSIDE_WINDOW })
            .where(eq(monthlyServiceRecords.id, id));
        }
      },
      restore: async () => {
        for (const id of recordIds) {
          await resetRecordToSoftDeleted(id, INSIDE_WINDOW);
        }
      },
      run: () => restoreServiceRecordsByTuples({
        expectedRecords: expectedFor(recordIds),
        incidentWindow: { start: WINDOW_START, end: WINDOW_END },
      }),
      snapshot: () => snapshotState(recordIds),
    });
  });

  it("Year/Month-Mismatch: No-Op (zweiter Anker im Tupel-Vergleich)", async () => {
    const result = await restoreServiceRecordsByTuples({
      expectedRecords: [
        { id: recordIds[0], customerId, year: 2099, month: 12 }, // falscher Monat
        { id: recordIds[1], customerId, year: 2098, month: 2 },  // falsches Jahr
      ],
      incidentWindow: { start: WINDOW_START, end: WINDOW_END },
    });
    expect(result.restoredIds).toEqual([]);

    const snap = await snapshotState(recordIds);
    expect(snap.auditCount).toBe(0);
    for (const row of snap.data as Array<{ deletedAtIsNull: boolean }>) {
      expect(row.deletedAtIsNull).toBe(false);
    }
  });

  it("Fehlender Audit-Akteur: Migration wird komplett übersprungen", async () => {
    // Wir entziehen *temporär* allen Usern Super-/Admin-Rechte. Das ist
    // destruktiv genug, um vorsichtig vorzugehen: vor dem Run merken,
    // nach dem Run wiederherstellen. Snapshot-Vergleich macht sicher, dass
    // weder Daten noch Audit-Log angetastet werden.
    await assertSkipsWithoutAuditActor({
      label: "restore-storno",
      removeActors: async () => {
        const flippedSupers = await db.update(users)
          .set({ isSuperAdmin: false })
          .where(eq(users.isSuperAdmin, true))
          .returning({ id: users.id });
        for (const { id } of flippedSupers) flippedSuperUserIds.push(id);

        const flippedAdmins = await db.update(users)
          .set({ isAdmin: false })
          .where(eq(users.isAdmin, true))
          .returning({ id: users.id });
        for (const { id } of flippedAdmins) flippedAdminUserIds.push(id);

        // Sanity: nach dem Flip darf kein Akteur mehr existieren.
        const remaining = await db.execute(sql`
          SELECT COUNT(*)::int AS n FROM users
          WHERE is_super_admin = true OR is_admin = true
        `);
        expect((remaining.rows[0] as { n: number }).n).toBe(0);
      },
      restoreActors: async () => {
        while (flippedSuperUserIds.length > 0) {
          const id = flippedSuperUserIds.pop()!;
          await db.update(users).set({ isSuperAdmin: true }).where(eq(users.id, id));
        }
        while (flippedAdminUserIds.length > 0) {
          const id = flippedAdminUserIds.pop()!;
          await db.update(users).set({ isAdmin: true }).where(eq(users.id, id));
        }
      },
      run: () => restoreServiceRecordsByTuples({
        expectedRecords: expectedFor(recordIds),
        incidentWindow: { start: WINDOW_START, end: WINDOW_END },
      }),
      snapshot: () => snapshotState(recordIds),
    });
  });
});
