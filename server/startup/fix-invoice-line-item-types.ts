import { db } from "../lib/db";
import { sql } from "drizzle-orm";
import { log } from "../lib/log";

export async function fixColumnTypes(): Promise<void> {
  const cols = await db.execute(sql`
    SELECT table_name, column_name, data_type
    FROM information_schema.columns
    WHERE (table_name = 'invoice_line_items' AND column_name IN ('appointment_date', 'start_time', 'end_time'))
       OR (table_name = 'customers' AND column_name = 'inaktiv_ab')
    ORDER BY table_name, column_name
  `);

  const textCols = (cols.rows as Array<{ table_name: string; column_name: string; data_type: string }>)
    .filter(r => r.data_type === "text");

  if (textCols.length === 0) return;

  for (const col of textCols) {
    const targetType = (col.column_name === "start_time" || col.column_name === "end_time") ? "time" : "date";
    await db.execute(sql.raw(
      `ALTER TABLE "${col.table_name}" ALTER COLUMN "${col.column_name}" SET DATA TYPE ${targetType} USING "${col.column_name}"::${targetType}`
    ));
  }

  log(`Spaltentypen korrigiert: ${textCols.map(c => `${c.table_name}.${c.column_name}→${c.column_name.includes("time") ? "time" : "date"}`).join(", ")}`, "startup");
}
