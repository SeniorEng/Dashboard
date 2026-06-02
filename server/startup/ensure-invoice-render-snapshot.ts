import { db } from "../lib/db";
import { sql } from "drizzle-orm";
import { log } from "../lib/log";

/**
 * Task #593: stellt die Spalte `render_snapshot` auf `invoices` sicher.
 * Sie pinnt companySettings + relevante Kunden-Stammfelder zum Zeitpunkt
 * der initialen PDF-/XML-Erstellung — der Integrity-Verifier rendert das
 * XML aus diesem Snapshot neu, damit parallele Mutationen an
 * `company_settings` (oder am Kunden) keine falsch-positiven Drift-Treffer
 * produzieren. Idempotente DDL — beim nächsten Boot ein No-Op.
 */
// Task #922 — rohes DDL als Konstante exportiert (Drift-Wächter-SSoT).
export const INVOICE_RENDER_SNAPSHOT_COLUMN_SQL = `
  ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS render_snapshot jsonb
`;

export async function ensureInvoiceRenderSnapshotColumn(): Promise<void> {
  await db.execute(sql.raw(INVOICE_RENDER_SNAPSHOT_COLUMN_SQL));
  log("Invoice-Schema-Migration: render_snapshot sichergestellt", "startup");
}
