import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "../lib/db";
import { budgetTransactions, users } from "@shared/schema";
import { auditService } from "../services/audit";
import { log } from "../lib/log";

/**
 * Task #819 — Einmaliger Backfill verwaister Reversal-Buchungen.
 *
 * Hintergrund: Mehrere Rebook-/Reconcile-Pfade (km-rebook, reconcile-trimmed,
 * reconcile-km-drift) haben Storno-Zeilen mit `appointment_id = NULL` eingefügt
 * und die Original-Consumption zusätzlich vom Termin abgekoppelt. Dadurch
 * existieren `budget_transactions`-Reversals ohne Termin-Bezug. Bevor die neue
 * CHECK-Constraint
 *   transaction_type IN (manual_adjustment, expiration, write_off)
 *   OR appointment_id IS NOT NULL
 * angelegt werden kann, MÜSSEN diese Waisen aufgelöst werden — sonst schlägt
 * die Constraint-Erstellung fehl (bzw. wird übersprungen).
 *
 * Auflösungs-Strategie pro verwaister Reversal-Zeile (appointment_id IS NULL,
 * transaction_type = 'reversal'):
 *   1. Über `reversed_transaction_id` → appointment_id der Original-Buchung.
 *   2. Fallback: Notiz "… von Transaktion #N" parsen → appointment_id von #N.
 * Nur wenn eine Original-Buchung mit nicht-leerer appointment_id gefunden wird,
 * wird die Reversal-Zeile aktualisiert. Reversals von manual_adjustment/
 * expiration/write_off (Original hat keine appointment_id) bleiben unangetastet
 * — sie sind durch die Constraint ohnehin erlaubt.
 *
 * GoBD: Es wird ausschließlich die fehlende `appointment_id` nachgetragen
 * (Wiederherstellung des Termin-Bezugs), keine Beträge/Daten verändert. Jede
 * Korrektur wird mit `orphaned_tx_appointment_id_backfilled` auditiert.
 * Vollständig idempotent (nach einem Lauf gibt es keine auflösbaren Waisen
 * mehr). Mit `dryRun = true` (oder Env `BACKFILL_ORPHAN_REVERSAL_DRY_RUN=1`)
 * wird nur geloggt, ohne zu schreiben.
 */
export async function backfillOrphanReversalAppointmentId(
  dryRun = process.env.BACKFILL_ORPHAN_REVERSAL_DRY_RUN === "1",
): Promise<void> {
  const orphans = await db
    .select({
      id: budgetTransactions.id,
      customerId: budgetTransactions.customerId,
      reversedTransactionId: budgetTransactions.reversedTransactionId,
      notes: budgetTransactions.notes,
    })
    .from(budgetTransactions)
    .where(
      and(
        eq(budgetTransactions.transactionType, "reversal"),
        isNull(budgetTransactions.appointmentId),
      ),
    );

  if (orphans.length === 0) return;

  // System-Actor (Super-/Admin) für die Audit-Einträge.
  const [superActor] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.isSuperAdmin, true))
    .orderBy(asc(users.id))
    .limit(1);
  let systemActorId: number | null = superActor?.id ?? null;
  if (systemActorId == null) {
    const [adminActor] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.isAdmin, true))
      .orderBy(asc(users.id))
      .limit(1);
    systemActorId = adminActor?.id ?? null;
  }

  let resolvedCount = 0;
  let unresolvedCount = 0;
  let skippedNoActorCount = 0;

  const resolveAppointmentId = async (
    reversedTransactionId: number | null,
    notes: string | null,
  ): Promise<number | null> => {
    const candidateIds: number[] = [];
    if (reversedTransactionId != null) candidateIds.push(reversedTransactionId);
    // "… von Transaktion #N" aus der Notiz extrahieren (Fallback).
    const match = notes?.match(/von Transaktion #(\d+)/i);
    if (match) {
      const parsed = Number(match[1]);
      if (Number.isInteger(parsed) && !candidateIds.includes(parsed)) {
        candidateIds.push(parsed);
      }
    }
    for (const origId of candidateIds) {
      const [orig] = await db
        .select({ appointmentId: budgetTransactions.appointmentId })
        .from(budgetTransactions)
        .where(eq(budgetTransactions.id, origId))
        .limit(1);
      if (orig?.appointmentId != null) return orig.appointmentId;
    }
    return null;
  };

  for (const orphan of orphans) {
    const appointmentId = await resolveAppointmentId(
      orphan.reversedTransactionId,
      orphan.notes,
    );

    if (appointmentId == null) {
      unresolvedCount++;
      continue;
    }

    if (dryRun) {
      resolvedCount++;
      continue;
    }

    if (systemActorId == null) {
      skippedNoActorCount++;
      continue;
    }

    await db.transaction(async (tx) => {
      await tx
        .update(budgetTransactions)
        .set({ appointmentId })
        .where(
          and(
            eq(budgetTransactions.id, orphan.id),
            isNull(budgetTransactions.appointmentId),
          ),
        );

      await auditService.log(
        systemActorId!,
        "orphaned_tx_appointment_id_backfilled",
        "budget",
        orphan.id,
        {
          task: "#819",
          customerId: orphan.customerId,
          transactionId: orphan.id,
          reversedTransactionId: orphan.reversedTransactionId,
          resolvedAppointmentId: appointmentId,
        },
        undefined,
        tx,
      );
    });
    resolvedCount++;
  }

  const prefix = dryRun ? "[DRY-RUN] " : "";
  log(
    `${prefix}Orphan-Reversal-Backfill (Task #819): ${orphans.length} Waisen geprüft, ` +
      `${resolvedCount} aufgelöst, ${unresolvedCount} nicht auflösbar` +
      (skippedNoActorCount > 0
        ? `, ${skippedNoActorCount} ohne System-Actor übersprungen`
        : ""),
    "startup",
  );
}
