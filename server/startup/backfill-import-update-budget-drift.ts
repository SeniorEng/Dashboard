import { eq, and, like, isNull, asc } from "drizzle-orm";
import { db } from "../lib/db";
import { appointments, users } from "@shared/schema";
import { findDriftRows } from "../scripts/audit-appointment-budget-drift";
import { rebookAppointmentConsumption } from "../storage/budget/km-rebook";
import { REBOOK_TRIGGERS } from "@shared/domain/budget-rebook-triggers";
import { auditService } from "../services/audit";
import { log } from "../lib/log";

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
 * Vorgehen pro Drift-Termin:
 *   1. `rebookAppointmentConsumption` ausführen (Storno der alten Txs +
 *      Neu-Buchung mit den AKTUELLEN Termin-Werten).
 *   2. Audit-Eintrag `appointment_km_rebooked` mit Trigger `appointment_import:backfill`
 *      schreiben.
 *
 * Idempotenz: Eigene Marker-Tabelle wäre Overkill — `findDriftRows`
 * liefert nach erfolgreichem Rebook keinen Drift mehr; ein zweiter
 * Migrationslauf ist deshalb von Natur aus No-Op. Verbleibende
 * Bestands-Termine (z.B. weil zwischenzeitlich erneut editiert) werden
 * dann beim nächsten Lauf erfasst.
 */
export async function backfillImportUpdateBudgetDrift(): Promise<void> {
  let importUpdateAppointmentIds: number[];
  try {
    const rows = await db
      .select({ id: appointments.id })
      .from(appointments)
      .where(and(
        isNull(appointments.deletedAt),
        like(appointments.notes, "Import-Update aus Altdaten%"),
      ));
    importUpdateAppointmentIds = rows.map(r => r.id);
  } catch (err) {
    log(
      `Import-Update-Drift-Backfill übersprungen (DB nicht bereit): ${(err as Error).message}`,
      "startup",
    );
    return;
  }

  if (importUpdateAppointmentIds.length === 0) return;

  const driftRows = await findDriftRows({ appointmentIds: importUpdateAppointmentIds });
  if (driftRows.length === 0) return;

  // Mandatory Audit: ohne Akteur keine Mutation. Wir wählen den ältesten
  // Superadmin (Fallback: ältesten Admin) als Audit-Akteur — dasselbe
  // Muster wie `restore-storno-deleted-service-records`.
  const [superActor] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.isSuperAdmin, true))
    .orderBy(asc(users.id))
    .limit(1);
  let actorId: number | null = superActor?.id ?? null;
  if (actorId == null) {
    const [adminActor] = await db
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
    return;
  }

  log(
    `Import-Update-Drift-Backfill: ${driftRows.length} Termin(e) werden reconciliert (Trigger: appointment_import:backfill).`,
    "startup",
  );

  let rebooked = 0;
  let noop = 0;
  let errored = 0;

  for (const drift of driftRows) {
    try {
      const result = await db.transaction(async (tx) => {
        return rebookAppointmentConsumption(
          { appointmentId: drift.appointmentId },
          tx,
        );
      });

      if (!result.rebooked) {
        noop++;
        continue;
      }

      await auditService.log(
        actorId,
        "appointment_km_rebooked",
        "appointment",
        drift.appointmentId,
        {
          customerId: drift.customerId,
          trigger: REBOOK_TRIGGERS.import.backfill,
          previousTransactionDate: result.previousTransactionDate,
          transactionDate: result.transactionDate,
          previousTravelKm: result.previousTravelKm,
          newTravelKm: drift.apptTravelKm,
          previousCustomerKm: result.previousCustomerKm,
          newCustomerKm: drift.apptCustomerKm,
          previousHauswirtschaftMinutes: result.previousHauswirtschaftMinutes,
          previousAlltagsbegleitungMinutes: result.previousAlltagsbegleitungMinutes,
          hauswirtschaftMinutes: result.hauswirtschaftMinutes,
          alltagsbegleitungMinutes: result.alltagsbegleitungMinutes,
          reversedTransactionIds: result.reversedTransactionIds,
        },
      );
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
}
