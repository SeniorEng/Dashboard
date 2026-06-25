/**
 * Task #639 — Migration: tasks.status `in-progress` → `tasks_in_progress`.
 *
 * Mit Task #638 wurde der Appointment-Status `in-progress` abgeschafft. Im
 * Aufgaben-Modul (`tasks`-Tabelle) wurde derselbe String aber weiterhin für
 * einen ANDEREN Domain-Begriff verwendet (in Bearbeitung befindliche Aufgabe).
 * Um Cross-Domain-Suchen und -Filter eindeutig zu machen, wird der Wert hier
 * idempotent auf `tasks_in_progress` umbenannt.
 */
import { sql } from "drizzle-orm";
import { db, type DbOrTx } from "../lib/db";
import { log } from "../lib/log";

export async function migrateTaskStatusInProgress(exec: DbOrTx = db): Promise<void> {
  const result = await exec.execute(sql`
    WITH updated AS (
      UPDATE tasks
      SET status = 'tasks_in_progress'
      WHERE status = 'in-progress'
      RETURNING id
    )
    SELECT id FROM updated
  `);

  const rows = (result.rows ?? []) as Array<{ id: number }>;
  if (rows.length === 0) return;

  log(
    `Task #639: ${rows.length} Aufgabe(n) von 'in-progress' auf 'tasks_in_progress' migriert`,
    "startup",
  );
}
