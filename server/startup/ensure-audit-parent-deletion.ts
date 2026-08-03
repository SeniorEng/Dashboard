import { db } from "../lib/db";
import { sql } from "drizzle-orm";
import { log } from "../lib/log";

/**
 * Stellt sicher, dass `audit_log.parent_deletion_id` (FK auf audit_log.id)
 * existiert. Wird für die Per-Child-Audit-Verkettung beim Kunden-Löschen
 * benötigt (Task #448). Idempotent (ADD COLUMN IF NOT EXISTS + IF NOT
 * EXISTS auf Index/Constraint).
 *
 * Der FK wird SPALTEN-basiert geprüft. Vorher stand hier eine NAMENS-basierte
 * Prüfung auf `audit_log_parent_deletion_id_fkey` — den PostgreSQL-Default-
 * Namen, den das Drizzle-Modell nicht kennt. Ergebnis war ein Deploy-Ping-Pong:
 * `drizzle-kit push` droppt den `_fkey` (steht nicht im Modell), der nächste
 * Boot legt ihn namensgleich wieder an. Beide FKs liegen deshalb nebeneinander
 * in der laufenden DB — funktional identisch, aber mit einem zweiten,
 * vollständigen Satz interner RI-Trigger auf der schreibintensivsten Tabelle.
 *
 * Kanonisch ist der Drizzle-Name `audit_log_parent_deletion_id_audit_log_id_fk`:
 * er steht im Modell (`shared/schema/audit.ts`), in der Baseline
 * (`migrations/0000_*.sql`) und folgt der Konvention aller 129 FKs des Schemas.
 * Die spaltenbasierte Prüfung findet ihn, egal unter welchem Namen er entstand,
 * und legt deshalb nichts Zweites an.
 */
// Task #922 — rohes Spalten-DDL als Konstante exportiert (Drift-Wächter-SSoT).
// FK + Index bleiben separat (PostgreSQL kann ADD COLUMN IF NOT EXISTS ...
// REFERENCES nicht atomar) und sind für den Spalten-Drift-Check irrelevant.
export const AUDIT_PARENT_DELETION_COLUMN_SQL = `
  ALTER TABLE audit_log
  ADD COLUMN IF NOT EXISTS parent_deletion_id integer
`;

// Task #923 — Index-DDL als Konstante exportiert (Index-Drift-Wächter-SSoT).
export const AUDIT_PARENT_DELETION_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS audit_log_parent_deletion_idx
  ON audit_log(parent_deletion_id)
`;

// FK-DDL als Konstante (analog `RESERVATION_CAPTURED_TX_FK_SQL`).
//
// `conrelid = 'audit_log'::regclass` ist Teil der Prüfung, nicht Kosmetik:
// `conname` ist in PostgreSQL nur PRO TABELLE eindeutig. Die alte Prüfung ohne
// diese Einschränkung hätte die Anlage auch dann unterdrückt, wenn ein
// gleichnamiger Constraint auf einer FREMDEN Tabelle gelegen hätte.
export const AUDIT_PARENT_DELETION_FK_SQL = `
  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint c
      JOIN pg_attribute a
        ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
      WHERE c.conrelid = 'audit_log'::regclass
        AND c.contype = 'f'
        AND a.attname = 'parent_deletion_id'
    ) THEN
      ALTER TABLE audit_log
      ADD CONSTRAINT audit_log_parent_deletion_id_audit_log_id_fk
      FOREIGN KEY (parent_deletion_id) REFERENCES audit_log(id);
    END IF;
  END $$;
`;

export async function ensureAuditParentDeletionColumn(): Promise<void> {
  await db.execute(sql.raw(AUDIT_PARENT_DELETION_COLUMN_SQL));

  await db.execute(sql.raw(AUDIT_PARENT_DELETION_FK_SQL));

  await db.execute(sql.raw(AUDIT_PARENT_DELETION_INDEX_SQL));

  log("audit_log.parent_deletion_id sichergestellt", "startup");
}
