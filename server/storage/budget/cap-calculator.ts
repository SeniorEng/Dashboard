import { budgetTransactions } from "@shared/schema";
import { eq, and, sql, lte, gte } from "drizzle-orm";
import { parseLocalDate } from "@shared/utils/datetime";
import { db } from "../../lib/db";
import type { DbClient } from "./types";
import { getTotalCarryoverCents } from "./summary-queries";

type MonthlyBudgetType = "entlastungsbetrag_45b" | "umwandlung_45a";
type YearlyBudgetType = "ersatzpflege_39_42a";
export type CappedBudgetType = MonthlyBudgetType | YearlyBudgetType;

interface DateRange {
  fromDate: string;
  toDate: string;
}

function getMonthRange(date: string): DateRange {
  const d = parseLocalDate(date);
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const lastDay = new Date(y, m, 0).getDate();
  const mm = String(m).padStart(2, "0");
  return {
    fromDate: `${y}-${mm}-01`,
    toDate: `${y}-${mm}-${String(lastDay).padStart(2, "0")}`,
  };
}

function getYearRange(date: string): DateRange {
  const d = parseLocalDate(date);
  const y = d.getFullYear();
  return { fromDate: `${y}-01-01`, toDate: `${y}-12-31` };
}

/**
 * Net "used" inside a date window, mirroring the cap accounting used by
 * `createCascadeConsumption`:
 *   netUsed = SUM(consumption[txDate ∈ range]) - SUM(reversal[txDate ∈ range])
 *
 * Important: `write_off` is intentionally NOT counted here. The cap controls
 * how much new consumption a single window can absorb, and write-offs are
 * pot-level corrections, not window consumption.
 */
async function netConsumedInRange(
  customerId: number,
  budgetType: string,
  range: DateRange,
  tx?: DbClient,
): Promise<number> {
  const d = tx ?? db;
  const [consumed, reversed] = await Promise.all([
    d.select({
      total: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})), 0)`,
    }).from(budgetTransactions).where(and(
      eq(budgetTransactions.customerId, customerId),
      eq(budgetTransactions.budgetType, budgetType),
      eq(budgetTransactions.transactionType, "consumption"),
      gte(budgetTransactions.transactionDate, range.fromDate),
      lte(budgetTransactions.transactionDate, range.toDate),
    )),
    d.select({
      total: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})), 0)`,
    }).from(budgetTransactions).where(and(
      eq(budgetTransactions.customerId, customerId),
      eq(budgetTransactions.budgetType, budgetType),
      eq(budgetTransactions.transactionType, "reversal"),
      gte(budgetTransactions.transactionDate, range.fromDate),
      lte(budgetTransactions.transactionDate, range.toDate),
    )),
  ]);
  return Math.max(0, Number(consumed[0]?.total ?? 0) - Number(reversed[0]?.total ?? 0));
}

interface CapInputs {
  customerId: number;
  budgetType: CappedBudgetType;
  transactionDate: string;
  monthlyLimitCents: number | null;
  yearlyLimitCents: number | null;
}

interface CapResult {
  /** Date window relevant for this pot (month for §45b/§45a, year for §39/§42a). */
  range: DateRange;
  /** Net used inside the window (consumption - reversal, no write_off). */
  netUsedInWindowCents: number;
  /** For §45b: total carryover available at `transactionDate`. 0 otherwise. */
  carryoverCents: number;
  /**
   * Cap-based remaining cents. `Number.POSITIVE_INFINITY` when no cap applies
   * (i.e. no monthly/yearly limit configured for this pot).
   */
  capRemainingCents: number;
}

/**
 * Single source of truth for the per-pot cap computation shared by:
 *   - `createCascadeConsumption` (actual booking)
 *   - `getAvailableForDate`     (import preview)
 *
 * Both pathways MUST call this helper so the preview and the booking can
 * never drift apart silently.
 */
export async function computeCapSlot(
  input: CapInputs,
  tx?: DbClient,
): Promise<CapResult> {
  const isYearly = input.budgetType === "ersatzpflege_39_42a";
  const range = isYearly ? getYearRange(input.transactionDate) : getMonthRange(input.transactionDate);
  const netUsedInWindowCents = await netConsumedInRange(
    input.customerId,
    input.budgetType,
    range,
    tx,
  );

  let carryoverCents = 0;
  if (input.budgetType === "entlastungsbetrag_45b") {
    carryoverCents = await getTotalCarryoverCents(
      input.customerId,
      input.transactionDate,
      tx,
    );
  }

  let capRemainingCents = Number.POSITIVE_INFINITY;
  if (isYearly) {
    if (input.yearlyLimitCents !== null) {
      capRemainingCents = Math.max(0, input.yearlyLimitCents - netUsedInWindowCents);
    }
  } else {
    if (input.monthlyLimitCents !== null) {
      const effectiveLimit = input.monthlyLimitCents + carryoverCents;
      capRemainingCents = Math.max(0, effectiveLimit - netUsedInWindowCents);
    }
  }

  return { range, netUsedInWindowCents, carryoverCents, capRemainingCents };
}
