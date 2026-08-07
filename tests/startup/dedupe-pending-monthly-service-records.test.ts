/**
 * Task #1534 — Tests für die einmalige Konsolidierungs-Migration
 * `dedupe-pending-monthly-service-records`.
 *
 * Geprüft:
 *   1. Happy Path: zwei offene Monats-LNs (gleicher Kunde+MA+Monat) → der LN mit
 *      der kleinsten id überlebt, der andere wird soft-gelöscht, dessen Termine
 *      werden in den Überlebenden gemergt, ein Audit-Eintrag entsteht.
 *   2. Idempotenz: zweiter Lauf ist No-Op (keine weitere Soft-Löschung/Audit).
 *   3. Doppelter Termin-Link: ist ein Termin bereits beim Überlebenden, wird die
 *      redundante Link-Zeile verworfen (kein Unique-Verstoß, kein Verlust).
 *   4. Versiegelter LN (z.B. `employee_signed`) wird nie angefasst — auch
 *      nicht als Dritter derselben Kunde/MA/Monat-Gruppe.
 *   5. Fehlender Audit-Akteur: keine Mutation.
 *
 * (Der frühere Punkt „partieller Unique-Index aus #1528 lässt sich anlegen" ist
 * mit #1542 entfallen — der Index existiert nicht mehr, siehe `beforeAll`.)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../server/lib/db";
import {
  customers,
  users,
  appointments,
  monthlyServiceRecords,
  serviceRecordAppointments,
  auditLog,
} from "@shared/schema";
import { dedupePendingMonthlyServiceRecords } from "../../server/startup/dedupe-pending-monthly-service-records";
import { uniqueId } from "../test-utils";

const TAG = `t1534-${uniqueId()}`;
const YEAR = 2099;
const MONTH = 7;

let customerId: number;
let employeeId: number;
const createdUserIds: number[] = [];
const createdCustomerIds: number[] = [];
let recordIds: number[] = [];
let apptIds: number[] = [];
const flippedSuperUserIds: number[] = [];
const flippedAdminUserIds: number[] = [];

async function insertCustomer(): Promise<number> {
  const [row] = await db.insert(customers).values({
    name: `T1534-${TAG}`,
    address: "Dedup-Teststraße 1, 10115 Berlin",
    vorname: "T1534",
    nachname: TAG,
    billingType: "selbstzahler",
  } as any).returning({ id: customers.id });
  createdCustomerIds.push(row.id);
  return row.id;
}

async function insertEmployee(): Promise<number> {
  const [row] = await db.insert(users).values({
    email: `t1534-${TAG}@example.invalid`,
    passwordHash: "x".repeat(20),
    displayName: `T1534 Employee ${TAG}`,
  } as any).returning({ id: users.id });
  createdUserIds.push(row.id);
  return row.id;
}

async function insertAppointment(): Promise<number> {
  const [row] = await db.insert(appointments).values({
    customerId,
    appointmentType: "kundentermin",
    date: `${YEAR}-${String(MONTH).padStart(2, "0")}-10`,
    scheduledStart: "09:00",
    durationPromised: 60,
    status: "completed",
  } as any).returning({ id: appointments.id });
  apptIds.push(row.id);
  return row.id;
}

async function insertPendingRecord(): Promise<number> {
  return insertRecordWithStatus("pending");
}

/** Wie `insertPendingRecord`, aber mit frei wählbarem Status — für den
 *  versiegelten Fall, den die Migration ausdrücklich NICHT anfassen darf. */
async function insertRecordWithStatus(status: string): Promise<number> {
  const [row] = await db.insert(monthlyServiceRecords).values({
    customerId,
    employeeId,
    year: YEAR,
    month: MONTH,
    recordType: "monthly",
    status,
  } as any).returning({ id: monthlyServiceRecords.id });
  recordIds.push(row.id);
  return row.id;
}

async function linkAppointment(serviceRecordId: number, appointmentId: number): Promise<void> {
  await db.insert(serviceRecordAppointments)
    .values({ serviceRecordId, appointmentId })
    .onConflictDoNothing();
}

async function recordState(id: number): Promise<{ deletedAtIsNull: boolean } | null> {
  const [row] = await db
    .select({ deletedAtIsNull: sql<boolean>`${monthlyServiceRecords.deletedAt} IS NULL` })
    .from(monthlyServiceRecords)
    .where(eq(monthlyServiceRecords.id, id));
  return row ?? null;
}

async function linkedApptIds(serviceRecordId: number): Promise<number[]> {
  const rows = await db
    .select({ appointmentId: serviceRecordAppointments.appointmentId })
    .from(serviceRecordAppointments)
    .where(eq(serviceRecordAppointments.serviceRecordId, serviceRecordId))
    .orderBy(serviceRecordAppointments.appointmentId);
  return rows.map((r) => r.appointmentId);
}

