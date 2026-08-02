import { sql } from "drizzle-orm";
import { db } from "../lib/db";
import { log } from "../lib/log";

/**
 * Task #1892 — Index auf `invoice_line_items.appointment_id`.
 *
 * Seit PR-2 (#24) ist die Idempotenz-Frage „liegt dieser Termin auf einer
 * aktiven Rechnung?" zeitraum-blind. Die SSoT
 * `findActiveInvoicesForAppointments` (`server/lib/appointment-invoiced.ts`)
 * filtert dafür ausschließlich über `invoice_line_items.appointment_id`
 * (`IN (...)`) und joint erst danach auf `invoices` — der frühere
 * `billing_year`/`billing_month`-Filter, der die Treffermenge vorab klein
 * hielt, ist ersatzlos entfallen.
 *
 * Ohne Index bedeutet das einen Seq-Scan über die gesamte Positions-Tabelle,
 * und zwar pro Aufruf auf drei heißen Lesepfaden: der Abrechnungs-Engine
 * (`getAlreadyInvoicedAppointmentIds`), dem Mutations-Schutz
 * (`appointment-billing-protection`) und den Eligibility-/Termin-Listen
 * (`pipeline-reader`, `termine-reader`). Die Tabelle wächst monoton mit jeder
 * Rechnungsposition und wird nie beschnitten.
 *
 * Rein additiv: ein Index ändert kein Verhalten und kein Ergebnis, nur den
 * Plan. Er ERSETZT nichts — es gibt keinen zweiten Index auf dieser Spalte;
 * die Fremdschlüssel-Referenz auf `appointments.id` legt in Postgres KEINEN
 * Index an (anders als bei einem PRIMARY KEY oder UNIQUE).
 *
 * Bewusst als idempotente Startup-DDL und NICHT als drizzle-kit-Migration:
 * Der Migrations-Weg dieses Projekts ist `drizzle-kit push` (siehe CLAUDE.md);
 * eine versionierte Migrations-Mechanik existiert noch nicht. Die Startup-Fixes
 * unter `server/startup/**` sind der etablierte Ort für additives DDL.
 *
 * `CREATE INDEX` (ohne `CONCURRENTLY`) nimmt für die Dauer des Aufbaus eine
 * `SHARE`-Sperre auf die Tabelle, blockiert also Schreibvorgänge. Das ist hier
 * vertretbar und bewusst gewählt: Der Aufruf läuft beim Container-Start, bevor
 * Traffic anliegt, `CONCURRENTLY` kann nicht in einer Transaktion laufen und
 * hinterlässt bei Abbruch einen ungültigen Index, der von Hand aufgeräumt
 * werden müsste. Ab dem zweiten Start ist das Statement dank
 * `IF NOT EXISTS` ein No-Op.
 */
export const INVOICE_LINE_ITEMS_APPOINTMENT_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS invoice_line_items_appointment_id_idx
    ON invoice_line_items (appointment_id)
`;

export async function ensureInvoiceLineItemAppointmentIndex(): Promise<void> {
  try {
    await db.execute(sql.raw(INVOICE_LINE_ITEMS_APPOINTMENT_INDEX_SQL));
  } catch (err) {
    log(`ensureInvoiceLineItemAppointmentIndex: ${err}`, "startup");
  }
}
