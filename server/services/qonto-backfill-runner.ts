/**
 * Task #1591 / #1717 — Geteilter Lauf-Lock + Runner für den Qonto-Voll-Sync
 * (Backfill).
 *
 * Der teure Voll-Abzug darf immer nur EINMAL gleichzeitig laufen. Ein
 * session-scoped `pg_try_advisory_lock` auf einer dedizierten Pool-Verbindung
 * serialisiert instanzübergreifend. Wird der Lock nicht sofort gewährt, läuft
 * bereits ein Voll-Sync.
 *
 * Diese Datei ist die EINZIGE Stelle, die den Lock-Schlüssel definiert und den
 * Lock hält — sowohl der manuelle Backfill (`server/routes/admin/qonto.ts`) als
 * auch der automatische Backfill neuer IBANs (`server/routes/company.ts`) laufen
 * darüber, damit sie sich denselben Lock teilen und nicht kollidieren.
 */

import { pool } from "../lib/db";
import { withAudit } from "../lib/with-audit";
import { qontoService } from "./qonto";
import { MAX_BACKFILL_LOOKBACK_MONTHS } from "@shared/domain/qonto/backfill-windows";

// Fester 32-bit-Schlüssel "QBKF" (Qonto BacKFill).
export const QONTO_BACKFILL_LOCK_KEY = String(0x51424b46);

// pg_try_advisory_lock(bigint) legt den Lock in pg_locks als classid = obere
// 32 Bit, objid = untere 32 Bit ab (objsubid = 1). Der Schlüssel passt in 32
// Bit → classid = 0, objid = Schlüssel. Bewusst ohne BigInt-Literale (tsc-Target).
export const QONTO_BACKFILL_LOCK_CLASSID = Math.floor(
  Number(QONTO_BACKFILL_LOCK_KEY) / 0x100000000,
);
export const QONTO_BACKFILL_LOCK_OBJID = Number(QONTO_BACKFILL_LOCK_KEY) % 0x100000000;

/**
 * Führt `fn` aus, solange der Backfill-Lock frei erworben werden konnte. Wird
 * der Lock bereits von einer anderen Sitzung gehalten, wird `fn` NICHT
 * ausgeführt und `{ ran: false }` zurückgegeben (der Aufrufer entscheidet, ob
 * das ein 409-Fehler oder ein stilles Überspringen ist).
 */
export async function withQontoBackfillLock<T>(
  fn: () => Promise<T>,
): Promise<{ ran: true; result: T } | { ran: false }> {
  const lockClient = await pool.connect();
  let gotLock = false;
  try {
    const lockRes = await lockClient.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [QONTO_BACKFILL_LOCK_KEY],
    );
    gotLock = lockRes.rows?.[0]?.locked === true;
    if (!gotLock) return { ran: false };
    const result = await fn();
    return { ran: true, result };
  } finally {
    try {
      if (gotLock) {
        await lockClient.query("SELECT pg_advisory_unlock($1)", [QONTO_BACKFILL_LOCK_KEY]);
      }
    } finally {
      lockClient.release();
    }
  }
}

/**
 * Prüft (ohne den Lock selbst zu erwerben) via pg_locks, ob der Backfill-Lock
 * aktuell von irgendeiner Sitzung gehalten wird. Damit kann das Frontend
 * proaktiv „Voll-Sync läuft…" anzeigen.
 */
export async function isQontoBackfillRunning(): Promise<boolean> {
  const lockRes = await pool.query<{ running: boolean }>(
    `SELECT COUNT(*) > 0 AS running
       FROM pg_locks
      WHERE locktype = 'advisory'
        AND classid = $1
        AND objid = $2
        AND objsubid = 1`,
    [QONTO_BACKFILL_LOCK_CLASSID, QONTO_BACKFILL_LOCK_OBJID],
  );
  return lockRes.rows?.[0]?.running === true;
}

/**
 * Task #1717 — Stößt (im Hintergrund) einen fokussierten Backfill für die neu
 * hinzugekommenen überwachten IBANs an. Ersetzt den früher manuell zu
 * klickenden „Nach IBAN-Anlage bitte Voll-Sync"-Schritt: baut KEINEN zweiten
 * Sync-Pfad, sondern ruft die bestehende `backfillTransactions`-Mechanik
 * (fokussiert auf die neuen Konten) unter demselben Advisory-Lock auf.
 *
 * - Startdatum: sicherer Default innerhalb der Lookback-Obergrenze
 *   (`MAX_BACKFILL_LOOKBACK_MONTHS` Monate zurück) — deckt Alt-Eingänge ab, ohne
 *   die harte Rückreichweiten-Grenze zu überschreiten.
 * - Nicht-blockierend gedacht (Aufrufer startet ohne `await` und fängt Fehler).
 * - Läuft bereits ein Voll-Sync, wird der Auto-Backfill still übersprungen
 *   (der laufende Lauf erfasst die neuen Konten ohnehin mit).
 * - GoBD-auditiert über die bestehende `qonto_backfill_executed`-Aktion.
 */
export async function autoBackfillNewIbans(
  ibans: string[],
  userId: number,
  ipAddress?: string,
): Promise<void> {
  if (ibans.length === 0) return;

  const start = new Date();
  start.setMonth(start.getMonth() - MAX_BACKFILL_LOOKBACK_MONTHS);
  const startDate = start.toISOString().slice(0, 10);

  const outcome = await withQontoBackfillLock(async () => {
    const result = await qontoService.backfillTransactions(start, { ibans });
    await withAudit(async (_dbTx, audit) => {
      audit.record({
        userId,
        action: "qonto_backfill_executed",
        entityType: "qonto_transaction",
        entityId: 0,
        metadata: {
          trigger: "auto_new_iban",
          ibans,
          startDate,
          synced: result.synced,
          total: result.total,
          accounts: result.accounts,
          autoHidden: result.autoHidden,
        },
        ipAddress,
      });
    });
    return result;
  });

  if (!outcome.ran) {
    console.warn(
      "[qonto] Auto-Backfill für neue IBAN übersprungen: Es läuft bereits ein Voll-Sync (Lock gehalten). Die neuen Konten werden vom laufenden Lauf erfasst.",
    );
  }
}
