import { sql } from "drizzle-orm";
import { db } from "../lib/db";
import { log } from "../lib/log";

/**
 * Task #1272 (Stufe A) — Einmaliger, idempotenter Backfill des zweiten
 * Capture-Links `budget_reservations.captured_transaction_id`.
 *
 * Hintergrund: `budget_ledger` ist heute ein reiner Spiegel von
 * `budget_transactions` (Capture-Insert im Hard-Hold-Pfad). Bis Task #1272 hing
 * eine captured Reservierung nur über `captured_ledger_id` an der gespiegelten
 * Ledger-Zeile. Der Code-Fix setzt ab sofort BEIDE Links; dieser Backfill füllt
 * den Bestand nach.
 *
 * Mapping OHNE Raten: die gespiegelte Ledger-Zeile trägt den `captureKey` als
 * `idempotency_key` (Format `capture:a{appt}:o{occ}:{budgetType}:l{legacyTxId}`),
 * wobei `legacyTxId` exakt die `id` der Konsum-Zeile in `budget_transactions`
 * ist. Wir parsen das `:l{n}`-Suffix, prüfen, dass eine passende
 * `budget_transactions`-Zeile mit gleichem Kunden UND Topf existiert, und setzen
 * dann `captured_transaction_id`. Nur deterministisch eindeutige Treffer werden
 * geschrieben.
 *
 * `budget_reservations` ist NICHT durch die GoBD-Immutability-Trigger geschützt
 * (die liegen auf `budget_ledger`/`budget_transactions`-Nachbarn) — kein Bypass
 * nötig.
 *
 * Vollständig idempotent: gefüllte Zeilen (`captured_transaction_id IS NOT NULL`)
 * werden nicht erneut angefasst. Bei `dryRun = true` (oder Env
 * `BACKFILL_RESERVATION_CAPTURED_TX_DRY_RUN=1`) wird nur gezählt/geloggt.
 *
 * WICHTIG (Gate A→B): nicht mappbare Zeilen werden NICHT heuristisch repariert,
 * sondern als Report ausgegeben. Triage/Freigabe erfolgt durch Alrik.
 */
export async function backfillReservationCapturedTransactionId(
  dryRun = process.env.BACKFILL_RESERVATION_CAPTURED_TX_DRY_RUN === "1",
): Promise<void> {
  // Offene Kandidaten: captured, mit Ledger-Link, aber noch ohne Tx-Link.
  const [{ open }] = (
    await db.execute(sql`
      SELECT COUNT(*)::int AS "open"
      FROM budget_reservations
      WHERE state = 'captured'
        AND captured_ledger_id IS NOT NULL
        AND captured_transaction_id IS NULL
    `)
  ).rows as Array<{ open: number }>;

  if (open === 0) return;

  let mappedCount = 0;
  if (!dryRun) {
    const mapped = await db.execute(sql`
      UPDATE budget_reservations r
      SET captured_transaction_id = bt.id
      FROM budget_ledger l
      JOIN budget_transactions bt
        ON bt.id = (substring(l.idempotency_key FROM ':l([0-9]+)$'))::int
      WHERE r.captured_ledger_id = l.id
        AND r.state = 'captured'
        AND r.captured_transaction_id IS NULL
        AND l.idempotency_key ~ ':l[0-9]+$'
        AND bt.customer_id = r.customer_id
        AND bt.budget_type = r.budget_type
      RETURNING r.id
    `);
    mappedCount = mapped.rowCount ?? mapped.rows.length;
  } else {
    // Trockenlauf: zähle, wie viele Zeilen der Update getroffen HÄTTE.
    const [{ mappable }] = (
      await db.execute(sql`
        SELECT COUNT(*)::int AS "mappable"
        FROM budget_reservations r
        JOIN budget_ledger l ON r.captured_ledger_id = l.id
        JOIN budget_transactions bt
          ON bt.id = (substring(l.idempotency_key FROM ':l([0-9]+)$'))::int
        WHERE r.state = 'captured'
          AND r.captured_transaction_id IS NULL
          AND l.idempotency_key ~ ':l[0-9]+$'
          AND bt.customer_id = r.customer_id
          AND bt.budget_type = r.budget_type
      `)
    ).rows as Array<{ mappable: number }>;
    mappedCount = mappable;
  }

  // Nicht mappbare Reststellen NACH dem Lauf (im Trockenlauf: was übrig bliebe).
  const unmappable = (
    await db.execute(sql`
      SELECT
        r.id AS "reservationId",
        r.customer_id AS "customerId",
        r.budget_type AS "budgetType",
        r.captured_ledger_id AS "capturedLedgerId",
        l.idempotency_key AS "idempotencyKey"
      FROM budget_reservations r
      LEFT JOIN budget_ledger l ON r.captured_ledger_id = l.id
      WHERE r.state = 'captured'
        AND r.captured_ledger_id IS NOT NULL
        AND r.captured_transaction_id IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM budget_ledger l2
          JOIN budget_transactions bt
            ON bt.id = (substring(l2.idempotency_key FROM ':l([0-9]+)$'))::int
          WHERE l2.id = r.captured_ledger_id
            AND l2.idempotency_key ~ ':l[0-9]+$'
            AND bt.customer_id = r.customer_id
            AND bt.budget_type = r.budget_type
        )
      ORDER BY r.id
    `)
  ).rows as Array<{
    reservationId: number;
    customerId: number;
    budgetType: string;
    capturedLedgerId: number;
    idempotencyKey: string | null;
  }>;

  const prefix = dryRun ? "[DRY-RUN] " : "";
  log(
    `${prefix}Reservation-capturedTransactionId-Backfill (Task #1272): ${open} offene captured-Zeilen, ` +
      `${mappedCount} gemappt, ${unmappable.length} nicht mappbar`,
    "startup",
  );

  if (unmappable.length > 0) {
    log(
      `${prefix}ACHTUNG (Task #1272 Gate A→B): ${unmappable.length} captured Reservierungen NICHT mappbar — ` +
        `Triage durch Alrik nötig, KEINE heuristische Reparatur:`,
      "startup",
    );
    for (const u of unmappable) {
      log(
        `${prefix}  · Reservation #${u.reservationId} (Kunde ${u.customerId}, Topf ${u.budgetType}, ` +
          `capturedLedgerId=${u.capturedLedgerId}, idempotencyKey=${u.idempotencyKey ?? "—"})`,
        "startup",
      );
    }
  }
}
