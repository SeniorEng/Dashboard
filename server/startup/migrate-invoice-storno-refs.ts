import { db } from "../lib/db";
import { sql } from "drizzle-orm";
import { log } from "../lib/log";

export async function migrateInvoiceStornoRefs(): Promise<void> {
  await db.execute(sql`
    ALTER TABLE invoices
    ADD COLUMN IF NOT EXISTS referenced_storno_invoice_ids integer[]
  `);
  log("Invoice-Schema-Migration: referenced_storno_invoice_ids sichergestellt", "startup");
}