/**
 * Der Sweep läuft TABELLENWEIT — er filtert nur auf `recordType`/`status`/
 * `deletedAt`, nicht auf Kunde, Monat oder Test-Tag. Seine Zähler im Ergebnis
 * (`recordsSoftDeleted`, `appointmentsMoved`) sind deshalb global.
 *
 * Lokal fällt das nicht auf: der Orchestrator gibt jedem Worker eine eigene
 * Wegwerf-DB, in der nur diese Datei schreibt. Der CI-`tests`-Job fährt dagegen
 * ALLE Dateien nacheinander gegen EINE geteilte DB — dort räumt der Sweep auch
 * Duplikate weg, die andere Dateien hinterlassen haben, und die zählen mit.
 * Kontrolliert nachgestellt: ein einziges fremdes Duplikat-Paar macht aus
 * `expect(recordsSoftDeleted).toBe(1)` ein `expected 2 to be 1` — genau der
 * CI-Fehlschlag. Dass nur der Happy Path fiel, passt dazu: er läuft zuerst und
 * räumt die Tabelle leer, die späteren Fälle finden sie schon sauber vor.
 *
 * Die Zähler werden deshalb auf die Zeilen DIESER Datei eingeschränkt. Die
 * Aussage bleibt dieselbe — welche unserer Zeilen der Sweep angefasst hat —,
 * nur die stille Voraussetzung „die Tabelle enthält sonst nichts" fällt weg.
 */
function oursSoftDeleted(result: { softDeletedIds: number[] }): number[] {
  return result.softDeletedIds.filter((id) => recordIds.includes(id));
}

async function auditCountFor(ids: number[]): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await db
    .select({ entityId: auditLog.entityId })
    .from(auditLog)
    .where(and(
      eq(auditLog.action, "monthly_service_record_deduplicated"),
      eq(auditLog.entityType, "service_record"),
      inArray(auditLog.entityId, ids),
    ));
  return rows.length;
}

beforeAll(async () => {
  // Task #1542 — Der partielle Unique-Index aus #1528 wurde entfernt (On-Demand-
  // Sammel-LN erlaubt mehrere offene monthly-Bündel pro Monat). Die Konsolidie-
  // rungs-Migration bleibt als historischer, ledger-gegateter One-Shot bestehen;
  // ihre Logik (Merge doppelter offener LNs) wird hier weiterhin abgesichert.
  await db.execute(sql`DROP INDEX IF EXISTS monthly_service_records_pending_unique_idx`);
  customerId = await insertCustomer();
  employeeId = await insertEmployee();
});

