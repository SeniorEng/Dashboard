import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { db, type DbOrTx } from "../lib/db";
import { budgetTransactions, users } from "@shared/schema";
import { auditService } from "../services/audit";
import { log } from "../lib/log";

/**
 * Task #963 — Einmaliger Backfill fehl-datierter Storno-Buchungen.
 *
 * Hintergrund: `reverseBudgetTransaction` hat die Reversal-Zeile bislang mit
 * `transactionDate = todayISO()` (Storno-Datum von heute) angelegt statt mit
 * dem `transactionDate` der stornierten Original-Consumption. Der Budget-Check
 * beim Dokumentieren rechnet die Verfügbarkeit aber stichtagsbezogen auf das
 * Termindatum (`transactionDate <= asOfDate`). Lag das Storno-Datum NACH dem
 * Termindatum, fiel die Gutschrift aus dem Fenster — die stornierte Consumption
 * zählte weiter, ihre Rückbuchung aber nicht. Der Topf wirkte überzogen und ein
 * real dokumentierbarer Termin wurde fälschlich hart geblockt (Anzeige-vs-
 * Buchung-Drift). Der Code-Fix koppelt das Reversal-`transactionDate` ab sofort
 * an die Originalbuchung; dieser Backfill korrigiert die bereits existierenden
 * Zeilen (Prod: 27 Zeilen / 17 Kunden).
 *
 * Strategie: jede Reversal-Zeile (`transaction_type = 'reversal'`,
 * `reversed_transaction_id IS NOT NULL`), deren `transaction_date` vom
 * `transaction_date` der referenzierten Originalzeile abweicht, auf das
 * Original-Datum umdatieren. Nur das fachliche `transaction_date` wird
 * geändert — `created_at` (realer Ausführungszeitpunkt) und alle Beträge
 * bleiben unangetastet (GoBD). Jede Korrektur wird mit
 * `storno_transaction_date_backfilled` auditiert.
 *
 * Hinweis: Dieser einmalige Bestands-Backfill datiert NUR ältere, fehl-datierte
 * Reversal-Zeilen um und lief vor der GoBD-Härtung von `budget_transactions`
 * (Stufe B, Task #1273). Neuere Korrekturen an der jetzt immutable Tabelle
 * laufen über den Bypass-GUC `app.allow_gobd_mutation`.
 *
 * Vollständig idempotent (nach einem Lauf gibt es keine abweichenden Reversal-
 * Daten mehr). Mit `dryRun = true` (oder Env
 * `BACKFILL_STORNO_TX_DATE_DRY_RUN=1`) wird nur geloggt, ohne zu schreiben.
 */
export async function backfillStornoTransactionDate(
  dryRun = process.env.BACKFILL_STORNO_TX_DATE_DRY_RUN === "1",
  exec: DbOrTx = db,
): Promise<void> {
  const orig = sql`orig`;
  const rows = (
    await exec.execute(sql`
      SELECT
        rev.id AS "id",
        rev.customer_id AS "customerId",
        rev.transaction_date AS "reversalDate",
        rev.reversed_transaction_id AS "reversedTransactionId",
        ${orig}.transaction_date AS "originalDate"
      FROM ${budgetTransactions} AS rev
      JOIN ${budgetTransactions} AS ${orig}
        ON ${orig}.id = rev.reversed_transaction_id
      WHERE rev.transaction_type = 'reversal'
        AND rev.reversed_transaction_id IS NOT NULL
        AND rev.transaction_date <> ${orig}.transaction_date
    `)
  ).rows as Array<{
    id: number;
    customerId: number;
    reversalDate: string;
    reversedTransactionId: number;
    originalDate: string;
  }>;

  if (rows.length === 0) return;

  // System-Actor (Super-/Admin) für die Audit-Einträge.
  const [superActor] = await exec
    .select({ id: users.id })
    .from(users)
    .where(eq(users.isSuperAdmin, true))
    .orderBy(asc(users.id))
    .limit(1);
  let systemActorId: number | null = superActor?.id ?? null;
  if (systemActorId == null) {
    const [adminActor] = await exec
      .select({ id: users.id })
      .from(users)
      .where(eq(users.isAdmin, true))
      .orderBy(asc(users.id))
      .limit(1);
    systemActorId = adminActor?.id ?? null;
  }

  let correctedCount = 0;
  let skippedNoActorCount = 0;

  // budget_transactions ist GoBD-immutable (BEFORE-Trigger). Der transaktions-
  // lokale GoBD-Bypass wird hier explizit auf der bereitgestellten Transaktion
  // (`exec`) gesetzt; der aufrufende runGuardedBudgetMigration-Runner setzt ihn
  // zusätzlich (gobdBypass: true) — doppeltes `SET LOCAL` im selben Tx ist ein
  // No-Op. Macht den audit-pflichtigen Korrekturpfad in dieser Datei explizit.
  if (!dryRun) {
    await exec.execute(sql`SET LOCAL app.allow_gobd_mutation = 'on'`);
  }

  for (const row of rows) {
    if (dryRun) {
      correctedCount++;
      continue;
    }
    if (systemActorId == null) {
      skippedNoActorCount++;
      continue;
    }

    // Task #1273: budget_transactions ist seit Stufe B per BEFORE-Trigger
    // GoBD-immutable. Der GoBD-Bypass (`app.allow_gobd_mutation`) wird vom
    // aufrufenden `runGuardedBudgetMigration`-Runner transaktions-lokal gesetzt
    // (gobdBypass: true). Update + Audit laufen in DESSEN Transaktion gemeinsam
    // mit dem Ledger-Eintrag (exactly-once, atomar).
    await exec
      .update(budgetTransactions)
      .set({ transactionDate: row.originalDate })
      .where(
        and(
          eq(budgetTransactions.id, row.id),
          eq(budgetTransactions.transactionType, "reversal"),
          isNotNull(budgetTransactions.reversedTransactionId),
        ),
      );

    await auditService.log(
      systemActorId!,
      "storno_transaction_date_backfilled",
      "budget",
      row.id,
      {
        task: "#963",
        customerId: row.customerId,
        transactionId: row.id,
        reversedTransactionId: row.reversedTransactionId,
        previousTransactionDate: row.reversalDate,
        correctedTransactionDate: row.originalDate,
      },
      undefined,
      exec,
    );
    correctedCount++;
  }

  const prefix = dryRun ? "[DRY-RUN] " : "";
  log(
    `${prefix}Storno-transactionDate-Backfill (Task #963): ${rows.length} fehl-datierte ` +
      `Reversal-Zeilen gefunden, ${correctedCount} korrigiert` +
      (skippedNoActorCount > 0
        ? `, ${skippedNoActorCount} ohne System-Actor übersprungen`
        : ""),
    "startup",
  );
}
