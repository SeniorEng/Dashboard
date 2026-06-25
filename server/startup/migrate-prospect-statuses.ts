import { db, type DbOrTx } from "../lib/db";
import { sql } from "drizzle-orm";
import { log } from "../lib/log";

export async function migrateProspectStatuses(exec: DbOrTx = db): Promise<void> {
  const angebotResult = await exec.execute(sql`
    UPDATE prospects
    SET status = 'erstberatung_durchgeführt', updated_at = NOW()
    WHERE status = 'angebot_gemacht' AND deleted_at IS NULL
  `);
  const angebotCount = (angebotResult as any).rowCount ?? 0;

  const absageResult = await exec.execute(sql`
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