afterEach(async () => {
  if (recordIds.length > 0) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL app.allow_audit_log_mutation = 'on'`);
      await tx.delete(auditLog).where(and(
        eq(auditLog.action, "monthly_service_record_deduplicated"),
        eq(auditLog.entityType, "service_record"),
        inArray(auditLog.entityId, recordIds),
      ));
    });
    await db.delete(serviceRecordAppointments)
      .where(inArray(serviceRecordAppointments.serviceRecordId, recordIds));
    await db.delete(monthlyServiceRecords).where(inArray(monthlyServiceRecords.id, recordIds));
    recordIds = [];
  }
  if (apptIds.length > 0) {
    await db.delete(appointments).where(inArray(appointments.id, apptIds));
    apptIds = [];
  }
});

afterAll(async () => {
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

describe("Task #1534 — dedupe-pending-monthly-service-records", () => {
  it("Happy Path: ältester LN überlebt, jüngerer soft-gelöscht, Termine gemergt, Audit geschrieben", async () => {
    const survivor = await insertPendingRecord();
    const redundant = await insertPendingRecord();
    expect(survivor).toBeLessThan(redundant);
    const apptA = await insertAppointment();
    const apptB = await insertAppointment();
    await linkAppointment(survivor, apptA);
    await linkAppointment(redundant, apptB);

    const result = await dedupePendingMonthlyServiceRecords();

    expect(result.skipReason).toBeNull();
    // Ersetzt `recordsSoftDeleted === 1` + `softDeletedIds === [redundant]`:
    // beides in einer gescopeten Aussage, ohne den globalen Zähler.
    expect(oursSoftDeleted(result)).toEqual([redundant]);
    // Die Zähler selbst bleiben als UNTERGRENZE geprüft. Ohne das wäre kein
    // positiver Assert auf sie übrig, und ein Mutant, der sie auf 0 festnagelt
    // (oder gar nicht erst hochzählt), käme durch alle vier Fälle. `>=` statt
    // `===`, weil Fremd-Duplikate der geteilten CI-DB nur addieren können.
    expect(result.recordsSoftDeleted).toBeGreaterThanOrEqual(1);
    expect(result.appointmentsMoved).toBeGreaterThanOrEqual(1);
    // Die exakte Wirkung auf UNSERE Daten steht unten: `linkedApptIds` prüft
    // die Link-Mengen beider Sätze, nicht nur deren Anzahl — ein Fremd-Termin
    // im Überlebenden macht die Zeile rot, ein Zähler täte das nicht.

    expect((await recordState(survivor))?.deletedAtIsNull).toBe(true);
    expect((await recordState(redundant))?.deletedAtIsNull).toBe(false);
    expect(await linkedApptIds(survivor)).toEqual([apptA, apptB].sort((a, b) => a - b));
    expect(await linkedApptIds(redundant)).toEqual([]);
    expect(await auditCountFor([redundant])).toBe(1);
  });

  it("Idempotenz: zweiter Lauf ist No-Op", async () => {
    const survivor = await insertPendingRecord();
    const redundant = await insertPendingRecord();
    const apptA = await insertAppointment();
    await linkAppointment(redundant, apptA);

    const first = await dedupePendingMonthlyServiceRecords();
    expect(oursSoftDeleted(first)).toEqual([redundant]);

    const second = await dedupePendingMonthlyServiceRecords();
    // Die eigentliche Idempotenz-Aussage, gescoped: der zweite Lauf rührt
    // KEINE unserer Zeilen mehr an.
    expect(oursSoftDeleted(second)).toEqual([]);
    // `skipReason`/`recordsSoftDeleted` bleiben bewusst global: sie prüfen, dass
    // der Sweep das Nichts-zu-tun auch ERKENNT (Pfad `no_duplicates`), und das
    // ist eine Aussage über die ganze Tabelle. Sie hält, weil CI das
    // `integration`-Projekt mit einem Worker sequenziell fährt und der erste
    // Sweep auch Fremd-Duplikate abräumt. Bekäme CI je Datei-Parallelität gegen
    // eine geteilte DB, kippt genau diese Zeile zuerst — dann hier scopen.
    expect(second.skipReason).toBe("no_duplicates");
    expect(second.recordsSoftDeleted).toBe(0);
    expect(await auditCountFor([survivor, redundant])).toBe(1);
  });

  it("Doppelter Termin-Link beim Überlebenden wird verworfen (kein Unique-Verstoß)", async () => {
    const survivor = await insertPendingRecord();
    const redundant = await insertPendingRecord();
    const shared = await insertAppointment();
    await linkAppointment(survivor, shared);
    await linkAppointment(redundant, shared);

    const result = await dedupePendingMonthlyServiceRecords();
    expect(oursSoftDeleted(result)).toEqual([redundant]);
    // Statt `appointmentsMoved === 0` (global, zählt Fremd-Verschiebungen mit):
    // die beiden Link-Mengen unten zeigen direkt, dass der doppelte Link
    // verworfen wurde und nichts verlorenging.
    expect(await linkedApptIds(survivor)).toEqual([shared]);
    expect(await linkedApptIds(redundant)).toEqual([]);
  });

  // Die Migration verspricht in ihrem Kopf ausdrücklich, NUR offene, nicht
  // versiegelte LNs anzufassen. Bis hierher prüfte das kein Fall — alle
  // Fixtures waren `pending`, also konnte der Filter `status = 'pending'`
  // ersatzlos wegfallen, ohne dass ein Test rot wurde. Genau dieser Mutant
  // löscht signierte Leistungsnachweise soft: der GoBD-schärfste Fall der Datei.
  it("Versiegelter LN wird nicht angefasst, auch nicht als Dritter derselben Gruppe", async () => {
    const survivor = await insertPendingRecord();
    const redundant = await insertPendingRecord();
    const signed = await insertRecordWithStatus("employee_signed");
    const apptSigned = await insertAppointment();
    await linkAppointment(signed, apptSigned);

    const result = await dedupePendingMonthlyServiceRecords();

    // Der offene Fall wird normal konsolidiert …
    expect(oursSoftDeleted(result)).toEqual([redundant]);
    // … der versiegelte bleibt unberührt: nicht soft-gelöscht, Termin bleibt
    // an ihm hängen, kein Audit-Eintrag gegen ihn.
    expect((await recordState(signed))?.deletedAtIsNull).toBe(true);
    expect(await linkedApptIds(signed)).toEqual([apptSigned]);
    expect(await auditCountFor([signed])).toBe(0);
    // Und er hat dem Überlebenden nichts abgegeben.
    expect(await linkedApptIds(survivor)).toEqual([]);
  });

  it("Fehlender Audit-Akteur: keine Mutation", async () => {
    const survivor = await insertPendingRecord();
    const redundant = await insertPendingRecord();
    const apptA = await insertAppointment();
    await linkAppointment(redundant, apptA);

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

    try {
      const result = await dedupePendingMonthlyServiceRecords();
      expect(result.skipReason).toBe("no_audit_actor");
      expect(result.recordsSoftDeleted).toBe(0);
      expect((await recordState(redundant))?.deletedAtIsNull).toBe(true);
    } finally {
      while (flippedSuperUserIds.length > 0) {
        const id = flippedSuperUserIds.pop()!;
        await db.update(users).set({ isSuperAdmin: true }).where(eq(users.id, id));
      }
      while (flippedAdminUserIds.length > 0) {
        const id = flippedAdminUserIds.pop()!;
        await db.update(users).set({ isAdmin: true }).where(eq(users.id, id));
      }
    }
  });
});
