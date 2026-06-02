import { db } from "../lib/db";
import { sql } from "drizzle-orm";
import { log } from "../lib/log";

// Task #922 — rohes DDL als Konstante exportiert (Drift-Wächter-SSoT).
export const INVOICE_STORNO_REFS_COLUMN_SQL = `
  ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS referenced_storno_invoice_ids integer[]
`;

export async function migrateInvoiceStornoRefs(): Promise<void> {
  await db.execute(sql.raw(INVOICE_STORNO_REFS_COLUMN_SQL));
  log("Invoice-Schema-Migration: referenced_storno_invoice_ids sichergestellt", "startup");
}
