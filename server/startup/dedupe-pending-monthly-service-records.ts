import { db, type DbOrTx } from "../lib/db";
import { monthlyServiceRecords, serviceRecordAppointments, users, auditLog } from "@shared/schema";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { log } from "../lib/log";

/**
 * Task #1534 — Einmaliger Prod-Cleanup: bestehende Doppel-Monats-Leistungs-
 * nachweise konsolidieren, BEVOR der partielle Unique-Index aus Task #1528
 * (`monthly_service_records_pending_unique_idx`) greifen kann.
 *
 * Hintergrund: Vor Task #1526/#1528 konnten zwei gleichzeitige Create-Requests
 * (Doppel-Klick / zwei Tabs) je einen offenen (pending) Monats-LN für denselben
 * Kunden+Mitarbeiter+Monat anlegen. Der Unique-Index aus #1528 schließt das
 * künftig aus — PostgreSQL verweigert die Index-Erstellung aber, solange noch
 * Duplikate existieren. Die Index-Migration schluckt diesen Fehler und bootet
 * weiter; ohne diesen Cleanup würde der Schutz in Prod also still NIE aktiv.
 *
 * Vorgehen pro Duplikat-Gruppe (customer_id, employee_id, year, month):
 *   1. Überlebender = LN mit der KLEINSTEN id. Das deckt sich exakt mit
 *      `getPendingMonthlyServiceRecord` (`ORDER BY id LIMIT 1`), d.h. der Merge-
 *      Pfad würde künftig genau diesen LN finden.
 *   2. Termin-Verknüpfungen (`service_record_appointments`) der redundanten LNs
 *      werden auf den Überlebenden umgehängt (Duplikate verworfen) — KEIN Termin
 *      geht verloren, alle landen im einen überlebenden LN.
 *   3. Die redundanten LNs werden SOFT-gelöscht (`deleted_at = NOW()`), GoBD-
 *      konform (kein Hard-Delete, append-only Audit). Es werden ausschließlich
 *      OFFENE (pending), nicht versiegelte (NICHT employee_signed/completed) und
 *      nicht bereits gelöschte LNs angefasst.
 *   4. Jede Soft-Löschung schreibt einen Audit-Eintrag
 *      (`monthly_service_record_deduplicated`).
 *
 * GoBD/Sicherheit:
 *   - `monthly_service_records` und `service_record_appointments` sind NICHT
 *     trigger-immutable ⇒ kein GoBD-Bypass nötig (Runner: `gobdBypass: false`).
 *   - Ohne Audit-Akteur (kein Super-/Admin in der DB) wird NICHT mutiert.
 *   - Idempotent: ein erneuter Lauf findet keine Duplikat-Gruppen mehr → No-Op.
 *     Zusätzlich gegated über den Migrations-Ledger (exactly-once) durch den
 *     `runGuardedBudgetMigration`-Wrapper (siehe `data-migration-runner.ts`).
 *
 * Läuft (über die pre-budget-Registry) VOR `ensureMonthlyServiceRecordPendingUnique`
 * in `server/index.ts`, damit der Index-Build danach erfolgreich ist.
 */

export interface DedupePendingMonthlyResult {
  groupsProcessed: number;
  recordsSoftDeleted: number;
  appointmentsMoved: number;
  softDeletedIds: number[];
  skipReason: "no_duplicates" | "no_audit_actor" | null;
}

interface DuplicateGroup {
  customerId: number;
  employeeId: number;
  year: number;
  month: number;
  ids: number[];
}

async function findDuplicateGroups(exec: DbOrTx): Promise<DuplicateGroup[]> {
  const rows = await exec
    .select({
      customerId: monthlyServiceRecords.customerId,
      employeeId: monthlyServiceRecords.employeeId,
      year: monthlyServiceRecords.year,
      month: monthlyServiceRecords.month,
      ids: sql<number[]>`array_agg(${monthlyServiceRecords.id} ORDER BY ${monthlyServiceRecords.id})`,
    })
    .from(monthlyServiceRecords)
    .where(
      and(
        eq(monthlyServiceRecords.recordType, "monthly"),
        eq(monthlyServiceRecords.status, "pending"),
        isNull(monthlyServiceRecords.deletedAt),
      ),
    )
    .groupBy(
      monthlyServiceRecords.customerId,
      monthlyServiceRecords.employeeId,
      monthlyServiceRecords.year,
      monthlyServiceRecords.month,
    )
    .having(sql`count(*) > 1`);

  return rows.map((r) => ({
    customerId: r.customerId,
    employeeId: r.employeeId,
    year: r.year,
    month: r.month,
    ids: (r.ids ?? []).map((id) => Number(id)),
  }));
}

async function resolveAuditActorId(exec: DbOrTx): Promise<number | null> {
  const [superActor] = await exec
    .select({ id: users.id })
    .from(users)
    .where(eq(users.isSuperAdmin, true))
    .orderBy(asc(users.id))
    .limit(1);
  if (superActor?.id != null) return superActor.id;
  const [adminActor] = await exec
    .select({ id: users.id })
    .from(users)
    .where(eq(users.isAdmin, true))
    .orderBy(asc(users.id))
    .limit(1);
  return adminActor?.id ?? null;
}

