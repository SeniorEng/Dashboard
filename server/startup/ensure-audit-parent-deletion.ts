import { db } from "../lib/db";
import { sql } from "drizzle-orm";
import { log } from "../lib/log";

/**
 * Stellt sicher, dass `audit_log.parent_deletion_id` (FK auf audit_log.id)
 * existiert. Wird für die Per-Child-Audit-Verkettung beim Kunden-Löschen
 * benötigt (Task #448). Idempotent (ADD COLUMN IF NOT EXISTS + IF NOT
 * EXISTS auf Index/Constraint).
 */
export async function ensureAuditParentDeletionColumn(): Promise<void> {
  await db.execute(sql`
    ALTER TABLE audit_log
    ADD COLUMN IF NOT EXISTS parent_deletion_id integer
  `);

  // FK separat anlegen — ADD COLUMN IF NOT EXISTS ... REFERENCES geht in
  // PostgreSQL nicht atomar. Wir prüfen über pg_constraint.
  await db.execute(sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'audit_log_parent_deletion_id_fkey'
      ) THEN
        ALTER TABLE audit_log
        ADD CONSTRAINT audit_log_parent_deletion_id_fkey
        FOREIGN KEY (parent_deletion_id) REFERENCES audit_log(id);
      END IF;
    END$$;
  `);

  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS audit_log_parent_deletion_idx
    ON audit_log(parent_deletion_id)
  `);

  log("audit_log.parent_deletion_id sichergestellt", "startup");
}
