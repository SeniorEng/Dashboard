import { db } from "../lib/db";
import { sql } from "drizzle-orm";
import { log } from "../lib/log";

/**
 * Task #561: stellt die Spalten `quantity_raw` (real) und `quantity_unit`
 * (text: "hours" | "km") auf `invoice_line_items` sicher. Beide sind
 * nullable — historische Zeilen behalten NULL, das PDF-Template fällt für
 * sie auf `duration_minutes` zurück (GoBD-Immutabilität).
 */
export async function ensureInvoiceLineItemQuantityColumns(): Promise<void> {
  await db.execute(sql`
    ALTER TABLE invoice_line_items
    ADD COLUMN IF NOT EXISTS quantity_raw real,
    ADD COLUMN IF NOT EXISTS quantity_unit text
  `);
  log("Invoice-Line-Item-Schema: quantity_raw/quantity_unit sichergestellt", "startup");
}
