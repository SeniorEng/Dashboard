/**
 * Task #895 — Wiederverwendbarer Conservation-Verifier (Invariante I13) für die
 * Budget-Domäne.
 *
 * Dieser Modul kapselt die read-only Erhaltungs-Checks, die im Drei-Tabellen-
 * Modell IMMER gelten müssen. Er wird an zwei Stellen genutzt:
 *
 *  1. `server/scripts/verify-budget-conservation.ts` — CLI-Report (prod-runnable).
 *  2. `server/startup/budget-migration-runner.ts` — Pre-/Post-Check als Guard
 *     um jede budgetdaten-mutierende Migration (Rollback bei NEU eingeführter
 *     Verletzung).
 *
 * Die Checks ÄNDERN NICHTS (nur SELECT). Sie akzeptieren einen `DbOrTx`, sodass
 * der Post-Check innerhalb derselben (noch nicht committeten) Migrations-
 * Transaktion gegen den mutierten — aber noch nicht persistierten — Zustand
 * laufen kann.
 *
 * WICHTIG: I13 wird als NICHT-Überziehung geprüft, NICHT als strikte Gleichheit
 * `Allocated − Consumed == Available`. Wo statutarische Caps (§45a/§39+§42a)
 * binden, ist die nutzbare Verfügbarkeit kleiner als Allocated − Consumed; eine
 * strikte Gleichheit würde dort fälschlich anschlagen. Die Erhaltung, die immer
 * hält, ist „kein Topf wird über seine Allocation hinaus konsumiert".
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { DbOrTx } from "./db";
import {
  budgetTransactions,
  budgetAllocations,
  budgetReservations,
} from "@shared/schema";

/** Der Selbstzahler-Overflow-Topf hat per Design KEINE Allocation — er
 *  absorbiert den Cascade-Rest (uncapped). Für die No-Overdraw-Invariante ist
 *  er irrelevant. */
export const UNCAPPED_POTS = new Set(["private", "selbstzahler"]);

export interface PotConservationRow {
  customerId: number;
  budgetType: string;
  allocatedCents: number;
  netConsumedCents: number;
  availableCents: number;
  overdrawn: boolean;
}

export interface ConservationResult {
  /** Geprüfte (Kunde,Topf)-Paare (uncapped ausgenommen). */
  checkedPairs: number;
  /** Detailzeilen aller geprüften Paare (auch nicht-verletzte). */
  potRows: PotConservationRow[];
  /** `${customerId}|${budgetType}` aller überzogenen Töpfe. */
  potViolationKeys: string[];
  /** Ledger/Reservation-Kreuzcheck-Verletzungen (Phase 2+). */
  crossViolations: number;
  /** Menschenlesbare Detailmeldungen der Kreuzcheck-Verletzungen. */
  crossDetails: string[];
  /**
   * Task #1273 (Stufe B) — Link-Divergenzen: captured Reservierungen, deren
   * `captured_transaction_id` zwar gesetzt ist, aber auf keine existierende
   * `budget_transactions`-Zeile zeigt ODER auf eine Zeile mit abweichendem
   * Kunden/Topf. `budget_ledger` wird ab Stufe B NICHT mehr konsultiert (der
   * Dual-Link ist auf den einen `captured_transaction_id`-Link reduziert).
   * Teilmenge von `crossViolations` (die Detailzeilen stecken in `crossDetails`).
   * Reservierungen mit leerem `captured_transaction_id` (Bestand vor Stage-A-
   * Backfill) sind KEINE Divergenz. Divergenz > 0 ⇒ STOPPEN + Report.
   */
  linkDivergences: number;
  /** Summe potViolationKeys.length + crossViolations. */
  total: number;
}

/** (1) Kein Topf überzogen: NettoKonsum ≤ Σ Allocated je (Kunde, Topf). */
async function computePotConservation(exec: DbOrTx): Promise<PotConservationRow[]> {
  const consumedRows = await exec
    .select({
      customerId: budgetTransactions.customerId,
      budgetType: budgetTransactions.budgetType,
      consumed: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})) FILTER (WHERE ${budgetTransactions.transactionType} IN ('consumption','write_off')), 0)`,
      reversed: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})) FILTER (WHERE ${budgetTransactions.transactionType} = 'reversal'), 0)`,
    })
    .from(budgetTransactions)
    .groupBy(budgetTransactions.customerId, budgetTransactions.budgetType);

  const allocatedRows = await exec
    .select({
      customerId: budgetAllocations.customerId,
      budgetType: budgetAllocations.budgetType,
      allocated: sql<number>`COALESCE(SUM(${budgetAllocations.amountCents}), 0)`,
    })
    .from(budgetAllocations)
    .where(isNull(budgetAllocations.deletedAt))
    .groupBy(budgetAllocations.customerId, budgetAllocations.budgetType);

  const allocatedMap = new Map<string, number>();
  for (const r of allocatedRows) {
    allocatedMap.set(`${r.customerId}|${r.budgetType}`, Number(r.allocated));
  }

  const rows: PotConservationRow[] = [];
  for (const r of consumedRows) {
    if (UNCAPPED_POTS.has(r.budgetType)) continue;
    const allocated = allocatedMap.get(`${r.customerId}|${r.budgetType}`) ?? 0;
    const netConsumed = Math.max(0, Number(r.consumed) - Number(r.reversed));
    rows.push({
      customerId: r.customerId,
      budgetType: r.budgetType,
      allocatedCents: allocated,
      netConsumedCents: netConsumed,
      availableCents: allocated - netConsumed,
      overdrawn: netConsumed > allocated,
    });
  }
  return rows;
}