async function getLinkedAppointmentIds(exec: DbOrTx, serviceRecordId: number): Promise<number[]> {
  const rows = await exec
    .select({ appointmentId: serviceRecordAppointments.appointmentId })
    .from(serviceRecordAppointments)
    .where(eq(serviceRecordAppointments.serviceRecordId, serviceRecordId));
  return rows.map((r) => r.appointmentId);
}

/**
 * Testbare Kern-Implementierung. Läuft in der vom Runner gehaltenen Transaktion
 * (`exec`), sodass Umhängen + Soft-Delete + Audit + Ledger-Eintrag atomar sind.
 */
export async function dedupePendingMonthlyServiceRecords(
  exec: DbOrTx = db,
): Promise<DedupePendingMonthlyResult> {
  const groups = await findDuplicateGroups(exec);
  if (groups.length === 0) {
    return {
      groupsProcessed: 0,
      recordsSoftDeleted: 0,
      appointmentsMoved: 0,
      softDeletedIds: [],
      skipReason: "no_duplicates",
    };
  }

  const actorId = await resolveAuditActorId(exec);
  if (actorId == null) {
    log(
      "[dedupe-pending-monthly-service-records] Kein Super-/Admin-Akteur für Audit-Log gefunden — Migration übersprungen (keine Mutation ohne Audit).",
      "startup",
    );
    return {
      groupsProcessed: 0,
      recordsSoftDeleted: 0,
      appointmentsMoved: 0,
      softDeletedIds: [],
      skipReason: "no_audit_actor",
    };
  }

  let recordsSoftDeleted = 0;
  let appointmentsMoved = 0;
  const softDeletedIds: number[] = [];

  for (const group of groups) {
    const [survivorId, ...redundantIds] = group.ids;
    if (survivorId == null || redundantIds.length === 0) continue;

    const survivorApptIds = new Set(await getLinkedAppointmentIds(exec, survivorId));

    for (const redundantId of redundantIds) {
      const redundantApptIds = await getLinkedAppointmentIds(exec, redundantId);
      const toMove = redundantApptIds.filter((id) => !survivorApptIds.has(id));
      const toDrop = redundantApptIds.filter((id) => survivorApptIds.has(id));

      // Nicht-doppelte Termin-Links auf den Überlebenden umhängen.
      if (toMove.length > 0) {
        await exec
          .update(serviceRecordAppointments)
          .set({ serviceRecordId: survivorId })
          .where(
            and(
              eq(serviceRecordAppointments.serviceRecordId, redundantId),
              inArray(serviceRecordAppointments.appointmentId, toMove),
            ),
          );
        for (const id of toMove) survivorApptIds.add(id);
        appointmentsMoved += toMove.length;
      }

      // Doppelte Link-Zeilen (Termin schon beim Überlebenden) verwerfen, damit
      // keine Reste auf den soft-gelöschten LN zeigen.
      if (toDrop.length > 0) {
        await exec
          .delete(serviceRecordAppointments)
          .where(
            and(
              eq(serviceRecordAppointments.serviceRecordId, redundantId),
              inArray(serviceRecordAppointments.appointmentId, toDrop),
            ),
          );
      }

      // Redundanten LN soft-löschen — nur wenn weiterhin offen & nicht gelöscht
      // (Schutz gegen eine nebenläufige Versiegelung).
      const deleted = await exec
        .update(monthlyServiceRecords)
        .set({ deletedAt: sql`NOW()`, updatedAt: sql`NOW()` })
        .where(
          and(
            eq(monthlyServiceRecords.id, redundantId),
            eq(monthlyServiceRecords.status, "pending"),
            isNull(monthlyServiceRecords.deletedAt),
          ),
        )
        .returning({ id: monthlyServiceRecords.id });

      if (deleted.length === 0) continue;

      recordsSoftDeleted += 1;
      softDeletedIds.push(redundantId);

      await exec.insert(auditLog).values({
        userId: actorId,
        action: "monthly_service_record_deduplicated",
        entityType: "service_record",
        entityId: redundantId,
        metadata: {
          survivingRecordId: survivorId,
          customerId: group.customerId,
          employeeId: group.employeeId,
          year: group.year,
          month: group.month,
          movedAppointmentIds: toMove,
          droppedDuplicateLinkAppointmentIds: toDrop,
          reason:
            "Task #1534 — Doppelter offener Monats-Leistungsnachweis konsolidiert (Termine in den überlebenden LN gemergt, redundanter LN soft-gelöscht), damit der partielle Unique-Index aus Task #1528 erstellt werden kann.",
          migration: "dedupe-pending-monthly-service-records",
        },
      });

      log(
        `[dedupe-pending-monthly-service-records] LN #${redundantId} (Kunde ${group.customerId}, MA ${group.employeeId}, ${group.year}-${String(group.month).padStart(2, "0")}) soft-gelöscht; ${toMove.length} Termin(e) → LN #${survivorId} gemergt.`,
        "startup",
      );
    }
  }

  return {
    groupsProcessed: groups.length,
    recordsSoftDeleted,
    appointmentsMoved,
    softDeletedIds,
    skipReason: null,
  };
}
