/**
 * Task #727 — Phase 1.3 BudgetHistoryView: pure Monats-Aggregation über
 * `budget_transactions`.
 *
 * Diese Datei enthält die REINE Berechnung, keine DB-Zugriffe. Der
 * Server-Wrapper `server/storage/budget/history-aggregation.ts` materialisiert
 * die Rohzeilen aus der DB und delegiert die Aggregation an
 * `aggregateHistoryByMonth`. Equality-Test
 * `tests/equality/budget-history-vs-overview.test.ts` vergleicht die
 * Aggregat-Summen 1:1 gegen `getBudgetSummary.totalUsedCents` aus
 * `BudgetOverviewView`.
 *
 * Querschnitts-Auflage A (pure / no state) ist damit erfüllt.
 *
 * `write_off`-Asymmetrie (siehe `docs/budget-ssot-inventory.md` §1.4):
 *  - `netUsedAllocationCents` = `consumption + write_off + manual_adjustment
 *    − reversal`. Das ist die **Topf-/Allocation-Sicht**: Geld, das aus dem
 *    Pot raus ist. Dieselbe Formel verwendet `getBudgetSummary` (§45b) und
 *    `getAvailableCarryoverCents`.
 *  - `netUsedWindowCents` = `consumption − reversal`. Das ist die
 *    **Fenster-Cap-Sicht** (Monat-Cap §45a, Jahr-Cap §39/§42a). Dieselbe
 *    Formel verwendet `computeCapSlot` / `netConsumedInRange`.
 *
 * Beide Werte werden pro Monatsbucket exponiert, damit eine UI/Equality
 * sich aktiv für eine Sicht entscheidet — und nicht später eine dritte
 * Variante nebenher entsteht (genau das war der Drift-Vektor aus
 * Task #720).
 */

export type HistoryTransactionType =
  | "consumption"
  | "write_off"
  | "reversal"
  | "manual_adjustment"
  | string;

export interface HistoryTxInput {
  budgetType: string;
  /** ISO `YYYY-MM-DD`. Bucket-Key ist `YYYY-MM`. */
  transactionDate: string;
  transactionType: HistoryTransactionType;
  amountCents: number;
}

export interface MonthlyHistoryBucket {
  /** `YYYY-MM`. */
  month: string;
  budgetType: string;
  consumptionCents: number;
  writeOffCents: number;
  reversalCents: number;
  manualAdjustmentCents: number;
  /**
   * Topf-/Allocation-Sicht: `consumption + write_off + manual_adjustment
   * − reversal`. Spiegelt `getBudgetSummary.totalUsedCents`.
   */
  netUsedAllocationCents: number;
  /**
   * Fenster-Cap-Sicht: `consumption − reversal` (OHNE write_off,
   * OHNE manual_adjustment). Spiegelt `computeCapSlot.netUsedInWindowCents`.
   */
  netUsedWindowCents: number;
}

export interface AggregateHistoryOptions {
  /** Inklusiv, ISO `YYYY-MM-DD`. */
  from?: string;
  /** Inklusiv, ISO `YYYY-MM-DD`. */
  to?: string;
  budgetTypes?: readonly string[];
}

export function aggregateHistoryByMonth(
  txs: readonly HistoryTxInput[],
  opts: AggregateHistoryOptions = {},
): MonthlyHistoryBucket[] {
  const allowedTypes = opts.budgetTypes ? new Set(opts.budgetTypes) : null;
  const buckets = new Map<string, MonthlyHistoryBucket>();

  for (const tx of txs) {
    if (opts.from && tx.transactionDate < opts.from) continue;
    if (opts.to && tx.transactionDate > opts.to) continue;
    if (allowedTypes && !allowedTypes.has(tx.budgetType)) continue;
    if (tx.transactionDate.length < 7) continue;

    const month = tx.transactionDate.slice(0, 7);
    const key = `${month}::${tx.budgetType}`;
    let b = buckets.get(key);
    if (!b) {
      b = {
        month,
        budgetType: tx.budgetType,
        consumptionCents: 0,
        writeOffCents: 0,
        reversalCents: 0,
        manualAdjustmentCents: 0,
        netUsedAllocationCents: 0,
        netUsedWindowCents: 0,
      };
      buckets.set(key, b);
    }

    const abs = Math.abs(tx.amountCents);
    switch (tx.transactionType) {
      case "consumption":
        b.consumptionCents += abs;
        break;
      case "write_off":
        b.writeOffCents += abs;
        break;
      case "reversal":
        b.reversalCents += abs;
        break;
      case "manual_adjustment":
        b.manualAdjustmentCents += abs;
        break;
      default:
        // Unbekannte Typen werden ignoriert — das verhindert, dass künftige
        // Buchungstypen still in die Allocation-Sicht einsickern, ohne dass
        // der Architecture-Test sich aktiv für eine Sicht entscheidet.
        break;
    }
  }

  for (const b of buckets.values()) {
    b.netUsedAllocationCents =
      b.consumptionCents +
      b.writeOffCents +
      b.manualAdjustmentCents -
      b.reversalCents;
    b.netUsedWindowCents = b.consumptionCents - b.reversalCents;
  }

  return [...buckets.values()].sort((a, b) => {
    if (a.month !== b.month) return a.month.localeCompare(b.month);
    return a.budgetType.localeCompare(b.budgetType);
  });
}

/**
 * Convenience-Reducer für „Summe einer Sicht über alle Monate".
 * Wird vom Equality-Test (`budget-history-vs-overview.test.ts`)
 * verwendet, um gegen `getBudgetSummary.totalUsedCents` zu vergleichen.
 */
export function sumAllocationView(
  buckets: readonly MonthlyHistoryBucket[],
  budgetType: string,
): number {
  return buckets
    .filter((b) => b.budgetType === budgetType)
    .reduce((s, b) => s + b.netUsedAllocationCents, 0);
}
