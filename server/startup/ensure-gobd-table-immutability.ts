import { db } from "../lib/db";
import { sql } from "drizzle-orm";
import { log } from "../lib/log";
import {
  type StartupTriggerSpec,
  renderCreateTriggerSql,
  renderDropTriggerSql,
} from "./trigger-spec";

import {
  GOBD_PREVENT_RESURRECT_FN_SQL,
  GOBD_ALLOCATIONS_PREVENT_DELETE_FN_SQL,
  GOBD_CBTS_PREVENT_DELETE_FN_SQL,
  GOBD_INVOICES_PREVENT_FINALIZED_DELETE_FN_SQL,
  GOBD_LINE_ITEMS_PREVENT_FINALIZED_MUTATION_FN_SQL,
  GOBD_PREVENT_TRUNCATE_FN_SQL,
  GOBD_TRUNCATE_PROTECTED_TABLES,
  GOBD_TABLE_TRIGGERS,
} from "./trigger-registry";


/**
 * GoBD: technische Absicherung weiterer integritäts-/historisierungskritischer
 * Tabellen gegen stilles Überschreiben (Task #828).
 *
 * `audit_log` ist seit Task #824 per raising BEFORE-Trigger unveränderbar. Die
 * übrigen GoBD-relevanten Tabellen verließen sich bislang ausschließlich auf
 * App-Logik (Soft-Deletes, append-only Konventionen). Eine versehentliche oder
 * bösartige direkte Mutation (z.B. `DELETE FROM budget_allocations …` oder ein
 * Resurrect via `deleted_at = NULL`) wäre still durchgegangen.
 *
 * Diese Migration legt BEFORE-Trigger an, die solche Mutationen mit einer
 * Exception ABLEHNEN (nicht still schlucken — GoBD verlangt technisches
 * Fehlschlagen). Geschützt werden:
 *
 *  - `budget_allocations`        — kein Resurrect (`deleted_at` NOT NULL → NULL),
 *                                  kein Hard-Delete, kein TRUNCATE.
 *  - `customer_budget_type_settings` — append-only: kein Hard-Delete,
 *                                  kein TRUNCATE. (UPDATEs bleiben erlaubt, da
 *                                  der Phasen-Append/In-Place-Pfad geschlossene
 *                                  Zeilen legitim umklemmt.)
 *  - `invoices`                  — finalisierte Rechnungen (`status <> 'entwurf'`)
 *                                  dürfen nicht hart gelöscht werden; kein
 *                                  TRUNCATE. (UPDATE bleibt erlaubt: Status-
 *                                  Übergänge, Qonto-Payment-Matching, PDF-Cache.)
 *  - `invoice_line_items`        — Positionen finalisierter Rechnungen sind
 *                                  eingefroren: kein UPDATE/DELETE, kein TRUNCATE.
 *
 * Legitime Test-/Cleanup-/Merge-Pfade (Kunden-Merge, Test-Daten-Purge,
 * gegatete Budget-Daten-Migrationen) setzen transaktions-lokal
 * `SET LOCAL app.allow_gobd_mutation = 'on'`, womit die Trigger die Mutation
 * für genau diese Transaktion durchlassen. In Produktion wird dieses GUC nie
 * gesetzt → jeder verbotene Schreibzugriff schlägt fehl.
 *
 * Idempotent: CREATE OR REPLACE FUNCTION + DROP TRIGGER IF EXISTS/CREATE; bei
 * jedem weiteren Boot ein No-Op.
 */
export async function ensureGobdTableImmutability(): Promise<void> {
  // Trigger-Funktionen (CREATE OR REPLACE — idempotent).
  await db.execute(sql.raw(GOBD_PREVENT_RESURRECT_FN_SQL));
  await db.execute(sql.raw(GOBD_ALLOCATIONS_PREVENT_DELETE_FN_SQL));
  await db.execute(sql.raw(GOBD_CBTS_PREVENT_DELETE_FN_SQL));
  await db.execute(sql.raw(GOBD_INVOICES_PREVENT_FINALIZED_DELETE_FN_SQL));
  await db.execute(sql.raw(GOBD_LINE_ITEMS_PREVENT_FINALIZED_MUTATION_FN_SQL));
  await db.execute(sql.raw(GOBD_PREVENT_TRUNCATE_FN_SQL));

  // Trigger (DROP IF EXISTS + CREATE) aus den SSoT-Specs rendern.
  for (const spec of GOBD_TABLE_TRIGGERS) {
    await db.execute(sql.raw(renderDropTriggerSql(spec)));
    await db.execute(sql.raw(renderCreateTriggerSql(spec)));
  }

  log("GoBD-Unveraenderbarkeit weiterer Tabellen (Trigger) sichergestellt", "startup");
}
