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
import { and, eq, isNull, sql } from "drizzle-orm";
import type { DbOrTx } from "./db";
import {
  budgetTransactions,
  budgetAllocations,
  budgetLedger,
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

/** (2) Reservation ↔ Ledger Kreuzcheck (in Phase 1 trivially grün). */
async function checkLedgerReservationCrosslinks(
  exec: DbOrTx,
): Promise<{ violations: number; details: string[] }> {
  const details: string[] = [];

  const orphanCaptured = await exec
    .select({
      id: budgetReservations.id,
      capturedLedgerId: budgetReservations.capturedLedgerId,
    })
    .from(budgetReservations)
    .leftJoin(budgetLedger, eq(budgetLedger.id, budgetReservations.capturedLedgerId))
    .where(and(eq(budgetReservations.state, "captured"), isNull(budgetLedger.id)));

  for (const r of orphanCaptured) {
    details.push(
      `Reservation #${r.id} ist 'captured', aber capturedLedgerId=${r.capturedLedgerId ?? "NULL"} zeigt auf keine Ledger-Zeile`,
    );
  }

  const ledgerRows = await exec
    .select({ id: budgetLedger.id, reversesLedgerId: budgetLedger.reversesLedgerId })
    .from(budgetLedger);
  const ledgerIds = new Set(ledgerRows.map((r) => r.id));
  for (const r of ledgerRows) {
    if (r.reversesLedgerId !== null && !ledgerIds.has(r.reversesLedgerId)) {
      details.push(`Ledger-Storno #${r.id} verweist auf nicht existierende Ledger-Zeile ${r.reversesLedgerId}`);
    }
  }

  return { violations: details.length, details };
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
    total: potViolationKeys.length + cross.violations,
  };
}
