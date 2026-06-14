import { and, asc, eq, sql } from "drizzle-orm";
import type { Tx } from "../lib/db";
import { budgetTransactions, users } from "@shared/schema";
import { findMissingConsumptionAppointments } from "../scripts/backfill-missing-import-consumption";
import { budgetStorage } from "../storage/budget-storage";
import { isMonthClosed } from "../storage/time-tracking/month-closing";
import { REBOOK_TRIGGERS } from "@shared/domain/budget-rebook-triggers";
import { auditService } from "../services/audit";
import { log } from "../lib/log";
import type { BudgetMigrationSummary } from "./budget-migration-runner";

/**
 * Task #1191 — Einmaliger Backfill fehlender Import-Consumption (Bestand).
 *
 * Hintergrund: Der Excel-Import-Update-Pfad koppelte das Budget bisher nur
 * über `rebookAppointmentConsumption` (Storno + Neuanlage). Dieser Rebook ist
 * per Definition ein No-Op, wenn es für den Termin noch GAR KEINE
 * `budget_transactions`-Consumption gibt. Folge: ein `completed`, aus einem
 * Import stammender Termin, der bei einem früheren Lauf nur als Datensatz
 * angelegt (ohne Budget-Buchung) und danach per Update erneut „angefasst"
 * wurde, blieb ohne jede Consumption — das Budget des Kunden zeigt zu viel
 * Restguthaben (z.B. Kunde #88 „Wolf, Jens": ~784 € statt ~1.148 €). Betroffen
 * ist u.a. Import-Batch #4 („Januar 2026.xlsx").
 *
 * Der Code-Fix in `executeImport` schließt die Lücke für KÜNFTIGE Importe.
 * Diese Migration korrigiert den BESTAND: sie findet abgeschlossene, nicht
 * soft-gelöschte IMPORT-Termine (`import_batch_id IS NOT NULL`) ganz OHNE
 * Consumption-Tx und bucht die fehlende Consumption ERSTMALIG über
 * `createConsumptionTransaction` (inkl. §45b-FIFO/Kaskade) — append-only und
 * GoBD-auditiert (`appointment_km_rebooked`, `firstTimeBooking: true`).
 *
 * Abgrenzung zu `backfillImportUpdateBudgetDrift` (Task #643): jene Migration
 * reconciliert Termine, die BEREITS eine (veraltete) Consumption haben
 * (Rebook). Termine ganz OHNE Consumption deckt der Rebook NICHT ab — genau
 * diese Lücke schließt diese Migration. Beide schließen sich gegenseitig aus
 * (Rebook greift nur bei vorhandener Consumption).
 *
 * Scope: bewusst nur Import-Termine (`import_batch_id IS NOT NULL`). Damit wird
 * KEIN beliebiger consumption-freier Termin (z.B. Seed-/Sonderfälle)
 * angefasst, nur die importierte Population, in der jeder abgeschlossene
 * Termin eine Consumption haben MUSS.
 *
 * Idempotenz: Selektiert NUR Termine ohne Consumption — ein bereits gebuchter
 * Termin wird nicht mehr gefunden. Zusätzlich Re-Check innerhalb des Savepoints
 * (Schutz gegen Doppelbuchung) und der Migrations-Ledger verhindert Re-Runs
 * nach dem ersten erfolgreichen Lauf.
 *
 * Fault-Isolation: pro Termin ein Savepoint (`tx.transaction`), ein einzelner
 * Fehlschlag (z.B. Hard-Block ohne Budget) rollt nur diesen Termin zurück und
 * überspringt ihn, ohne die übrigen abzuwürgen. Der Guarded-Wrapper klammert
 * das Ganze mit einem Conservation-Pre-/Post-Check ein und rollt ALLES zurück,
 * falls eine NEUE Topf-Überziehung eingeführt würde.
 */
const BACKFILL_REASON =
  "Einmalige Bestandskorrektur (Startup): fehlende Import-Consumption " +
  "nachgebucht — Import-Update-No-Op bei nie gebuchten Terminen.";

