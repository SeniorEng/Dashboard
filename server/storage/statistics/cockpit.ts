import { sql } from "drizzle-orm";
import { db } from "../../lib/db";
import type { CockpitResponse, ServiceTypeMinutesBreakdown } from "@shared/statistics";
import { billingPeriodFilter, buildKpi, dateFilter, num, periodToResponse, previousPeriod, previousYearPeriod, type ResolvedPeriod } from "./common";

async function computeRevenueStages(p: ResolvedPeriod) {
  const dFilter = dateFilter(p, sql`a.date::date`);
  const invFilter = billingPeriodFilter(p, sql`i.billing_year`, sql`i.billing_month`);

  const stages = await db.execute(sql`
    WITH per_appt AS (
      SELECT
        a.id,
        a.status,
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
      WHERE a.deleted_at IS NULL AND s.unit_type = 'hours'
        ${dFilter}
      GROUP BY a.id, a.status
    )
    SELECT
      COALESCE(SUM(CASE WHEN status IN ('scheduled','completed','documented') THEN revenue_cents END), 0)::bigint AS planned,
      COALESCE(SUM(CASE WHEN status IN ('completed','documented') THEN revenue_cents END), 0)::bigint AS documented,
      COALESCE(SUM(CASE WHEN id IN (
        SELECT sra.appointment_id FROM service_record_appointments sra
        JOIN monthly_service_records msr ON msr.id = sra.service_record_id
        WHERE msr.deleted_at IS NULL AND msr.status = 'completed'
      ) THEN revenue_cents END), 0)::bigint AS proven
    FROM per_appt
  `);

  const inv = await db.execute(sql`
    SELECT COALESCE(SUM(li.total_cents), 0)::bigint AS invoiced
    FROM invoice_line_items li
    JOIN invoices i ON i.id = li.invoice_id
    WHERE i.status != 'storniert' AND i.invoice_type != 'stornorechnung'
      ${invFilter}
  `);

  const r = stages.rows[0] as Record<string, unknown>;
  const inv0 = inv.rows[0] as Record<string, unknown>;
  return { planned: num(r.planned), documented: num(r.documented), proven: num(r.proven), invoiced: num(inv0.invoiced) };
}

async function computeMinutesByServiceType(p: ResolvedPeriod): Promise<ServiceTypeMinutesBreakdown> {
  const dFilter = dateFilter(p, sql`a.date::date`);
  // Category derived from appointment_services + services.lohnart_kategorie.
  // DISTINCT ON picks one category per appointment (preferring HW/AB over 'sonstige')
  // so duration_promised is not double-counted when an appointment has multiple services.
  const r = await db.execute(sql`
    WITH appt_category AS (
      SELECT DISTINCT ON (a.id)
        a.id,
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
        ${dFilter}
      ORDER BY a.id,
        CASE WHEN s.lohnart_kategorie IN ('hauswirtschaft','alltagsbegleitung') THEN 0 ELSE 1 END,
        COALESCE(asvc.actual_duration_minutes, asvc.planned_duration_minutes, 0) DESC NULLS LAST
    )
    SELECT
      COALESCE(SUM(CASE WHEN category = 'erstberatung' THEN duration_promised END), 0)::int AS eb,
      COALESCE(SUM(CASE WHEN category = 'hauswirtschaft' THEN duration_promised END), 0)::int AS hw,
      COALESCE(SUM(CASE WHEN category = 'alltagsbegleitung' THEN duration_promised END), 0)::int AS ab,
      COALESCE(SUM(CASE WHEN category = 'sonstige' THEN duration_promised END), 0)::int AS other
    FROM appt_category
  `);
  const row = r.rows[0] as Record<string, unknown>;
  return { hauswirtschaft: num(row.hw), alltagsbegleitung: num(row.ab), erstberatung: num(row.eb), sonstige: num(row.other) };
}

