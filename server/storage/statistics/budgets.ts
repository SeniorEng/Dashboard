import { sql } from "drizzle-orm";
import { db } from "../../lib/db";
import { BUDGET_TYPES } from "@shared/domain/budgets";
import type { BudgetStatsResponse, BudgetPotRow, HealthScore } from "@shared/statistics";
import { buildKpi, num, periodToResponse, type ResolvedPeriod } from "./common";

function classifyStatus(forecastPct: number, expectedProRataPct: number): HealthScore {
  if (forecastPct > 100) return "rot";
  if (forecastPct < 70 && expectedProRataPct > 50) return "gelb";
  return "gruen";
}

async function aggregateForYear(year: number): Promise<{ allocated: number; used: number }> {
  const r = await db.execute(sql`
    SELECT
      COALESCE((SELECT SUM(amount_cents)::bigint FROM budget_allocations
        WHERE year = ${year} AND deleted_at IS NULL), 0) AS allocated,
      COALESCE((SELECT ABS(SUM(amount_cents))::bigint FROM budget_transactions
        WHERE transaction_type = 'consumption'
          AND EXTRACT(YEAR FROM transaction_date::date) = ${year}), 0) AS used
  `);
  const row = r.rows[0] as Record<string, unknown>;
  return { allocated: num(row.allocated), used: num(row.used) };
}

export async function getBudgetStats(period: ResolvedPeriod): Promise<BudgetStatsResponse> {
  const { year } = period;
  const now = new Date();
  const isCurrentYear = year === now.getFullYear();
  const monthsElapsed = isCurrentYear ? now.getMonth() + 1 : 12;

  const [result, curAgg, prevAgg, prevYAgg] = await Promise.all([
    db.execute(sql`
      WITH alloc AS (
        SELECT ba.customer_id, ba.budget_type, SUM(ba.amount_cents)::bigint AS yearly_alloc
        FROM budget_allocations ba
        WHERE ba.year = ${year} AND ba.deleted_at IS NULL
        GROUP BY ba.customer_id, ba.budget_type
      ),
      used AS (
        SELECT bt.customer_id, bt.budget_type, ABS(SUM(bt.amount_cents))::bigint AS used_cents
        FROM budget_transactions bt
        WHERE bt.transaction_type = 'consumption'
          AND EXTRACT(YEAR FROM bt.transaction_date::date) = ${year}
        GROUP BY bt.customer_id, bt.budget_type
      )
      SELECT c.id AS customer_id,
        COALESCE(NULLIF(TRIM(CONCAT_WS(' ', c.vorname, c.nachname)), ''), c.name) AS customer_name,
        a.budget_type,
        COALESCE(a.yearly_alloc, 0)::bigint AS yearly_alloc,
        COALESCE(u.used_cents, 0)::bigint AS used_cents
      FROM customers c
      JOIN alloc a ON a.customer_id = c.id
      LEFT JOIN used u ON u.customer_id = c.id AND u.budget_type = a.budget_type
      WHERE c.deleted_at IS NULL AND c.status = 'aktiv' AND COALESCE(a.yearly_alloc, 0) > 0
      ORDER BY c.id, a.budget_type
    `),
    aggregateForYear(year),
    aggregateForYear(year - 1),
    aggregateForYear(year - 2),
  ]);

  const rows: BudgetPotRow[] = result.rows.map((r: Record<string, unknown>) => {
    const yearly = num(r.yearly_alloc);
    const used = num(r.used_cents);
    const expectedProRata = monthsElapsed > 0 ? Math.round((monthsElapsed / 12) * 100) : 0;
    const monthlyRate = monthsElapsed > 0 ? used / monthsElapsed : 0;
    const forecastYearEnd = Math.round(monthlyRate * 12);
    const forecastPct = yearly > 0 ? Math.round((forecastYearEnd / yearly) * 100) : 0;
    return {
      customerId: num(r.customer_id),
      customerName: String(r.customer_name ?? "Unbekannt"),
      budgetType: String(r.budget_type ?? ""),
      yearlyBudgetCents: yearly,
      usedCents: used,
      expectedProRataPct: expectedProRata,
      forecastYearEndCents: forecastYearEnd,
      forecastPct,
      status: classifyStatus(forecastPct, expectedProRata),
    };
  });

  const aggregateByStatus = (BUDGET_TYPES as readonly string[]).map((bt) => {
    const matching = rows.filter((r) => r.budgetType === bt);
    return {
      budgetType: bt,
      gruen: matching.filter((r) => r.status === "gruen").length,
      gelb: matching.filter((r) => r.status === "gelb").length,
      rot: matching.filter((r) => r.status === "rot").length,
    };
  });

  return {
    period: periodToResponse(period),
    rows,
    aggregateByStatus,
    totalUsedCents: buildKpi(curAgg.used, prevAgg.used, prevYAgg.used),
    totalAllocatedCents: buildKpi(curAgg.allocated, prevAgg.allocated, prevYAgg.allocated),
  };
}
