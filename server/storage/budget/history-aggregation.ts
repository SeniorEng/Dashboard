/**
 * Task #727 — Phase 1.3 BudgetHistoryView: DB-Wrapper um die pure
 * Aggregations-Funktion in `shared/domain/budget/history-aggregation.ts`.
 *
 * Dieser Wrapper ist die EINZIGE Stelle, die Roh-`budget_transactions` für
 * die History-Sicht liest. Frontend und Equality-Tests konsumieren entweder
 * den hier zurückgegebenen Aggregat-Output oder rufen die pure Funktion
 * direkt mit derselben Topologie auf — damit Allocations-Sicht und
 * Fenster-Cap-Sicht in der UI nie selbst neu gerechnet werden.
 */
import { budgetTransactions } from "@shared/schema";
import { and, eq, gte, lte, inArray } from "drizzle-orm";
import { db } from "../../lib/db";
import type { DbClient } from "./types";
import {
  aggregateHistoryByMonth,
  type AggregateHistoryOptions,
  type MonthlyHistoryBucket,
} from "@shared/domain/budget/history-aggregation";

export interface GetMonthlyHistoryOptions extends AggregateHistoryOptions {}

export async function getMonthlyHistory(
  customerId: number,
  opts: GetMonthlyHistoryOptions = {},
  _tx?: DbClient,
): Promise<MonthlyHistoryBucket[]> {
  const d = _tx ?? db;
  const where = [eq(budgetTransactions.customerId, customerId)];
  if (opts.from) where.push(gte(budgetTransactions.transactionDate, opts.from));
  if (opts.to) where.push(lte(budgetTransactions.transactionDate, opts.to));
  if (opts.budgetTypes && opts.budgetTypes.length > 0) {
    where.push(inArray(budgetTransactions.budgetType, [...opts.budgetTypes]));
  }

  const rows = await d
    .select({
      budgetType: budgetTransactions.budgetType,
      transactionDate: budgetTransactions.transactionDate,
      transactionType: budgetTransactions.transactionType,
      amountCents: budgetTransactions.amountCents,
    })
    .from(budgetTransactions)
    .where(and(...where));

  return aggregateHistoryByMonth(rows, opts);
}
