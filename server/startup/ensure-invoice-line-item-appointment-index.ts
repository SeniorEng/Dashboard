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
 * `SHARE`-Sperre auf die Tabelle und blockiert damit Schreibvorgänge.
 *
 * Die naheliegende Beruhigung „läuft beim Start, bevor Traffic anliegt" stimmt
 * NICHT und wurde im Review widerlegt: `runStartupTasks()` läuft im
 * `httpServer.listen`-Callback und wird nicht awaited, der Container nimmt also
 * bereits Requests an; und weil der Index (korrekterweise) auch im Drizzle-
 * Modell steht, legt ihn in Prod ohnehin zuerst der Pre-Deploy
 * (`scripts/migrate.sh` → `drizzle-kit push`) an — während der ALTE Container
 * vollen Traffic bedient.
 *
 * Tragfähig ist nur das zweite Argument: `CONCURRENTLY` hinterlässt bei Abbruch
 * einen ungültigen Index, der von Hand aufgeräumt werden müsste. Deshalb bleibt
 * es beim nicht-nebenläufigen Aufbau — aber mit `lock_timeout`. Ohne das würde
 * sich `CREATE INDEX` hinter einem laufenden Abrechnungslauf in die Lock-Queue
 * stellen und alle nachfolgenden Schreiber (Rechnungserstellung, Storno) hinter
 * sich aufstauen, unbegrenzt. Mit Timeout bricht der Versuch nach 5 s ab; der
 * nächste Boot wiederholt ihn, `IF NOT EXISTS` macht ihn dann zum No-Op.
 *
 * `CREATE INDEX` ohne `CONCURRENTLY` darf in einer Transaktion laufen — nur so
 * greift `SET LOCAL`.
 */
export const INVOICE_LINE_ITEMS_APPOINTMENT_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS invoice_line_items_appointment_id_idx
    ON invoice_line_items (appointment_id)
`;

/** Timeout für die `SHARE`-Sperre, siehe Kopf-Kommentar. */
export const INVOICE_LINE_ITEMS_APPOINTMENT_INDEX_LOCK_TIMEOUT_SQL =
  `SET LOCAL lock_timeout = '5s'`;

export async function ensureInvoiceLineItemAppointmentIndex(): Promise<void> {
  // Bewusst KEIN eigenes try/catch: der Aufrufer in `server/index.ts` fängt und
  // loggt bereits. Zwei Ebenen hätten bedeutet, dass die äußere nie greift und
  // ein dauerhafter Fehlschlag (z.B. fehlende Rechte) still bleibt, während der
  // Seq-Scan-Zustand weiterläuft. Gleiches Muster wie
  // `ensure-audit-parent-deletion.ts`.
  await db.transaction(async (tx) => {
    await tx.execute(sql.raw(INVOICE_LINE_ITEMS_APPOINTMENT_INDEX_LOCK_TIMEOUT_SQL));
    await tx.execute(sql.raw(INVOICE_LINE_ITEMS_APPOINTMENT_INDEX_SQL));
  });
  log("ensureInvoiceLineItemAppointmentIndex: invoice_line_items_appointment_id_idx sichergestellt", "startup");
}
