/**
 * Cleanup-Skript für Task #151: Verwaiste Termine ohne Person aufspüren und bereinigen
 *
 * Identifiziert Termine, die weder mit einem Kunden NOCH mit einem Interessenten
 * verknüpft sind und (noch) nicht soft-deleted wurden:
 *   appointments.customer_id IS NULL
 *   AND appointments.prospect_id IS NULL
 *   AND appointments.deleted_at IS NULL
 *
 * Solche Datensätze entstehen historisch dadurch, dass beim Löschen eines
 * Interessenten `appointments.prospect_id` per `onDelete: "set null"` auf NULL
 * gesetzt wurde, ohne dass ein Kunde verknüpft war. Seit Task #149 verhindert
 * die Validierung neue Waisen.
 *
 * Verhalten:
 *   - DRY-RUN (Default): Listet alle Funde inkl. Datum, Uhrzeit, Mitarbeiter,
 *     Status, Notiz und liefert die Anzahl. Schreibt nichts in die Datenbank.
 *   - APPLY (--apply):   Soft-deletet jeden Fund (deleted_at = now()) und
 *     schreibt einen Audit-Eintrag (appointment_deleted) mit Begründung.
 *
 * Aufruf:
 *   - Trockenlauf:    tsx server/scripts/cleanup-orphan-appointments.ts
 *   - Scharf:         tsx server/scripts/cleanup-orphan-appointments.ts --apply
 */

import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "../lib/db";
import { appointments, users } from "@shared/schema";
import { auditService } from "../services/audit";

interface OrphanAppointment {
  id: number;
  date: string;
  scheduledStart: string;
  appointmentType: string;
  status: string;
  assignedEmployeeId: number | null;
  performedByEmployeeId: number | null;
  createdByUserId: number | null;
  notes: string | null;
  createdAt: Date;
}

async function findOrphanAppointments(): Promise<OrphanAppointment[]> {
  const rows = await db
    .select({
      id: appointments.id,
      date: appointments.date,
      scheduledStart: appointments.scheduledStart,
      appointmentType: appointments.appointmentType,
      status: appointments.status,
      assignedEmployeeId: appointments.assignedEmployeeId,
      performedByEmployeeId: appointments.performedByEmployeeId,
      createdByUserId: appointments.createdByUserId,
      notes: appointments.notes,
      createdAt: appointments.createdAt,
    })
    .from(appointments)
    .where(
      and(
        isNull(appointments.customerId),
        isNull(appointments.prospectId),
        isNull(appointments.deletedAt),
      ),
    )
    .orderBy(asc(appointments.date), asc(appointments.scheduledStart));

  return rows;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const mode = apply ? "APPLY (scharf)" : "DRY-RUN (Default)";
  console.log(`\n=== Cleanup orphan appointments (${mode}) ===\n`);

  const orphans = await findOrphanAppointments();

  if (orphans.length === 0) {
    console.log(
      "Keine verwaisten Termine gefunden (customer_id IS NULL AND prospect_id IS NULL AND deleted_at IS NULL).",
    );
    console.log("Nichts zu tun.\n");
    return;
  }

  console.log(`Gefundene verwaiste Termine: ${orphans.length}\n`);
  for (const o of orphans) {
    console.log(
      `  - #${o.id} ${o.date} ${o.scheduledStart} type=${o.appointmentType} status=${o.status} ` +
        `assignedEmployee=${o.assignedEmployeeId ?? "-"} createdBy=${o.createdByUserId ?? "-"} ` +
        `notes=${o.notes ? JSON.stringify(o.notes.slice(0, 60)) : "-"}`,
    );
  }
  console.log("");

  if (!apply) {
    console.log("Trockenlauf abgeschlossen. Mit --apply scharf ausführen.\n");
    return;
  }

  let auditUserId: number | null = null;
  const [admin] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.isAdmin, true))
    .orderBy(asc(users.id))
    .limit(1);
  if (admin) auditUserId = admin.id;
  else console.warn("Warnung: Kein Admin-User gefunden – Audit-Logs werden übersprungen.");

  const now = new Date();
  let softDeleted = 0;
  for (const o of orphans) {
    await db
      .update(appointments)
      .set({ deletedAt: now })
      .where(and(eq(appointments.id, o.id), isNull(appointments.deletedAt)));
    softDeleted++;

    if (auditUserId == null) continue;
    await auditService.log(
      auditUserId,
      "appointment_deleted",
      "appointment",
      o.id,
      {
        reason:
          "Task #151: verwaister Termin ohne Kunden- UND ohne Interessenten-Verknüpfung – Soft-Delete",
        previousStatus: o.status,
        date: o.date,
        scheduledStart: o.scheduledStart,
        appointmentType: o.appointmentType,
        assignedEmployeeId: o.assignedEmployeeId,
        performedByEmployeeId: o.performedByEmployeeId,
        createdByUserId: o.createdByUserId,
      },
      undefined,
    );
  }

  console.log(`Soft-deleted: ${softDeleted}/${orphans.length}\n`);

  const remaining = await findOrphanAppointments();
  if (remaining.length === 0) {
    console.log("Verifikation: Keine verwaisten Termine mehr vorhanden.\n");
  } else {
    console.warn(
      `Warnung: Nach Cleanup verbleiben ${remaining.length} verwaiste Termine. Bitte prüfen.\n`,
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Cleanup fehlgeschlagen:", err);
    process.exit(1);
  });
