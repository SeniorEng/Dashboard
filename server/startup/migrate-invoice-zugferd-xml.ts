import { db } from "../lib/db";
import { sql } from "drizzle-orm";
import { log } from "../lib/log";

// Task #922 — rohes DDL als Konstante exportiert (Drift-Wächter-SSoT).
export const INVOICE_ZUGFERD_XML_COLUMN_SQL = `
  ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS zugferd_xml text
`;

export async function migrateInvoiceZugferdXml(): Promise<void> {
  await db.execute(sql.raw(INVOICE_ZUGFERD_XML_COLUMN_SQL));
  log("Invoice-Schema-Migration: zugferd_xml sichergestellt", "startup");
}
