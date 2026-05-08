import { sql } from "drizzle-orm";
import { db } from "../../lib/db";
import type { PerformanceStatsResponse, ProfitabilityBreakdown } from "@shared/statistics";
import { buildKpi, dateFilter, num, periodToResponse, previousPeriod, previousYearPeriod, type ResolvedPeriod } from "./common";

interface UtilizationCounts { productive: number; overhead: number; sickVac: number; revenue: number; minutes: number; }

async function utilizationAndRevenue(p: ResolvedPeriod): Promise<UtilizationCounts> {
  const dFilter = dateFilter(p, sql`a.date::date`);
  const tFilter = dateFilter(p, sql`t.entry_date::date`);
  const r = await db.execute(sql`
    SELECT
      COALESCE((SELECT SUM(a.duration_promised)::int FROM appointments a
        WHERE a.deleted_at IS NULL AND a.status IN ('completed','documented') ${dFilter}), 0) AS productive,
      COALESCE((SELECT SUM(t.duration_minutes)::int FROM employee_time_entries t
        WHERE t.deleted_at IS NULL AND t.entry_type IN ('bueroarbeit','vertrieb','sonstiges') ${tFilter}), 0) AS overhead,
      COALESCE((SELECT SUM(t.duration_minutes)::int FROM employee_time_entries t
        WHERE t.deleted_at IS NULL AND t.entry_type IN ('krankheit','urlaub') ${tFilter}), 0) AS sick_vacation
  `);
  const row = r.rows[0] as Record<string, unknown>;
  const rev = await db.execute(sql`
    WITH per_appt AS (
      SELECT a.duration_promised AS minutes,
        SUM(ROUND(COALESCE(asvc.actual_duration_minutes, asvc.planned_duration_minutes) / 60.0 *
          COALESCE(
            (SELECT csp.price_cents FROM customer_service_prices csp
             WHERE csp.customer_id = a.customer_id AND csp.service_id = s.id
               AND csp.deleted_at IS NULL
               AND csp.valid_from::date <= a.date::date
               AND (csp.valid_to IS NULL OR csp.valid_to::date >= a.date::date)
             ORDER BY csp.valid_from DESC LIMIT 1),
            s.default_price_cents
          )
        ))::bigint AS revenue_cents
      FROM appointments a
      JOIN appointment_services asvc ON asvc.appointment_id = a.id
      JOIN services s ON s.id = asvc.service_id
      WHERE a.deleted_at IS NULL AND a.status IN ('completed','documented') AND s.unit_type = 'hours'
        ${dFilter}
      GROUP BY a.id, a.duration_promised
    )
    SELECT COALESCE(SUM(revenue_cents), 0)::bigint AS revenue,
      COALESCE(SUM(minutes), 0)::int AS minutes
    FROM per_appt
  `);
  const rrow = rev.rows[0] as Record<string, unknown>;
  return {
    productive: num(row.productive), overhead: num(row.overhead), sickVac: num(row.sick_vacation),
    revenue: num(rrow.revenue), minutes: num(rrow.minutes),
  };
}

