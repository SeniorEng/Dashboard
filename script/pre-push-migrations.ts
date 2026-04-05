import { neon } from "@neondatabase/serverless";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}

const sql = neon(DATABASE_URL);

async function run() {
  const check = await sql`
    SELECT data_type FROM information_schema.columns
    WHERE table_name = 'invoice_line_items' AND column_name = 'appointment_date'
  `;
  
  if (!check[0] || check[0].data_type === "date") {
    console.log("invoice_line_items: columns already correct type, skipping");
    return;
  }

  console.log("invoice_line_items: converting text → date/time columns...");
  
  await sql`ALTER TABLE "invoice_line_items"
    ALTER COLUMN "appointment_date" SET DATA TYPE date USING appointment_date::date`;
  await sql`ALTER TABLE "invoice_line_items"
    ALTER COLUMN "start_time" SET DATA TYPE time USING start_time::time`;
  await sql`ALTER TABLE "invoice_line_items"
    ALTER COLUMN "end_time" SET DATA TYPE time USING end_time::time`;

  console.log("invoice_line_items: columns converted successfully");
}

run().catch((err) => {
  console.error("Pre-push migration failed:", err);
  process.exit(1);
});
