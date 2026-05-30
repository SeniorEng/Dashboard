import { db } from "../lib/db";
import { sql } from "drizzle-orm";
import { log } from "../lib/log";

/**
 * GoBD: technische Unveränderbarkeit von `audit_log` (Task #824).
 *
 * Historisch schützten zwei RULEs (`audit_log_no_delete` / `audit_log_no_update`)
 * die Tabelle mit `DO INSTEAD NOTHING`. Das *verschluckt* UPDATE/DELETE jedoch
 * still — der Aufrufer bekommt „0 rows affected" zurück, statt einen Fehler.
 * GoBD verlangt aber, dass ein Manipulationsversuch technisch FEHLSCHLÄGT, nicht
 * leise ins Leere läuft.
 *
 * Diese Migration ersetzt die stillen RULEs durch BEFORE-Trigger, die eine
 * Exception werfen. Trigger feuern für JEDEN Aufrufer (auch den Tabellen-
 * Owner/`postgres`), während ein `REVOKE` beim Owner wirkungslos bliebe.
 *
 * Legitime Test-Cleanup-Pfade (ausschließlich in Nicht-Prod erreichbar,
 * hostname-guarded) setzen transaktions-lokal
 * `SET LOCAL app.allow_audit_log_mutation = 'on'`, womit der Trigger die
 * Mutation für genau diese Transaktion durchlässt. In Produktion wird dieses
 * GUC nie gesetzt → jeder UPDATE/DELETE/TRUNCATE schlägt fehl.
 *
 * Idempotent: DROP RULE/TRIGGER IF EXISTS + CREATE OR REPLACE FUNCTION; bei
 * jedem weiteren Boot ein No-Op.
 */
export async function ensureAuditLogImmutable(): Promise<void> {
  // Alte still-schluckende RULEs entfernen. Eine `ON DELETE DO INSTEAD NOTHING`
  // RULE schreibt das Statement so um, dass der BEFORE-DELETE-Trigger gar nicht
  // mehr feuern würde — die RULEs MÜSSEN also weichen, damit der Trigger greift.
  await db.execute(sql`DROP RULE IF EXISTS audit_log_no_delete ON audit_log`);
  await db.execute(sql`DROP RULE IF EXISTS audit_log_no_update ON audit_log`);

  await db.execute(sql`
    CREATE OR REPLACE FUNCTION audit_log_prevent_mutation()
    RETURNS trigger AS $$
    BEGIN
      IF current_setting('app.allow_audit_log_mutation', true) = 'on' THEN
        RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
      END IF;
      RAISE EXCEPTION
        'audit_log ist GoBD-technisch unveraenderbar (% verweigert)', TG_OP
        USING ERRCODE = 'restrict_violation';
    END;
    $$ LANGUAGE plpgsql;
  `);

  await db.execute(sql`
    CREATE OR REPLACE FUNCTION audit_log_prevent_truncate()
    RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION
        'audit_log ist GoBD-technisch unveraenderbar (TRUNCATE verweigert)'
        USING ERRCODE = 'restrict_violation';
    END;
    $$ LANGUAGE plpgsql;
  `);

  await db.execute(sql`DROP TRIGGER IF EXISTS audit_log_no_update_trigger ON audit_log`);
  await db.execute(sql`
    CREATE TRIGGER audit_log_no_update_trigger
    BEFORE UPDATE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION audit_log_prevent_mutation();
  `);

  await db.execute(sql`DROP TRIGGER IF EXISTS audit_log_no_delete_trigger ON audit_log`);
  await db.execute(sql`
    CREATE TRIGGER audit_log_no_delete_trigger
    BEFORE DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION audit_log_prevent_mutation();
  `);

  await db.execute(sql`DROP TRIGGER IF EXISTS audit_log_no_truncate_trigger ON audit_log`);
  await db.execute(sql`
    CREATE TRIGGER audit_log_no_truncate_trigger
    BEFORE TRUNCATE ON audit_log
    FOR EACH STATEMENT EXECUTE FUNCTION audit_log_prevent_truncate();
  `);

  log("audit_log Unveraenderbarkeit (Trigger) sichergestellt", "startup");
}
