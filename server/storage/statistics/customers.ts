import { sql } from "drizzle-orm";
import { db } from "../../lib/db";
import type { CustomerStatsResponse } from "@shared/statistics";
import { billingPeriodFilter, buildKpi, dateFilter, num, periodToResponse, previousPeriod, previousYearPeriod, type ResolvedPeriod } from "./common";

async function activeCustomerCount(p: ResolvedPeriod): Promise<number> {
  const dFilter = dateFilter(p, sql`a.date::date`);
  const r = await db.execute(sql`
    SELECT COUNT(DISTINCT a.customer_id)::int AS c
    FROM appointments a
    WHERE a.deleted_at IS NULL AND a.status IN ('completed','documented','scheduled') ${dFilter}
  `);
  return num((r.rows[0] as Record<string, unknown>).c);
}

async function conversionRatePct(p: ResolvedPeriod): Promise<{ pct: number; avgDays: number }> {
  const dFilter = dateFilter(p, sql`a.date::date`);
  const r = await db.execute(sql`
    WITH first_eb AS (
      SELECT a.customer_id, MIN(a.date::date) AS first_eb
      FROM appointments a
      WHERE a.deleted_at IS NULL AND a.appointment_type = 'Erstberatung'
        AND a.status IN ('completed','documented') AND a.customer_id IS NOT NULL
        ${dFilter}
      GROUP BY a.customer_id
    ),
    first_regular AS (
      SELECT a.customer_id, MIN(a.date::date) AS first_reg
      FROM appointments a
      JOIN first_eb fe ON fe.customer_id = a.customer_id
      WHERE a.deleted_at IS NULL AND a.appointment_type != 'Erstberatung'
        AND a.status IN ('completed','documented','scheduled')
        AND a.date::date >= fe.first_eb
        AND a.date::date <= fe.first_eb + INTERVAL '90 days'
      GROUP BY a.customer_id
    )
    SELECT
      (SELECT COUNT(*) FROM first_eb)::int AS eb_count,
      (SELECT COUNT(*) FROM first_regular)::int AS converted_count,
      COALESCE(AVG((fr.first_reg - fe.first_eb))::numeric(10,1), 0) AS avg_days
    FROM first_eb fe LEFT JOIN first_regular fr ON fr.customer_id = fe.customer_id
  `);
  const row = r.rows[0] as Record<string, unknown>;
  const eb = num(row?.eb_count);
  const conv = num(row?.converted_count);
  return { pct: eb > 0 ? Math.round((conv / eb) * 100) : 0, avgDays: num(row?.avg_days) };
}

