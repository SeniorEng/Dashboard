import { eq, and, like, isNull, asc } from "drizzle-orm";
import type { Tx } from "../lib/db";
import { appointments, users } from "@shared/schema";
import { findDriftRows } from "../scripts/audit-appointment-budget-drift";
import { rebookAppointmentConsumption } from "../storage/budget/km-rebook";
import { REBOOK_TRIGGERS } from "@shared/domain/budget-rebook-triggers";
import { auditService } from "../services/audit";
import { log } from "../lib/log";
import type { BudgetMigrationSummary } from "./budget-migration-runner";

/**
 * Task #643 — Einmaliger Backfill für Bestandsdrift aus Import-Updates.
 *
 * Hintergrund: Bevor `executeImport` den Update-Pfad an
 * `rebookAppointmentConsumption` gekoppelt hat (Task #643), schrieb ein
 * Import-Update zwar die neuen km/Notiz in den Termin, ließ aber die
 * zugehörige `budget_transactions`-Consumption auf den ALTEN Werten stehen
 * (Drift Frau Schröder, Termine 12.01./21.01.2026). Diese Migration räumt
 * den Bestand idempotent ab.
 *
 * Selektion: Termine mit `notes` beginnend mit "Import-Update aus Altdaten"
 * (die Markierung, die der Update-Pfad setzt). Pro betroffenem Termin wird
 * geprüft, ob ein Drift (km / Minuten / Datum) gegenüber den gebuchten
 * Consumption-Txs vorliegt — dieselbe Logik wie `findDriftRows`.
 *
 * Vorgehen pro Drift-Termin (atomar pro Termin via Savepoint):
 *   1. `rebookAppointmentConsumption` ausführen (Storno der alten Txs +
 *      Neu-Buchung mit den AKTUELLEN Termin-Werten).
 *   2. Audit-Eintrag `appointment_km_rebooked` mit Trigger `appointment_import:backfill`
 *      schreiben (Audit-Insert läuft mit `exec=savepoint`, damit ein
 *      gescheiterter Audit-Schreib den Rebook desselben Termins zurückrollt).
 *
 * Task #896 — Auf das Budget-Migrations-Framework migriert: läuft jetzt als
 * (tx) => BudgetMigrationSummary innerhalb EINER guarded Transaktion mit
 * Conservation-Pre-/Post-Check. Per-Termin-Fehler werden über einen Savepoint
 * isoliert (gescheiterter Termin wird übersprungen, ohne die übrigen
 * abzuwürgen). Idempotenz unverändert: `findDriftRows` liefert nach
 * erfolgreichem Rebook keinen Drift mehr — ein zweiter Lauf ist No-Op.
 */
export async function backfillImportUpdateBudgetDrift(tx: Tx): Promise<BudgetMigrationSummary> {
  const rows = await tx
    .select({ id: appointments.id })
    .from(appointments)
    .where(and(
      isNull(appointments.deletedAt),
      like(appointments.notes, "Import-Update aus Altdaten%"),
    ));
  const importUpdateAppointmentIds = rows.map(r => r.id);

  if (importUpdateAppointmentIds.length === 0) {
    return { changed: 0, note: "keine Import-Update-Termine" };
  }

  const driftRows = await findDriftRows({ appointmentIds: importUpdateAppointmentIds });
  if (driftRows.length === 0) {
    return { changed: 0, note: "kein Drift" };
  }

  // Mandatory Audit: ohne Akteur keine Mutation. Wir wählen den ältesten
  // Superadmin (Fallback: ältesten Admin) als Audit-Akteur — dasselbe
  // Muster wie `restore-storno-deleted-service-records`.
  const [superActor] = await tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.isSuperAdmin, true))
    .orderBy(asc(users.id))
    .limit(1);
  let actorId: number | null = superActor?.id ?? null;
  if (actorId == null) {
    const [adminActor] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.isAdmin, true))
      .orderBy(asc(users.id))
      .limit(1);
    actorId = adminActor?.id ?? null;
  }
  if (actorId == null) {
    log(
      `Import-Update-Drift-Backfill übersprungen: kein Super-/Admin-Akteur für Audit-Log gefunden ` +
        `(${driftRows.length} Drift-Termin(e) bleiben offen — Korrektur per ` +
        `tsx server/scripts/audit-appointment-budget-drift.ts --apply).`,
      "startup",
    );
    return { changed: 0, note: "kein Audit-Akteur" };
  }
  const auditActorId = actorId;

  log(
    `Import-Update-Drift-Backfill: ${driftRows.length} Termin(e) werden reconciliert (Trigger: appointment_import:backfill).`,
    "startup",
  );

  let rebooked = 0;
  let noop = 0;
  let errored = 0;

  for (const drift of driftRows) {
    try {
      const result = await tx.transaction(async (sp) => {
        const r = await rebookAppointmentConsumption(
          { appointmentId: drift.appointmentId },
          sp,
        );

        if (r.rebooked) {
          await auditService.log(
            auditActorId,
            "appointment_km_rebooked",
            "appointment",
            drift.appointmentId,
            {
              customerId: drift.customerId,
              trigger: REBOOK_TRIGGERS.import.backfill,
              previousTransactionDate: r.previousTransactionDate,
              transactionDate: r.transactionDate,
              previousTravelKm: r.previousTravelKm,
              newTravelKm: drift.apptTravelKm,
              previousCustomerKm: r.previousCustomerKm,
              newCustomerKm: drift.apptCustomerKm,
              previousHauswirtschaftMinutes: r.previousHauswirtschaftMinutes,
              previousAlltagsbegleitungMinutes: r.previousAlltagsbegleitungMinutes,
              hauswirtschaftMinutes: r.hauswirtschaftMinutes,
              alltagsbegleitungMinutes: r.alltagsbegleitungMinutes,
              reversedTransactionIds: r.reversedTransactionIds,
            },
            undefined,
            sp,
          );
        }

        return r;
      });

      if (!result.rebooked) {
        noop++;
        continue;
      }
      rebooked++;
    } catch (err) {
      errored++;
      log(
        `Import-Update-Drift-Backfill appt#${drift.appointmentId} fehlgeschlagen: ${(err as Error).message}`,
        "startup",
      );
    }
  }

  log(
    `Import-Update-Drift-Backfill abgeschlossen: rebooked=${rebooked}, noop=${noop}, errored=${errored}.`,
    "startup",
  );

  return {
    changed: rebooked,
    note: `rebooked=${rebooked}, noop=${noop}, errored=${errored}`,
  };
}