async function computeAppointmentsAndCustomers(p: ResolvedPeriod): Promise<{ appts: number; customers: number; active: number }> {
  const dFilter = dateFilter(p, sql`a.date::date`);
  const r = await db.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE a.status IN ('completed','documented'))::int AS appts,
      COUNT(DISTINCT a.customer_id) FILTER (WHERE a.status IN ('completed','documented'))::int AS customers,
      COUNT(DISTINCT a.customer_id) FILTER (WHERE a.status IN ('completed','documented','scheduled'))::int AS active
    FROM appointments a
    WHERE a.deleted_at IS NULL ${dFilter}
  `);
  const row = r.rows[0] as Record<string, unknown>;
  return { appts: num(row.appts), customers: num(row.customers), active: num(row.active) };
}

async function sparklines(year: number) {
  const r = await db.execute(sql`
    WITH per_appt AS (
      SELECT EXTRACT(MONTH FROM a.date::date)::int AS m, a.id,
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
        AND EXTRACT(YEAR FROM a.date::date) = ${year}
      GROUP BY EXTRACT(MONTH FROM a.date::date), a.id
    ),
    monthly AS (
      SELECT m,
        SUM(revenue_cents)::bigint AS revenue_cents,
        COUNT(DISTINCT id)::int AS appt_count
      FROM per_appt GROUP BY m
    )
    SELECT g.m AS month,
      COALESCE(monthly.revenue_cents, 0)::bigint AS revenue_cents,
      COALESCE(monthly.appt_count, 0)::int AS appt_count,
      COALESCE((
        SELECT COUNT(DISTINCT a.customer_id)::int
        FROM appointments a
        WHERE a.deleted_at IS NULL AND a.status IN ('completed','documented','scheduled')
          AND EXTRACT(YEAR FROM a.date::date) = ${year}
          AND EXTRACT(MONTH FROM a.date::date) = g.m
      ), 0) AS active_customers,
      COALESCE((
        SELECT COUNT(DISTINCT a.customer_id)::int
        FROM appointments a
        WHERE a.deleted_at IS NULL AND a.status IN ('completed','documented')
          AND EXTRACT(YEAR FROM a.date::date) = ${year}
          AND EXTRACT(MONTH FROM a.date::date) = g.m
      ), 0) AS done_customers,
      COALESCE((
        SELECT SUM(a.duration_promised)::int FROM appointments a
        WHERE a.deleted_at IS NULL AND a.status IN ('completed','documented')
          AND EXTRACT(YEAR FROM a.date::date) = ${year}
          AND EXTRACT(MONTH FROM a.date::date) = g.m
      ), 0) AS total_minutes
    FROM generate_series(1, 12) AS g(m)
    LEFT JOIN monthly ON monthly.m = g.m
    ORDER BY g.m
  `);
  return r.rows.map((row: Record<string, unknown>) => {
    const apptCount = num(row.appt_count);
    const doneCust = num(row.done_customers);
    const revenue = num(row.revenue_cents);
    return {
      period: `${year}-${String(num(row.month)).padStart(2, "0")}`,
      revenue,
      active: num(row.active_customers),
      minutes: num(row.total_minutes),
      apptsPerCustomer: doneCust > 0 ? Math.round((apptCount / doneCust) * 10) / 10 : 0,
      revenuePerCustomer: doneCust > 0 ? Math.round(revenue / doneCust) : 0,
    };
  });
}

export async function getCockpit(period: ResolvedPeriod): Promise<CockpitResponse> {
  const prev = previousPeriod(period);
  const prevY = previousYearPeriod(period);

  const [curStages, prevStages, yoyStages, curMinutes, prevMinutes, yoyMinutes, curAppts, prevAppts, yoyAppts, spark] = await Promise.all([
    computeRevenueStages(period),
    computeRevenueStages(prev),
    computeRevenueStages(prevY),
    computeMinutesByServiceType(period),
    computeMinutesByServiceType(prev),
    computeMinutesByServiceType(prevY),
    computeAppointmentsAndCustomers(period),
    computeAppointmentsAndCustomers(prev),
    computeAppointmentsAndCustomers(prevY),
    sparklines(period.year),
  ]);

  const sumMin = (h: ServiceTypeMinutesBreakdown) => h.hauswirtschaft + h.alltagsbegleitung + h.erstberatung + h.sonstige;
  const apptsPerCustomer = (a: { appts: number; customers: number }) =>
    a.customers > 0 ? Math.round((a.appts / a.customers) * 10) / 10 : 0;
  const revPerCustomer = (s: number, c: number) => (c > 0 ? Math.round(s / c) : 0);

  return {
    period: periodToResponse(period),
    revenueByStage: {
      planned: buildKpi(curStages.planned, prevStages.planned, yoyStages.planned),
      documented: buildKpi(curStages.documented, prevStages.documented, yoyStages.documented),
      proven: buildKpi(curStages.proven, prevStages.proven, yoyStages.proven),
      invoiced: buildKpi(curStages.invoiced, prevStages.invoiced, yoyStages.invoiced),
    },
    activeCustomers: buildKpi(curAppts.active, prevAppts.active, yoyAppts.active),
    netCustomerGrowth: buildKpi(curAppts.active - prevAppts.active, null, null),
    totalMinutes: buildKpi(sumMin(curMinutes), sumMin(prevMinutes), sumMin(yoyMinutes)),
    minutesByServiceType: curMinutes,
    appointmentsPerCustomer: buildKpi(apptsPerCustomer(curAppts), apptsPerCustomer(prevAppts), apptsPerCustomer(yoyAppts)),
    revenuePerCustomer: buildKpi(
      revPerCustomer(curStages.documented, curAppts.customers),
      revPerCustomer(prevStages.documented, prevAppts.customers),
      revPerCustomer(yoyStages.documented, yoyAppts.customers),
    ),
    sparklines: {
      revenueDocumented: spark.map((s) => ({ period: s.period, value: s.revenue })),
      activeCustomers: spark.map((s) => ({ period: s.period, value: s.active })),
      totalMinutes: spark.map((s) => ({ period: s.period, value: s.minutes })),
      appointmentsPerCustomer: spark.map((s) => ({ period: s.period, value: s.apptsPerCustomer })),
      revenuePerCustomer: spark.map((s) => ({ period: s.period, value: s.revenuePerCustomer })),
    },
  };
}