export async function backfillMissingImportConsumption(
  tx: Tx,
): Promise<BudgetMigrationSummary> {
  const rows = await findMissingConsumptionAppointments({ onlyImported: true });
  if (rows.length === 0) {
    return { changed: 0, note: "keine Import-Termine ohne Consumption" };
  }

  // Mandatory Audit: ohne Akteur keine Mutation. Ältester Superadmin
  // (Fallback: ältester Admin) — dasselbe Muster wie der Import-Update-Drift-
  // Backfill.
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
      `Missing-Import-Consumption-Backfill übersprungen: kein Super-/Admin-Akteur für Audit-Log ` +
        `(${rows.length} Termin(e) ohne Consumption bleiben offen — Korrektur per ` +
        `tsx server/scripts/backfill-missing-import-consumption.ts --apply).`,
      "startup",
    );
    return { changed: 0, note: "kein Audit-Akteur" };
  }
  const auditActorId = actorId;

  log(
    `Missing-Import-Consumption-Backfill: ${rows.length} Import-Termin(e) ohne Consumption werden ` +
      `nachgebucht (Trigger: appointment_import:backfill).`,
    "startup",
  );

  let booked = 0;
  let noop = 0;
  let errored = 0;

  for (const row of rows) {
    try {
      const didBook = await tx.transaction(async (sp) => {
        // Idempotenz-Re-Check INNERHALB des Savepoints: existiert inzwischen
        // doch eine Consumption, nichts tun (Schutz gegen Doppelbuchung).
        const existing = await sp
          .select({ id: budgetTransactions.id })
          .from(budgetTransactions)
          .where(
            and(
              eq(budgetTransactions.appointmentId, row.appointmentId),
              eq(budgetTransactions.transactionType, "consumption"),
            ),
          )
          .limit(1);
        if (existing.length > 0) return false;

        let monthClosed = false;
        if (row.employeeId != null) {
          monthClosed = await isMonthClosed(row.employeeId, row.date);
        }

        await budgetStorage.createConsumptionTransaction(
          {
            customerId: row.customerId,
            appointmentId: row.appointmentId,
            transactionDate: row.date,
            hauswirtschaftMinutes: row.hauswirtschaftMinutes,
            alltagsbegleitungMinutes: row.alltagsbegleitungMinutes,
            travelKilometers: row.travelKilometers,
            customerKilometers: row.customerKilometers,
            userId: auditActorId,
          },
          sp,
        );

        // Erzeugte Consumption(en) (Kaskade über mehrere Töpfe möglich) mit
        // dem Import-Batch des Termins verknüpfen.
        if (row.importBatchId != null) {
          // Task #1273: budget_transactions ist seit Stufe B GoBD-immutable
          // (BEFORE-Trigger) — Bypass savepoint-lokal freischalten.
          await sp.execute(sql`SET LOCAL app.allow_gobd_mutation = 'on'`);
          await sp
            .update(budgetTransactions)
            .set({ importBatchId: row.importBatchId })
            .where(eq(budgetTransactions.appointmentId, row.appointmentId));
        }

        await auditService.log(
          auditActorId,
          "appointment_km_rebooked",
          "appointment",
          row.appointmentId,
          {
            customerId: row.customerId,
            trigger: REBOOK_TRIGGERS.import.backfill,
            firstTimeBooking: true,
            source: "backfill-missing-import-consumption",
            reason: BACKFILL_REASON,
            monthClosedAtCorrection: monthClosed,
            transactionDate: row.date,
            hauswirtschaftMinutes: row.hauswirtschaftMinutes,
            alltagsbegleitungMinutes: row.alltagsbegleitungMinutes,
            travelKilometers: row.travelKilometers,
            customerKilometers: row.customerKilometers,
            expectedCostCents: row.expectedCostCents,
            importBatchId: row.importBatchId,
          },
          undefined,
          sp,
        );

        return true;
      });

      if (didBook) booked++;
      else noop++;
    } catch (err) {
      errored++;
      log(
        `Missing-Import-Consumption-Backfill appt#${row.appointmentId} fehlgeschlagen: ` +
          `${err instanceof Error ? err.message : String(err)}`,
        "startup",
      );
    }
  }

  log(
    `Missing-Import-Consumption-Backfill abgeschlossen: booked=${booked}, noop=${noop}, errored=${errored}.`,
    "startup",
  );

  return {
    changed: booked,
    note: `booked=${booked}, noop=${noop}, errored=${errored}`,
  };
}
