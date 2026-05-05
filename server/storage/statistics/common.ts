import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { fromError } from "zod-validation-error";
import type { HealthScore, HealthThresholds, KpiValue, StatisticsPeriod } from "@shared/statistics";
import { badRequest } from "../../lib/errors";

export const periodQuerySchema = z.object({
  year: z.coerce.number().int().min(2020).max(2100).optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Datum muss im Format YYYY-MM-DD sein").optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Datum muss im Format YYYY-MM-DD sein").optional(),
}).refine((v) => !(v.from && v.to) || v.from <= v.to, {
  message: "Start-Datum muss vor oder gleich End-Datum sein",
  path: ["from"],
});

export type PeriodQueryInput = z.infer<typeof periodQuerySchema>;

export interface ResolvedPeriod {
  year: number;
  month: number | null;
  from: string | null;
  to: string | null;
  prevMonth: number | null;
  prevMonthYear: number | null;
  prevYear: number;
  prevFrom: string | null;
  prevTo: string | null;
}

export function resolvePeriod(input: unknown): ResolvedPeriod {
  const parsed = periodQuerySchema.safeParse(input ?? {});
  if (!parsed.success) {
    const err = fromError(parsed.error).toString();
    throw badRequest(err);
  }
  const data = parsed.data;
  const year = data.year ?? new Date().getFullYear();
  const month = data.month ?? null;
  const from = data.from ?? null;
  const to = data.to ?? null;
  const prevMonth = month ? (month === 1 ? 12 : month - 1) : null;
  const prevMonthYear = month ? (month === 1 ? year - 1 : year) : null;

  let prevFrom: string | null = null;
  let prevTo: string | null = null;
  if (from && to) {
    const fromDate = new Date(from + "T00:00:00Z");
    const toDate = new Date(to + "T00:00:00Z");
    const spanMs = toDate.getTime() - fromDate.getTime();
    const prevToDate = new Date(fromDate.getTime() - 86400000);
    const prevFromDate = new Date(prevToDate.getTime() - spanMs);
    prevFrom = prevFromDate.toISOString().slice(0, 10);
    prevTo = prevToDate.toISOString().slice(0, 10);
  }

  return { year, month, from, to, prevMonth, prevMonthYear, prevYear: year - 1, prevFrom, prevTo };
}

/**
 * Period one step back (prev-month if month set, prev-range if range, else prev-year).
 * Used for "Vormonat" (or short-term) comparison.
 */
export function previousPeriod(p: ResolvedPeriod): ResolvedPeriod {
  if (p.from && p.to && p.prevFrom && p.prevTo) {
    return resolvePeriod({ from: p.prevFrom, to: p.prevTo });
  }
  if (p.month) {
    return resolvePeriod({ year: p.prevMonthYear!, month: p.prevMonth! });
  }
  return resolvePeriod({ year: p.prevYear });
}

/**
 * Same period exactly one year earlier (year-over-year reference).
 */
export function previousYearPeriod(p: ResolvedPeriod): ResolvedPeriod {
  if (p.from && p.to) {
    const shift = (s: string) => `${parseInt(s.slice(0, 4)) - 1}${s.slice(4)}`;
    return resolvePeriod({ from: shift(p.from), to: shift(p.to) });
  }
  if (p.month) {
    return resolvePeriod({ year: p.year - 1, month: p.month });
  }
  return resolvePeriod({ year: p.year - 1 });
}

export function periodToResponse(p: ResolvedPeriod): StatisticsPeriod {
  return { year: p.year, month: p.month, from: p.from, to: p.to };
}

/**
 * Returns SQL fragment that filters a date column according to the period.
 * Always returns ` AND <expr>` (begins with AND).
 */
export function dateFilter(p: ResolvedPeriod, col: SQL): SQL {
  if (p.from && p.to) {
    return sql`AND ${col} >= ${p.from}::date AND ${col} <= ${p.to}::date`;
  }
  if (p.month) {
    return sql`AND EXTRACT(YEAR FROM ${col}) = ${p.year} AND EXTRACT(MONTH FROM ${col}) = ${p.month}`;
  }
  return sql`AND EXTRACT(YEAR FROM ${col}) = ${p.year}`;
}

/**
 * Filter for tables with separate billing_year / billing_month integer columns
 * (e.g. invoices, monthly_service_records).
 */
export function billingPeriodFilter(p: ResolvedPeriod, yearCol: SQL, monthCol: SQL): SQL {
  if (p.from && p.to) {
    // Approximate: filter by year+month covering the date range
    const fromY = parseInt(p.from.slice(0, 4));
    const fromM = parseInt(p.from.slice(5, 7));
    const toY = parseInt(p.to.slice(0, 4));
    const toM = parseInt(p.to.slice(5, 7));
    return sql`AND (${yearCol} * 100 + ${monthCol}) >= ${fromY * 100 + fromM}
               AND (${yearCol} * 100 + ${monthCol}) <= ${toY * 100 + toM}`;
  }
  if (p.month) {
    return sql`AND ${yearCol} = ${p.year} AND ${monthCol} = ${p.month}`;
  }
  return sql`AND ${yearCol} = ${p.year}`;
}

function deltas(current: number, prev: number | null): { abs: number | null; pct: number | null } {
  if (prev == null) return { abs: null, pct: null };
  const abs = current - prev;
  const pct = prev === 0 ? null : Math.round((abs / prev) * 100);
  return { abs, pct };
}

/**
 * Build a KPI with both month-over-month (or short-term) and year-over-year comparisons.
 * Pass `null` for an unavailable comparison.
 */
export function buildKpi(current: number, previous: number | null, previousYear: number | null = null): KpiValue {
  const m = deltas(current, previous);
  const y = deltas(current, previousYear);
  return {
    current,
    previous,
    deltaAbs: m.abs,
    deltaPct: m.pct,
    previousYear,
    deltaYearAbs: y.abs,
    deltaYearPct: y.pct,
  };
}

export function num(v: unknown): number {
  return Number(v ?? 0);
}

/**
 * Configurable thresholds for the process-health "Ampel".
 * Override via env: STATS_HEALTH_YELLOW, STATS_HEALTH_RED.
 */
export function getHealthThresholds(): HealthThresholds {
  return {
    yellow: parseInt(process.env.STATS_HEALTH_YELLOW || "5"),
    red: parseInt(process.env.STATS_HEALTH_RED || "20"),
  };
}

export function scoreFor(total: number, t: HealthThresholds = getHealthThresholds()): HealthScore {
  if (total >= t.red) return "rot";
  if (total >= t.yellow) return "gelb";
  return "gruen";
}