/**
 * (2) Reservation ↔ Transaction Kreuzcheck (Stufe B, Task #1273).
 *
 * Ab Stufe B ist `budget_transactions` die eine append-only Finanz-Schicht und
 * `captured_transaction_id` der EINE Capture-Link. `budget_ledger` wird NICHT
 * mehr konsultiert. Geprüft werden dieselben fachlichen Aussagen wie vorher auf
 * der neuen Quelle:
 *  - Orphan-Capture: captured Reservierung, deren gesetzter
 *    `captured_transaction_id` auf keine `budget_transactions`-Zeile zeigt.
 *  - Link-Divergenz: captured Reservierung, deren referenzierte Transaktion
 *    einen anderen Kunden/Topf trägt (Betrag NICHT verglichen — die Reservierung
 *    hält den Hold-/Ist-Betrag, die Konsum-Zeile das negative Pendant).
 *  - Reversal-Ketten-Integrität: jede `reversal`-Zeile muss auf eine existierende
 *    `budget_transactions`-Zeile (`reversed_transaction_id`) verweisen.
 * Reservierungen mit leerem `captured_transaction_id` (Legacy) sind KEINE
 * Verletzung.
 */
async function checkLedgerReservationCrosslinks(
  exec: DbOrTx,
): Promise<{ violations: number; details: string[]; divergences: number }> {
  const details: string[] = [];
  let divergences = 0;

  const captured = await exec
    .select({
      reservationId: budgetReservations.id,
      customerId: budgetReservations.customerId,
      budgetType: budgetReservations.budgetType,
      capturedTransactionId: budgetReservations.capturedTransactionId,
      txCustomerId: budgetTransactions.customerId,
      txBudgetType: budgetTransactions.budgetType,
    })
    .from(budgetReservations)
    .leftJoin(
      budgetTransactions,
      eq(budgetTransactions.id, budgetReservations.capturedTransactionId),
    )
    .where(
      and(
        eq(budgetReservations.state, "captured"),
        sql`${budgetReservations.capturedTransactionId} IS NOT NULL`,
      ),
    );

  for (const r of captured) {
    if (r.txCustomerId === null && r.txBudgetType === null) {
      // Orphan-Capture: capturedTransactionId zeigt ins Leere.
      divergences++;
      details.push(
        `Reservation #${r.reservationId} ist 'captured', aber capturedTransactionId=${r.capturedTransactionId ?? "NULL"} zeigt auf keine budget_transactions-Zeile`,
      );
      continue;
    }
    const mismatches: string[] = [];
    if (r.txCustomerId !== r.customerId) {
      mismatches.push(`Kunde ${r.customerId}≠${r.txCustomerId ?? "NULL"}`);
    }
    if (r.txBudgetType !== r.budgetType) {
      mismatches.push(`Topf ${r.budgetType}≠${r.txBudgetType ?? "NULL"}`);
    }
    if (mismatches.length > 0) {
      divergences++;
      details.push(
        `Reservation #${r.reservationId}: Link-Divergenz (Transaktion #${r.capturedTransactionId}) — ${mismatches.join(", ")}`,
      );
    }
  }

  // Reversal-Ketten-Integrität auf budget_transactions (umgezogen von
  // budget_ledger): jede reversal-Zeile muss eine existierende Originalzeile
  // referenzieren.
  const reversalRows = await exec
    .select({
      id: budgetTransactions.id,
      reversedTransactionId: budgetTransactions.reversedTransactionId,
    })
    .from(budgetTransactions)
    .where(eq(budgetTransactions.transactionType, "reversal"));

  const refIds = Array.from(
    new Set(
      reversalRows
        .map((r) => r.reversedTransactionId)
        .filter((id): id is number => id !== null),
    ),
  );
  if (refIds.length > 0) {
    const existing = new Set(
      (
        await exec
          .select({ id: budgetTransactions.id })
          .from(budgetTransactions)
          .where(inArray(budgetTransactions.id, refIds))
      ).map((r) => r.id),
    );
    for (const r of reversalRows) {
      if (r.reversedTransactionId !== null && !existing.has(r.reversedTransactionId)) {
        details.push(
          `Storno #${r.id} verweist auf nicht existierende Transaktion ${r.reversedTransactionId}`,
        );
      }
    }
  }

  return { violations: details.length, details, divergences };
}

/**
 * Read-only Conservation-Check gegen den übergebenen Executor (DB oder offene
 * Transaktion). Wirft NICHT — gibt das strukturierte Ergebnis zurück, damit
 * Aufrufer (CLI vs. Migrations-Guard) selbst über die Reaktion entscheiden.
 */
export async function checkBudgetConservation(exec: DbOrTx): Promise<ConservationResult> {
  const potRows = await computePotConservation(exec);
  const cross = await checkLedgerReservationCrosslinks(exec);

  const potViolationKeys = potRows
    .filter((r) => r.overdrawn)
    .map((r) => `${r.customerId}|${r.budgetType}`);

  return {
    checkedPairs: potRows.length,
    potRows,
    potViolationKeys,
    crossViolations: cross.violations,
    crossDetails: cross.details,
    linkDivergences: cross.divergences,
    total: potViolationKeys.length + cross.violations,
  };
}