export async function getPerformanceStats(period: ResolvedPeriod): Promise<PerformanceStatsResponse> {
  const prev = previousPeriod(period);
  const prevY = previousYearPeriod(period);
  const dFilter = dateFilter(period, sql`a.date::date`);

  const [minutesByMonthRow, avgDurationRow, revPerHourRow, profitabilityRow, servicePricesRow, cur, pre, yoy] = await Promise.all([
    db.execute(sql`
      WITH appt_category AS (
        SELECT DISTINCT ON (a.id)
          a.id,
          a.date,
          a.duration_promised,
          CASE
            WHEN a.appointment_type = 'Erstberatung' THEN 'erstberatung'
            WHEN s.lohnart_kategorie IN ('hauswirtschaft','alltagsbegleitung') THEN s.lohnart_kategorie
            ELSE 'sonstige'
          END AS category
        FROM appointments a
        LEFT JOIN appointment_services asvc ON asvc.appointment_id = a.id
        LEFT JOIN services s ON s.id = asvc.service_id
        WHERE a.deleted_at IS NULL AND a.status IN ('completed','documented')
          AND EXTRACT(YEAR FROM a.date::date) = ${period.year}
        ORDER BY a.id,
          CASE WHEN s.lohnart_kategorie IN ('hauswirtschaft','alltagsbegleitung') THEN 0 ELSE 1 END,
          COALESCE(asvc.actual_duration_minutes, asvc.planned_duration_minutes, 0) DESC NULLS LAST
      )
      SELECT g.m AS month,
        COALESCE(SUM(CASE WHEN ac.category = 'hauswirtschaft' THEN ac.duration_promised END), 0)::int AS hw,
        COALESCE(SUM(CASE WHEN ac.category = 'alltagsbegleitung' THEN ac.duration_promised END), 0)::int AS ab,
        COALESCE(SUM(CASE WHEN ac.category = 'erstberatung' THEN ac.duration_promised END), 0)::int AS eb,
        COALESCE(SUM(CASE WHEN ac.category = 'sonstige' THEN ac.duration_promised END), 0)::int AS other
      FROM generate_series(1, 12) AS g(m)
      LEFT JOIN appt_category ac ON EXTRACT(MONTH FROM ac.date::date) = g.m
      GROUP BY g.m ORDER BY g.m
    `),
    db.execute(sql`
      WITH appt_category AS (
        SELECT DISTINCT ON (a.id)
          a.id,
          a.duration_promised,
          CASE
            WHEN s.lohnart_kategorie IN ('hauswirtschaft','alltagsbegleitung') THEN s.lohnart_kategorie
            ELSE 'sonstige'
          END AS service_type
        FROM appointments a
        LEFT JOIN appointment_services asvc ON asvc.appointment_id = a.id
        LEFT JOIN services s ON s.id = asvc.service_id
        WHERE a.deleted_at IS NULL AND a.status IN ('completed','documented')
          AND a.appointment_type != 'Erstberatung'
          ${dFilter}
        ORDER BY a.id,
          CASE WHEN s.lohnart_kategorie IN ('hauswirtschaft','alltagsbegleitung') THEN 0 ELSE 1 END,
          COALESCE(asvc.actual_duration_minutes, asvc.planned_duration_minutes, 0) DESC NULLS LAST
      )
      SELECT service_type,
        ROUND(AVG(duration_promised)::numeric, 0)::int AS avg_minutes
      FROM appt_category
      GROUP BY service_type
    `),
    db.execute(sql`
      WITH per_appt AS (
        SELECT COALESCE(a.performed_by_employee_id, a.assigned_employee_id) AS employee_id,
          a.duration_promised AS minutes,
          SUM(ROUND(COALESCE(asvc.actual_duration_minutes, asvc.planned_duration_minutes) / 60.0 *
            COALESCE(
              (SELECT csp.price_cents FROM customer_service_prices csp
               WHERE csp.customer_id = a.customer_id AND csp.service_id = s.id
                 AND csp.deleted_at IS NULL
                 AND csp.valid_from::date <= a.date::date
                 AND (csp.valid_to IS NULL OR csp.valid_to::date >= a.date::date)
               ORDER BY csp.valid_from DESC LIMIT 1),
              s.default_price_cents
            )
          ))::bigint AS revenue_cents
        FROM appointments a
        JOIN appointment_services asvc ON asvc.appointment_id = a.id
        JOIN services s ON s.id = asvc.service_id
        WHERE a.deleted_at IS NULL AND a.status IN ('completed','documented') AND s.unit_type = 'hours'
          ${dFilter}
        GROUP BY a.id, a.performed_by_employee_id, a.assigned_employee_id, a.duration_promised
      )
      SELECT u.id AS employee_id, u.display_name AS employee_name,
        COALESCE(SUM(pa.revenue_cents), 0)::bigint AS revenue,
        COALESCE(SUM(pa.minutes), 0)::int AS minutes
      FROM users u LEFT JOIN per_appt pa ON pa.employee_id = u.id
      WHERE u.is_active = true AND u.is_anonymized = false
      GROUP BY u.id, u.display_name
      HAVING COALESCE(SUM(pa.minutes), 0) > 0
      ORDER BY revenue DESC
    `),
    db.execute(sql`
      WITH per_appt AS (
        SELECT COALESCE(a.performed_by_employee_id, a.assigned_employee_id) AS employee_id,
          a.duration_promised AS minutes,
          SUM(ROUND(COALESCE(asvc.actual_duration_minutes, asvc.planned_duration_minutes) / 60.0 *
            COALESCE(
              (SELECT csp.price_cents FROM customer_service_prices csp
               WHERE csp.customer_id = a.customer_id AND csp.service_id = s.id
                 AND csp.deleted_at IS NULL
                 AND csp.valid_from::date <= a.date::date
                 AND (csp.valid_to IS NULL OR csp.valid_to::date >= a.date::date)
               ORDER BY csp.valid_from DESC LIMIT 1),
              s.default_price_cents
            )
          ))::bigint AS revenue_cents,
          SUM(ROUND(COALESCE(asvc.actual_duration_minutes, asvc.planned_duration_minutes) / 60.0 *
            COALESCE(s.employee_rate_cents, 0)
          ))::bigint AS cost_cents,
          a.id AS appt_id
        FROM appointments a
        JOIN appointment_services asvc ON asvc.appointment_id = a.id
        JOIN services s ON s.id = asvc.service_id
        WHERE a.deleted_at IS NULL AND a.status IN ('completed','documented') AND s.unit_type = 'hours'
          ${dFilter}
        GROUP BY a.id, a.performed_by_employee_id, a.assigned_employee_id, a.duration_promised
      )
      SELECT u.id AS employee_id, u.display_name AS employee_name,
        COALESCE(SUM(pa.revenue_cents), 0)::bigint AS revenue_cents,
        COALESCE(SUM(pa.cost_cents), 0)::bigint AS cost_cents,
        COALESCE(SUM(pa.minutes), 0)::int AS minutes,
        COUNT(pa.appt_id)::int AS appointments
      FROM users u LEFT JOIN per_appt pa ON pa.employee_id = u.id
      WHERE u.is_active = true AND u.is_anonymized = false
      GROUP BY u.id, u.display_name
      HAVING COALESCE(SUM(pa.minutes), 0) > 0
      ORDER BY (COALESCE(SUM(pa.revenue_cents), 0) - COALESCE(SUM(pa.cost_cents), 0)) DESC
    `),
    db.execute(sql`
      SELECT s.code, s.name AS label,
        COALESCE(s.default_price_cents, 0)::bigint AS price_cents,
        COALESCE(s.employee_rate_cents, 0)::bigint AS rate_cents
      FROM services s
      WHERE s.code IN ('hauswirtschaft','alltagsbegleitung','erstberatung')
        AND s.unit_type = 'hours'
      ORDER BY CASE s.code WHEN 'hauswirtschaft' THEN 1 WHEN 'alltagsbegleitung' THEN 2 ELSE 3 END
    `),
    utilizationAndRevenue(period),
    utilizationAndRevenue(prev),
    utilizationAndRevenue(prevY),
  ]);

  const total = cur.productive + cur.overhead + cur.sickVac;
  const pct = (v: number) => total > 0 ? Math.round((v / total) * 100) : 0;
  const cph = (u: UtilizationCounts) => (u.minutes > 0 ? Math.round((u.revenue * 60) / u.minutes) : 0);
  const cphCur = cph(cur);
  const cphPrev = cph(pre);
  const cphYoy = cph(yoy);

  return {
    period: periodToResponse(period),
    minutesByMonth: minutesByMonthRow.rows.map((r: Record<string, unknown>) => ({
      month: num(r.month), hauswirtschaft: num(r.hw), alltagsbegleitung: num(r.ab),
      erstberatung: num(r.eb), sonstige: num(r.other),
    })),
    avgDurationByServiceType: avgDurationRow.rows.map((r: Record<string, unknown>) => ({
      serviceType: String(r.service_type ?? "sonstige"), avgMinutes: num(r.avg_minutes),
    })),
    utilization: {
      productiveMinutes: buildKpi(cur.productive, pre.productive, yoy.productive),
      overheadMinutes: buildKpi(cur.overhead, pre.overhead, yoy.overhead),
      sickVacationMinutes: buildKpi(cur.sickVac, pre.sickVac, yoy.sickVac),
      productivePct: pct(cur.productive),
      overheadPct: pct(cur.overhead),
      sickVacationPct: pct(cur.sickVac),
    },
    revenuePerHour: {
      totalCentsPerHour: buildKpi(cphCur, cphPrev, cphYoy),
      byEmployee: revPerHourRow.rows.map((r: Record<string, unknown>) => {
        const minutes = num(r.minutes); const revenue = num(r.revenue);
        return {
          employeeId: num(r.employee_id), employeeName: String(r.employee_name ?? ""),
          centsPerHour: minutes > 0 ? Math.round(revenue * 60 / minutes) : 0,
        };
      }),
    },
    profitability: ((): ProfitabilityBreakdown => {
      const byEmployee = profitabilityRow.rows.map((r: Record<string, unknown>) => {
        const revenueCents = num(r.revenue_cents);
        const costCents = num(r.cost_cents);
        const marginCents = revenueCents - costCents;
        return {
          employeeId: num(r.employee_id),
          employeeName: String(r.employee_name ?? ""),
          revenueCents,
          costCents,
          marginCents,
          marginPercent: revenueCents > 0 ? Math.round((marginCents / revenueCents) * 100) : 0,
          totalMinutes: num(r.minutes),
          appointments: num(r.appointments),
        };
      });
      const totalRevenueCents = byEmployee.reduce((s, e) => s + e.revenueCents, 0);
      const totalCostCents = byEmployee.reduce((s, e) => s + e.costCents, 0);
      const totalMarginCents = totalRevenueCents - totalCostCents;
      const servicePrices = servicePricesRow.rows.map((r: Record<string, unknown>) => {
        const priceCents = num(r.price_cents);
        const rateCents = num(r.rate_cents);
        const marginCents = priceCents - rateCents;
        return {
          code: String(r.code ?? ""),
          label: String(r.label ?? r.code ?? ""),
          priceCents,
          rateCents,
          marginCents,
          marginPercent: priceCents > 0 ? Math.round((marginCents / priceCents) * 100) : 0,
        };
      });
      return {
        totals: {
          revenueCents: totalRevenueCents,
          costCents: totalCostCents,
          marginCents: totalMarginCents,
          marginPercent: totalRevenueCents > 0 ? Math.round((totalMarginCents / totalRevenueCents) * 100) : 0,
        },
        byEmployee,
        servicePrices,
      };
    })(),
  };
}