export async function getCustomerStats(period: ResolvedPeriod): Promise<CustomerStatsResponse> {
  const prev = previousPeriod(period);
  const prevY = previousYearPeriod(period);
  const invFilter = billingPeriodFilter(period, sql`i.billing_year`, sql`i.billing_month`);

  const [funnelRow, monthlyRow, cancellationRow, churnRows, pflegegradRows, plannedRow, topCustomersRows, unusedBudgetRows, curActive, prevActive, yoyActive, curConv, prevConv, yoyConv] = await Promise.all([
    db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE status = 'interessent' AND deleted_at IS NULL)::int AS prospect,
        COUNT(*) FILTER (WHERE status = 'erstberatung' AND deleted_at IS NULL)::int AS in_consultation,
        COUNT(*) FILTER (WHERE status = 'aktiv' AND deleted_at IS NULL)::int AS active,
        COUNT(*) FILTER (WHERE status = 'inaktiv' AND deleted_at IS NULL)::int AS inactive,
        COUNT(*) FILTER (WHERE status = 'gekuendigt' AND deleted_at IS NULL)::int AS terminated
      FROM customers
    `),
    db.execute(sql`
      SELECT m.month::int AS month,
        COALESCE((
          SELECT COUNT(DISTINCT cc.customer_id)::int FROM customer_contracts cc
          JOIN customers c ON c.id = cc.customer_id
          WHERE c.deleted_at IS NULL
            AND EXTRACT(YEAR FROM cc.contract_start::date) = ${period.year}
            AND EXTRACT(MONTH FROM cc.contract_start::date) = m.month
        ), 0) AS gained,
        COALESCE((
          SELECT COUNT(*)::int FROM customers c
          WHERE c.deleted_at IS NULL AND c.inaktiv_ab IS NOT NULL AND c.merged_into_customer_id IS NULL
            AND EXTRACT(YEAR FROM c.inaktiv_ab::date) = ${period.year}
            AND EXTRACT(MONTH FROM c.inaktiv_ab::date) = m.month
        ), 0) AS lost
      FROM generate_series(1, 12) AS m(month) ORDER BY m.month
    `),
    db.execute(sql`
      SELECT m.month::int AS month,
        COALESCE((
          SELECT
            CASE WHEN COUNT(*) FILTER (WHERE a.status IN ('scheduled','cancelled','completed','documented')) > 0
              THEN ROUND(COUNT(*) FILTER (WHERE a.status = 'cancelled')::numeric /
                COUNT(*) FILTER (WHERE a.status IN ('scheduled','cancelled','completed','documented')) * 100)::int
              ELSE 0 END
          FROM appointments a
          WHERE a.deleted_at IS NULL
            AND EXTRACT(YEAR FROM a.date::date) = ${period.year}
            AND EXTRACT(MONTH FROM a.date::date) = m.month
        ), 0) AS rate_pct
      FROM generate_series(1, 12) AS m(month) ORDER BY m.month
    `),
    db.execute(sql`
      WITH last30 AS (
        SELECT a.customer_id, COUNT(*)::int AS cnt FROM appointments a
        WHERE a.deleted_at IS NULL AND a.status IN ('completed','documented','scheduled')
          AND a.date::date >= (CURRENT_DATE - INTERVAL '30 days') AND a.date::date <= CURRENT_DATE
        GROUP BY a.customer_id
      ),
      baseline AS (
        SELECT a.customer_id, ROUND(COUNT(*)::numeric / 3, 1) AS monthly_avg FROM appointments a
        WHERE a.deleted_at IS NULL AND a.status IN ('completed','documented')
          AND a.date::date >= (CURRENT_DATE - INTERVAL '120 days')
          AND a.date::date < (CURRENT_DATE - INTERVAL '30 days')
        GROUP BY a.customer_id
      )
      SELECT c.id, COALESCE(NULLIF(TRIM(CONCAT_WS(' ', c.vorname, c.nachname)), ''), c.name) AS name,
        COALESCE(l.cnt, 0)::int AS appts_last_30,
        COALESCE(b.monthly_avg, 0)::numeric(10,1) AS baseline_monthly,
        CASE WHEN COALESCE(b.monthly_avg, 0) > 0
          THEN GREATEST(0, ROUND((1 - (COALESCE(l.cnt, 0)::numeric / NULLIF(b.monthly_avg, 0))) * 100))
          ELSE 0 END::int AS risk_score
      FROM customers c
      LEFT JOIN last30 l ON l.customer_id = c.id
      LEFT JOIN baseline b ON b.customer_id = c.id
      WHERE c.status = 'aktiv' AND c.deleted_at IS NULL
        AND COALESCE(b.monthly_avg, 0) > 1 AND COALESCE(l.cnt, 0) < (b.monthly_avg * 0.5)
      ORDER BY risk_score DESC LIMIT 25
    `),
    db.execute(sql`
      WITH cust_rev AS (
        SELECT i.customer_id, SUM(li.total_cents)::bigint AS rev
        FROM invoice_line_items li JOIN invoices i ON i.id = li.invoice_id
        WHERE i.status != 'storniert' AND i.invoice_type != 'stornorechnung' ${invFilter}
        GROUP BY i.customer_id
      )
      SELECT c.pflegegrad, COUNT(*)::int AS count, COALESCE(SUM(cr.rev), 0)::bigint AS revenue_cents
      FROM customers c LEFT JOIN cust_rev cr ON cr.customer_id = c.id
      WHERE c.status = 'aktiv' AND c.deleted_at IS NULL
      GROUP BY c.pflegegrad ORDER BY c.pflegegrad NULLS LAST
    `),
    db.execute(sql`
      SELECT COUNT(*)::int AS planned FROM appointments a
      WHERE a.deleted_at IS NULL AND a.appointment_type = 'Erstberatung'
        AND a.status = 'scheduled' AND a.date::date >= CURRENT_DATE
    `),
    db.execute(sql`
      SELECT c.id, COALESCE(NULLIF(TRIM(CONCAT_WS(' ', c.vorname, c.nachname)), ''), c.name) AS name,
        COALESCE(SUM(li.total_cents), 0)::bigint AS revenue_cents
      FROM customers c
      LEFT JOIN invoices i ON i.customer_id = c.id
        AND i.status != 'storniert' AND i.invoice_type != 'stornorechnung' ${invFilter}
      LEFT JOIN invoice_line_items li ON li.invoice_id = i.id
      WHERE c.deleted_at IS NULL
      GROUP BY c.id, c.vorname, c.nachname, c.name
      ORDER BY revenue_cents DESC LIMIT 10
    `),
    db.execute(sql`
      WITH alloc AS (
        SELECT ba.customer_id, COALESCE(SUM(ba.amount_cents), 0)::bigint AS allocated
        FROM budget_allocations ba
        WHERE ba.deleted_at IS NULL AND ba.year = ${period.year}
        GROUP BY ba.customer_id
      ),
      used AS (
        SELECT bt.customer_id, COALESCE(ABS(SUM(bt.amount_cents)), 0)::bigint AS consumed
        FROM budget_transactions bt
        WHERE bt.transaction_type = 'consumption'
          AND EXTRACT(YEAR FROM bt.transaction_date::date) = ${period.year}
        GROUP BY bt.customer_id
      )
      SELECT c.id, COALESCE(NULLIF(TRIM(CONCAT_WS(' ', c.vorname, c.nachname)), ''), c.name) AS name,
        COALESCE(alloc.allocated, 0) AS allocated, COALESCE(used.consumed, 0) AS consumed
      FROM customers c LEFT JOIN alloc ON alloc.customer_id = c.id LEFT JOIN used ON used.customer_id = c.id
      WHERE c.status = 'aktiv' AND c.deleted_at IS NULL
        AND COALESCE(alloc.allocated, 0) > 0
        AND COALESCE(used.consumed, 0) < COALESCE(alloc.allocated, 0) * 0.5
      ORDER BY (COALESCE(alloc.allocated, 0) - COALESCE(used.consumed, 0)) DESC LIMIT 25
    `),
    activeCustomerCount(period),
    activeCustomerCount(prev),
    activeCustomerCount(prevY),
    conversionRatePct(period),
    conversionRatePct(prev),
    conversionRatePct(prevY),
  ]);

  const f = funnelRow.rows[0] as Record<string, unknown>;
  const planned = num((plannedRow.rows[0] as Record<string, unknown>)?.planned);

  // Sample size for the conversion rate = total Erstberatungen in the (full-year) period.
  const sampleRow = await db.execute(sql`
    SELECT COUNT(DISTINCT a.customer_id)::int AS n
    FROM appointments a
    WHERE a.deleted_at IS NULL AND a.appointment_type = 'Erstberatung'
      AND a.status IN ('completed','documented')
      AND EXTRACT(YEAR FROM a.date::date) = ${period.year}
  `);
  const sampleSize = num((sampleRow.rows[0] as Record<string, unknown>)?.n);
  const range = wilsonProjection(planned, curConv.pct / 100, sampleSize);

  const prospect = num(f.prospect);
  const inConsultation = num(f.in_consultation);
  const active = num(f.active);
  const inactive = num(f.inactive);
  const terminated = num(f.terminated);
  const everActive = active + inactive + terminated;

  return {
    period: periodToResponse(period),
    funnel: { prospect, inConsultation, active, inactive, terminated },
    funnelConversionRates: {
      prospectToConsultationPct: prospect + inConsultation > 0
        ? Math.round((inConsultation / (prospect + inConsultation)) * 100) : 0,
      consultationToActivePct: inConsultation + active > 0
        ? Math.round((active / (inConsultation + active)) * 100) : 0,
      retentionPct: everActive > 0 ? Math.round((active / everActive) * 100) : 0,
    },
    activeCustomers: buildKpi(curActive, prevActive, yoyActive),
    conversionRatePct: buildKpi(curConv.pct, prevConv.pct, yoyConv.pct),
    avgDaysConsultationToFirstAppointment: curConv.avgDays > 0 ? curConv.avgDays : null,
    monthlyGainedLost: monthlyRow.rows.map((r: Record<string, unknown>) => ({
      month: num(r.month), gained: num(r.gained), lost: num(r.lost),
    })),
    cancellationRatePct: cancellationRow.rows.map((r: Record<string, unknown>) => ({
      month: num(r.month), ratePct: num(r.rate_pct),
    })),
    churnEarlyWarning: churnRows.rows.map((r: Record<string, unknown>) => {
      const last30 = num(r.appts_last_30);
      const baseline = num(r.baseline_monthly);
      const ratio = baseline > 0 ? last30 / baseline : 0;
      let reason: string;
      if (last30 === 0) {
        reason = `Keine Termine in den letzten 30 Tagen (Schnitt sonst ${baseline.toLocaleString("de-DE", { maximumFractionDigits: 1 })}/Monat).`;
      } else if (ratio < 0.3) {
        reason = `Termine massiv eingebrochen: ${last30} statt ø ${baseline.toLocaleString("de-DE", { maximumFractionDigits: 1 })}/Monat.`;
      } else {
        reason = `Termine rückläufig: ${last30} statt ø ${baseline.toLocaleString("de-DE", { maximumFractionDigits: 1 })}/Monat.`;
      }
      return {
        id: num(r.id), name: String(r.name ?? "Unbekannt"),
        apptsLast30: last30, apptsBaselineMonthly: baseline,
        riskScore: num(r.risk_score), reason,
      };
    }),
    pflegegradMix: pflegegradRows.rows.map((r: Record<string, unknown>) => ({
      pflegegrad: r.pflegegrad == null ? null : num(r.pflegegrad),
      count: num(r.count), revenueCents: num(r.revenue_cents),
    })),
    plannedConsultations: planned,
    projectedNewCustomers: range.point,
    projectedNewCustomersRange: range,
    topCustomersByRevenue: topCustomersRows.rows.map((r: Record<string, unknown>) => ({
      id: num(r.id), name: String(r.name ?? "Unbekannt"), revenueCents: num(r.revenue_cents),
    })),
    unusedBudgetCustomers: unusedBudgetRows.rows.map((r: Record<string, unknown>) => {
      const allocated = num(r.allocated); const consumed = num(r.consumed);
      const remaining = Math.max(0, allocated - consumed);
      return {
        id: num(r.id), name: String(r.name ?? "Unbekannt"),
        remainingCents: remaining,
        remainingPct: allocated > 0 ? Math.round((remaining / allocated) * 100) : 0,
      };
    }),
  };
}

/**
 * Berechnet die Prognose neuer Kunden + 95%-Wilson-Konfidenz-Intervall.
 * planned = geplante Erstberatungen, p = beobachtete Conversion-Rate (0..1), n = Stichprobengröße.
 */
function wilsonProjection(planned: number, p: number, n: number) {
  const point = Math.round(planned * p);
  if (n <= 0 || planned <= 0) {
    return { point, lower: point, upper: point, sampleSize: n };
  }
  const z = 1.96;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  const lower = Math.max(0, center - margin);
  const upper = Math.min(1, center + margin);
  return {
    point,
    lower: Math.round(planned * lower),
    upper: Math.round(planned * upper),
    sampleSize: n,
  };
}
