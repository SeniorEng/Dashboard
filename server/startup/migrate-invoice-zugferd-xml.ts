import { db } from "../lib/db";
import { sql } from "drizzle-orm";
import { log } from "../lib/log";

export async function migrateInvoiceZugferdXml(): Promise<void> {
  await db.execute(sql`
    ALTER TABLE invoices
    ADD COLUMN IF NOT EXISTS zugferd_xml text
  `);
  log("Invoice-Schema-Migration: zugferd_xml sichergestellt", "startup");
}
