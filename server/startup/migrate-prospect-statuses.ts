import { db } from "../lib/db";
import { sql } from "drizzle-orm";
import { log } from "../lib/log";

export async function migrateProspectStatuses(): Promise<void> {
  const angebotResult = await db.execute(sql`
    UPDATE prospects
    SET status = 'erstberatung_durchgeführt', updated_at = NOW()
    WHERE status = 'angebot_gemacht' AND deleted_at IS NULL
  `);
  const angebotCount = (angebotResult as any).rowCount ?? 0;

  const absageResult = await db.execute(sql`
    UPDATE prospects
    SET status = 'nicht_interessiert', updated_at = NOW()
    WHERE status = 'absage' AND deleted_at IS NULL
  `);
  const absageCount = (absageResult as any).rowCount ?? 0;

  if (angebotCount > 0 || absageCount > 0) {
    log(
      `Prospect-Status-Migration: ${angebotCount}x angebot_gemacht → erstberatung_durchgeführt, ${absageCount}x absage → nicht_interessiert`,
      "startup"
    );
  }
}
