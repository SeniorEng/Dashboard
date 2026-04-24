import { db } from "../lib/db";
import { sql } from "drizzle-orm";
import { log } from "../lib/log";

export async function migrateSchulungBesprechungToSonstiges(): Promise<void> {
  const check = await db.execute(sql`
    SELECT COUNT(*) as cnt FROM employee_time_entries
    WHERE entry_type IN ('schulung', 'besprechung')
  `);
  const pending = Number((check.rows as Array<{ cnt: string }>)[0]?.cnt ?? 0);
  if (pending === 0) return;

  log(`Time-Entry-Migration: ${pending} Einträge mit entry_type 'schulung'/'besprechung' gefunden`, "startup");

  const result: { rowCount?: number | null } = await db.execute(sql`
    UPDATE employee_time_entries
    SET entry_type = 'sonstiges'
    WHERE entry_type IN ('schulung', 'besprechung')
  `);

  const migrated = result.rowCount ?? 0;

  const verify = await db.execute(sql`
    SELECT COUNT(*) as cnt FROM employee_time_entries
    WHERE entry_type IN ('schulung', 'besprechung')
  `);
  const remaining = Number((verify.rows as Array<{ cnt: string }>)[0]?.cnt ?? 0);

  log(`Time-Entry-Migration: ${migrated} Einträge auf 'sonstiges' migriert; verbleibend: ${remaining}`, "startup");

  if (remaining > 0) {
    log(`Time-Entry-Migration: WARN — ${remaining} Einträge wurden nicht migriert`, "startup");
  }
}
