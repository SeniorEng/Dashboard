import { db } from "../lib/db";
import { sql } from "drizzle-orm";
import { log } from "../lib/log";

export async function fixInvoiceLineItemTypes(): Promise<void> {
  const check = await db.execute(sql`
    SELECT data_type FROM information_schema.columns
    WHERE table_name = 'invoice_line_items' AND column_name = 'appointment_date'
  `);
  const currentType = (check.rows as Array<{ data_type: string }>)[0]?.data_type;
  if (!currentType || currentType === "date") return;

  await db.execute(sql`
    ALTER TABLE "invoice_line_items"
      ALTER COLUMN "appointment_date" SET DATA TYPE date USING appointment_date::date
  `);
  await db.execute(sql`
    ALTER TABLE "invoice_line_items"
      ALTER COLUMN "start_time" SET DATA TYPE time USING start_time::time
  `);
  await db.execute(sql`
    ALTER TABLE "invoice_line_items"
      ALTER COLUMN "end_time" SET DATA TYPE time USING end_time::time
  `);

  log("invoice_line_items: appointment_date→date, start_time/end_time→time umgewandelt", "startup");
}
