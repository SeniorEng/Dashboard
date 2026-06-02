import { db } from "../lib/db";
import { sql } from "drizzle-orm";
import { log } from "../lib/log";

/**
 * Task #561: stellt die Spalten `quantity_raw` (real) und `quantity_unit`
 * (text: "hours" | "km") auf `invoice_line_items` sicher. Beide sind
 * nullable — historische Zeilen behalten NULL, das PDF-Template fällt für
 * sie auf `duration_minutes` zurück (GoBD-Immutabilität).
 */
// Task #922 — rohes DDL als Konstante exportiert (Drift-Wächter-SSoT).
// HINWEIS: `quantity_raw` wird hier als `real` angelegt, aber direkt danach von
// `migrate-km-geo-to-numeric.ts` auf `numeric(10,3)` migriert (siehe
// KM_GEO_COLUMNS). Der Drift-Wächter prüft `quantity_raw` daher NICHT in diesem
// ADD-COLUMN-Block (Zwischentyp), sondern über die ALTER-TYPE-Registry gegen das
// finale Drizzle-`numeric(10,3)`.
export const INVOICE_LINE_ITEM_QUANTITY_COLUMNS_SQL = `
  ALTER TABLE invoice_line_items
  ADD COLUMN IF NOT EXISTS quantity_raw real,
  ADD COLUMN IF NOT EXISTS quantity_unit text
`;

export async function ensureInvoiceLineItemQuantityColumns(): Promise<void> {
  await db.execute(sql.raw(INVOICE_LINE_ITEM_QUANTITY_COLUMNS_SQL));
  log("Invoice-Line-Item-Schema: quantity_raw/quantity_unit sichergestellt", "startup");
}
