import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { asyncHandler, forbidden } from "../lib/errors";
import { db } from "../lib/db";
import { sql } from "drizzle-orm";

import revenueRouter from "./statistics/revenue";
import operationsRouter from "./statistics/operations";
import customersRouter from "./statistics/customers";
import v2Router from "./statistics/v2";

const router = Router();
router.use(requireAuth);

router.use("/v2", v2Router);
router.use("/", revenueRouter);
router.use("/", operationsRouter);
router.use("/", customersRouter);

function currentMonth() {
  return new Date().getMonth() + 1;
}

async function computeBudgetAllPots(
  yr: number,
  effectiveMonth: number,
  usedMonthFilter: ReturnType<typeof sql>,
  includeCustomerCount: boolean
) {
  const [r45b, r45a, r39, usedAll] = await Promise.all([
    db.execute(sql`
      SELECT COALESCE(SUM(ba.amount_cents), 0)::bigint AS "allocated"
      FROM budget_allocations ba
      WHERE ba.budget_type = 'entlastungsbetrag_45b'
        AND ba.year = ${yr} AND ba.month <= ${effectiveMonth}
    `),
    db.execute(sql`
      SELECT COALESCE(SUM(ba.amount_cents), 0)::bigint AS "allocated"
      FROM budget_allocations ba
      WHERE ba.budget_type = 'umwandlung_45a'
        AND ba.year = ${yr} AND ba.month = ${effectiveMonth}
    `),
    db.execute(sql`
      SELECT COALESCE(SUM(ba.amount_cents), 0)::bigint AS "yearTotal"
      FROM budget_allocations ba
      WHERE ba.budget_type = 'ersatzpflege_39_42a'
        AND ba.year = ${yr}
    `),
    db.execute(sql`
      SELECT COALESCE(ABS(SUM(bt.amount_cents)), 0)::bigint AS "used"
        ${includeCustomerCount ? sql`, COUNT(DISTINCT bt.customer_id)::int AS "customerCount"` : sql``}
      FROM budget_transactions bt
      WHERE bt.transaction_type = 'consumption'
        AND EXTRACT(YEAR FROM bt.transaction_date::date) = ${yr}
        ${usedMonthFilter}
    `),
  ]);

  const alloc45b = Number((r45b.rows[0] as any)?.allocated || 0);
  const alloc45a = Number((r45a.rows[0] as any)?.allocated || 0);
  const yearTotal39 = Number((r39.rows[0] as any)?.yearTotal || 0);
  const alloc39 = effectiveMonth >= 12 ? yearTotal39 : Math.round(yearTotal39 / 12 * effectiveMonth);
  const totalAllocated = alloc45b + alloc45a + alloc39;
  const totalUsed = Number((usedAll.rows[0] as any)?.used || 0);

  const row: any = { allocatedCents: totalAllocated, usedCents: totalUsed };
  if (includeCustomerCount) {
    row.customerCount = Number((usedAll.rows[0] as any)?.customerCount || 0);
  }
  return { rows: [row] };
}

router.get("/overview", asyncHandler("Statistiken konnten nicht geladen werden", async (req, res) => {
  if (!req.user!.isAdmin) throw forbidden("FORBIDDEN", "Nur für Administratoren");

  const year = parseInt(req.query.year as string) || new Date().getFullYear();
  const month = req.query.month ? parseInt(req.query.month as string) : null;

  const monthFilter = month
    ? sql`AND EXTRACT(MONTH FROM a.date::date) = ${month}`
    : sql``;

  const monthFilterTime = month
    ? sql`AND EXTRACT(MONTH FROM t.entry_date::date) = ${month}`
    : sql``;

  const monthFilterInv = month
    ? sql`AND i.billing_month = ${month}`
    : sql``;

  const [
    employeeStats,
    revenueStats,
    customerStats,
    efficiencyStats,
    monthlyTrends,
    pflegegradDistribution,
    budgetUtilization,
  ] = await Promise.all([
    db.execute(sql`
      SELECT
        u.id,
        u.display_name AS name,
        COALESCE(apt.total_appointments, 0)::int AS appointments,
        COALESCE(apt.unique_customers, 0)::int AS customers,
        COALESCE(apt.total_duration_min, 0)::int AS "workMinutes",
        COALESCE(apt.total_travel_km, 0)::int AS "travelKm",
        COALESCE(apt.total_travel_min, 0)::int AS "travelMinutes",
        COALESCE(apt.total_customer_km, 0)::int AS "customerKm",
        COALESCE(time_stats.sick_days, 0)::int AS "sickDays",
        COALESCE(time_stats.vacation_days, 0)::int AS "vacationDays",
        COALESCE(time_stats.office_minutes, 0)::int AS "officeMinutes",
        COALESCE(rev.revenue_cents, 0)::bigint AS "revenueCents"
      FROM users u
      LEFT JOIN (
        SELECT
          COALESCE(a.performed_by_employee_id, a.assigned_employee_id) AS emp_id,
          COUNT(*) AS total_appointments,
          COUNT(DISTINCT a.customer_id) AS unique_customers,
          SUM(a.duration_promised) AS total_duration_min,
          SUM(COALESCE(a.travel_kilometers, 0)) AS total_travel_km,
          SUM(COALESCE(a.travel_minutes, 0)) AS total_travel_min,
          SUM(COALESCE(a.customer_kilometers, 0)) AS total_customer_km
        FROM appointments a
        WHERE a.deleted_at IS NULL
          AND a.status IN ('completed', 'documented')
          AND EXTRACT(YEAR FROM a.date::date) = ${year}
          ${monthFilter}
        GROUP BY emp_id
      ) apt ON apt.emp_id = u.id
      LEFT JOIN (
        SELECT
          t.user_id,
          SUM(CASE WHEN t.entry_type = 'krankheit' AND t.is_full_day THEN 1 ELSE 0 END) AS sick_days,
          SUM(CASE WHEN t.entry_type = 'urlaub' AND t.is_full_day THEN 1 ELSE 0 END) AS vacation_days,
          SUM(CASE WHEN t.entry_type = 'bueroarbeit' THEN COALESCE(t.duration_minutes, 0) ELSE 0 END) AS office_minutes
        FROM employee_time_entries t
        WHERE EXTRACT(YEAR FROM t.entry_date::date) = ${year}
          ${monthFilterTime}
        GROUP BY t.user_id
      ) time_stats ON time_stats.user_id = u.id
      LEFT JOIN (
        SELECT
          COALESCE(a.performed_by_employee_id, a.assigned_employee_id) AS emp_id,
          SUM(li.total_cents) AS revenue_cents
        FROM invoice_line_items li
        JOIN invoices i ON i.id = li.invoice_id
        JOIN appointments a ON a.id = li.appointment_id
        WHERE i.status != 'storniert'
          AND i.billing_year = ${year}
          ${monthFilterInv}
          AND a.deleted_at IS NULL
        GROUP BY emp_id
      ) rev ON rev.emp_id = u.id
      WHERE u.is_active = true AND u.is_anonymized = false
      ORDER BY apt.total_appointments DESC NULLS LAST
    `),

    db.execute(sql`
      SELECT
        COALESCE(SUM(CASE WHEN i.status != 'storniert' AND i.invoice_type != 'stornorechnung' THEN i.gross_amount_cents ELSE 0 END), 0)::bigint AS "totalRevenueCents",
        COALESCE(SUM(CASE WHEN i.status = 'bezahlt' AND i.invoice_type != 'stornorechnung' THEN i.gross_amount_cents ELSE 0 END), 0)::bigint AS "paidRevenueCents",
        COALESCE(SUM(CASE WHEN i.status = 'versendet' AND i.invoice_type != 'stornorechnung' THEN i.gross_amount_cents ELSE 0 END), 0)::bigint AS "openRevenueCents",
        COUNT(CASE WHEN i.status != 'storniert' AND i.invoice_type != 'stornorechnung' THEN 1 END)::int AS "totalInvoices",
        COUNT(CASE WHEN i.status = 'bezahlt' AND i.invoice_type != 'stornorechnung' THEN 1 END)::int AS "paidInvoices",
        COUNT(CASE WHEN i.status = 'versendet' AND i.invoice_type != 'stornorechnung' THEN 1 END)::int AS "openInvoices",
        COUNT(CASE WHEN i.status = 'storniert' OR i.invoice_type = 'stornorechnung' THEN 1 END)::int AS "cancelledInvoices"
      FROM invoices i
      WHERE i.billing_year = ${year}
        ${monthFilterInv}
    `),

    db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE c.status = 'aktiv' AND c.deleted_at IS NULL)::int AS "activeCustomers",
        COUNT(*) FILTER (WHERE c.status = 'inaktiv' AND c.deleted_at IS NULL)::int AS "inactiveCustomers",
        COUNT(*) FILTER (WHERE c.status = 'interessent' AND c.deleted_at IS NULL)::int AS "prospects",
        COUNT(*) FILTER (WHERE c.status = 'gekuendigt' AND c.deleted_at IS NULL)::int AS "terminated",
        (SELECT COALESCE(AVG(apt_count), 0)
         FROM (
           SELECT COUNT(*) AS apt_count
           FROM appointments a
           WHERE a.deleted_at IS NULL
             AND a.status IN ('completed', 'documented')
             AND EXTRACT(YEAR FROM a.date::date) = ${year}
             ${monthFilter}
           GROUP BY a.customer_id
         ) sub
        )::numeric(10,1) AS "avgAppointmentsPerCustomer",
        (SELECT COUNT(*)
         FROM appointments a
         WHERE a.deleted_at IS NULL
           AND a.appointment_type = 'Erstberatung'
           AND a.status = 'scheduled'
           AND a.date >= CURRENT_DATE
        )::int AS "plannedConsultationsFuture",
        (SELECT COUNT(*)
         FROM appointments a
         WHERE a.deleted_at IS NULL
           AND a.appointment_type = 'Erstberatung'
           AND a.status = 'scheduled'
           AND a.date < CURRENT_DATE
        )::int AS "plannedConsultationsPast",
        (SELECT COUNT(*)
         FROM appointments a
         WHERE a.deleted_at IS NULL
           AND a.appointment_type = 'Erstberatung'
           AND a.status = 'scheduled'
        )::int AS "plannedConsultations"
      FROM customers c
    `),

    db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE a.status = 'completed')::int AS "completedAppointments",
        COUNT(*) FILTER (WHERE a.status = 'documented')::int AS "documentedAppointments",
        COUNT(*) FILTER (WHERE a.status = 'cancelled')::int AS "cancelledAppointments",
        COUNT(*) FILTER (WHERE a.status = 'scheduled')::int AS "scheduledAppointments",
        COUNT(*)::int AS "totalAppointments",
        COALESCE(SUM(CASE WHEN a.status IN ('completed', 'documented') THEN a.travel_kilometers ELSE 0 END), 0)::int AS "totalTravelKm",
        COALESCE(SUM(CASE WHEN a.status IN ('completed', 'documented') THEN a.travel_minutes ELSE 0 END), 0)::int AS "totalTravelMinutes",
        COALESCE(SUM(CASE WHEN a.status IN ('completed', 'documented') THEN a.duration_promised ELSE 0 END), 0)::int AS "totalServiceMinutes",
        COALESCE(SUM(CASE WHEN a.status IN ('completed', 'documented') THEN a.customer_kilometers ELSE 0 END), 0)::int AS "totalCustomerKm"
      FROM appointments a
      WHERE a.deleted_at IS NULL
        AND EXTRACT(YEAR FROM a.date::date) = ${year}
        ${monthFilter}
    `),

    db.execute(sql`
      SELECT
        m.month::int AS month,
        COALESCE(inv.revenue_cents, 0)::bigint AS "revenueCents",
        COALESCE(inv.invoice_count, 0)::int AS "invoiceCount",
        COALESCE(apt.appointment_count, 0)::int AS "appointmentCount",
        COALESCE(apt.completed_count, 0)::int AS "completedCount",
        COALESCE(apt.completed_hauswirtschaft, 0)::int AS "completedHauswirtschaft",
        COALESCE(apt.completed_alltagsbegleitung, 0)::int AS "completedAlltagsbegleitung",
        COALESCE(apt.completed_erstberatungen, 0)::int AS "completedErstberatungen",
        COALESCE(apt.cancelled_count, 0)::int AS "cancelledCount",
        COALESCE(apt.unique_customers, 0)::int AS "activeCustomers",
        COALESCE(apt.hw_minutes, 0)::int AS "hwMinutes",
        COALESCE(apt.ab_minutes, 0)::int AS "abMinutes",
        COALESCE(apt.eb_minutes, 0)::int AS "ebMinutes",
        COALESCE(te.pause_minutes, 0)::int AS "pauseMinutes",
        COALESCE(te.urlaub_minutes, 0)::int AS "urlaubMinutes",
        COALESCE(te.krank_minutes, 0)::int AS "krankMinutes",
        COALESCE(te.bueroarbeit_minutes, 0)::int AS "bueroarbeitMinutes",
        COALESCE(te.vertrieb_minutes, 0)::int AS "vertriebMinutes",
        COALESCE(te.sonstiges_minutes, 0)::int AS "sonstigesMinutes"
      FROM generate_series(1, 12) AS m(month)
      LEFT JOIN (
        SELECT
          i.billing_month,
          SUM(CASE WHEN i.status != 'storniert' AND i.invoice_type != 'stornorechnung' THEN i.gross_amount_cents ELSE 0 END) AS revenue_cents,
          COUNT(CASE WHEN i.status != 'storniert' AND i.invoice_type != 'stornorechnung' THEN 1 END) AS invoice_count
        FROM invoices i
        WHERE i.billing_year = ${year}
        GROUP BY i.billing_month
      ) inv ON inv.billing_month = m.month
      LEFT JOIN (
        SELECT
          EXTRACT(MONTH FROM a.date::date)::int AS m,
          COUNT(*) AS appointment_count,
          COUNT(*) FILTER (WHERE a.status IN ('completed', 'documented')) AS completed_count,
          COUNT(*) FILTER (WHERE a.status IN ('completed', 'documented') AND a.service_type = 'hauswirtschaft') AS completed_hauswirtschaft,
          COUNT(*) FILTER (WHERE a.status IN ('completed', 'documented') AND a.service_type = 'alltagsbegleitung') AS completed_alltagsbegleitung,
          COUNT(*) FILTER (WHERE a.status IN ('completed', 'documented') AND a.appointment_type = 'Erstberatung') AS completed_erstberatungen,
          COUNT(*) FILTER (WHERE a.status = 'cancelled') AS cancelled_count,
          COUNT(DISTINCT a.customer_id) FILTER (WHERE a.status IN ('completed', 'documented')) AS unique_customers,
          COALESCE(SUM(a.duration_promised) FILTER (WHERE a.status IN ('completed', 'documented') AND a.service_type = 'hauswirtschaft'), 0) AS hw_minutes,
          COALESCE(SUM(a.duration_promised) FILTER (WHERE a.status IN ('completed', 'documented') AND a.service_type = 'alltagsbegleitung'), 0) AS ab_minutes,
          COALESCE(SUM(a.duration_promised) FILTER (WHERE a.status IN ('completed', 'documented') AND a.appointment_type = 'Erstberatung'), 0) AS eb_minutes
        FROM appointments a
        WHERE a.deleted_at IS NULL
          AND EXTRACT(YEAR FROM a.date::date) = ${year}
        GROUP BY EXTRACT(MONTH FROM a.date::date)
      ) apt ON apt.m = m.month
      LEFT JOIN (
        SELECT
          EXTRACT(MONTH FROM t.entry_date::date)::int AS m,
          COALESCE(SUM(t.duration_minutes) FILTER (WHERE t.entry_type = 'pause'), 0) AS pause_minutes,
          COALESCE(SUM(t.duration_minutes) FILTER (WHERE t.entry_type = 'urlaub'), 0) AS urlaub_minutes,
          COALESCE(SUM(t.duration_minutes) FILTER (WHERE t.entry_type = 'krankheit'), 0) AS krank_minutes,
          COALESCE(SUM(t.duration_minutes) FILTER (WHERE t.entry_type = 'bueroarbeit'), 0) AS bueroarbeit_minutes,
          COALESCE(SUM(t.duration_minutes) FILTER (WHERE t.entry_type = 'vertrieb'), 0) AS vertrieb_minutes,
          COALESCE(SUM(t.duration_minutes) FILTER (WHERE t.entry_type = 'sonstiges'), 0) AS sonstiges_minutes
        FROM employee_time_entries t
        WHERE t.deleted_at IS NULL
          AND EXTRACT(YEAR FROM t.entry_date::date) = ${year}
        GROUP BY EXTRACT(MONTH FROM t.entry_date::date)
      ) te ON te.m = m.month
      ORDER BY m.month
    `),

    db.execute(sql`
      SELECT
        COALESCE(c.pflegegrad, 0)::int AS pflegegrad,
        COUNT(*)::int AS count
      FROM customers c
      WHERE c.status = 'aktiv' AND c.deleted_at IS NULL
      GROUP BY c.pflegegrad
      ORDER BY c.pflegegrad NULLS FIRST
    `),

    (async () => {
      const now = new Date();
      const effectiveMonth = month || (year < now.getFullYear() ? 12 : currentMonth());
      const usedMonthFilter = month
        ? sql`AND EXTRACT(MONTH FROM bt.transaction_date::date) <= ${month}`
        : sql``;
      const result = await computeBudgetAllPots(year, effectiveMonth, usedMonthFilter, true);
      const r = result.rows[0] as any;
      return { rows: [{ totalAllocatedCents: r.allocatedCents, totalUsedCents: r.usedCents, customerCount: r.customerCount }] };
    })(),
  ]);

  const isMonthSelected = !!month;
  const cockpitMonthFilter = month
    ? sql`AND EXTRACT(MONTH FROM a.date::date) = ${month}`
    : sql``;
  const cockpitTimeMonthFilter = month
    ? sql`AND EXTRACT(MONTH FROM t.entry_date::date) = ${month}`
    : sql``;

  const prevMonth = month ? (month === 1 ? 12 : month - 1) : null;
  const prevMonthYear = month ? (month === 1 ? year - 1 : year) : null;

  const [cockpitCurrent, cockpitPrev, cockpitBudgetCurrent, cockpitBudgetPrev, cockpitUtilCurrent, cockpitUtilPrev] = await Promise.all([
    db.execute(sql`
      SELECT
        COALESCE(SUM(ROUND(slc.minutes / 60.0 * slc.price)), 0)::bigint AS "revenueCents",
        COALESCE(SUM(ROUND(slc.minutes / 60.0 * slc.cost)), 0)::bigint AS "costCents",
        COALESCE(SUM(slc.minutes), 0)::int AS "totalMinutes",
        COUNT(DISTINCT slc.appointment_id)::int AS appointments
      FROM (
        SELECT asvc.appointment_id,
          COALESCE(asvc.actual_duration_minutes, asvc.planned_duration_minutes) AS minutes,
          COALESCE(
            (SELECT csp.price_cents FROM customer_service_prices csp
             WHERE csp.customer_id = a.customer_id AND csp.service_id = s.id
               AND csp.deleted_at IS NULL
               AND csp.valid_from::date <= a.date::date AND (csp.valid_to IS NULL OR csp.valid_to::date >= a.date::date)
             ORDER BY csp.valid_from DESC LIMIT 1),
            s.default_price_cents
          ) AS price,
          s.employee_rate_cents AS cost
        FROM appointments a
        JOIN appointment_services asvc ON asvc.appointment_id = a.id
        JOIN services s ON s.id = asvc.service_id
        WHERE a.deleted_at IS NULL AND a.status IN ('completed','documented')
          AND s.unit_type = 'hours'
          AND EXTRACT(YEAR FROM a.date::date) = ${year}
          ${cockpitMonthFilter}
      ) slc
    `),
    isMonthSelected ? db.execute(sql`
      SELECT
        COALESCE(SUM(ROUND(slc.minutes / 60.0 * slc.price)), 0)::bigint AS "revenueCents",
        COALESCE(SUM(ROUND(slc.minutes / 60.0 * slc.cost)), 0)::bigint AS "costCents",
        COALESCE(SUM(slc.minutes), 0)::int AS "totalMinutes",
        COUNT(DISTINCT slc.appointment_id)::int AS appointments
      FROM (
        SELECT asvc.appointment_id,
          COALESCE(asvc.actual_duration_minutes, asvc.planned_duration_minutes) AS minutes,
          COALESCE(
            (SELECT csp.price_cents FROM customer_service_prices csp
             WHERE csp.customer_id = a.customer_id AND csp.service_id = s.id
               AND csp.deleted_at IS NULL
               AND csp.valid_from::date <= a.date::date AND (csp.valid_to IS NULL OR csp.valid_to::date >= a.date::date)
             ORDER BY csp.valid_from DESC LIMIT 1),
            s.default_price_cents
          ) AS price,
          s.employee_rate_cents AS cost
        FROM appointments a
        JOIN appointment_services asvc ON asvc.appointment_id = a.id
        JOIN services s ON s.id = asvc.service_id
        WHERE a.deleted_at IS NULL AND a.status IN ('completed','documented')
          AND s.unit_type = 'hours'
          AND EXTRACT(YEAR FROM a.date::date) = ${prevMonthYear!}
          AND EXTRACT(MONTH FROM a.date::date) = ${prevMonth!}
      ) slc
    `) : Promise.resolve({ rows: [null] }),

    computeBudgetAllPots(year, month ? month : (year < new Date().getFullYear() ? 12 : currentMonth()), month ? sql`AND EXTRACT(MONTH FROM bt.transaction_date::date) <= ${month}` : sql``, true),
    isMonthSelected ? computeBudgetAllPots(prevMonthYear!, prevMonth!, sql`AND EXTRACT(MONTH FROM bt.transaction_date::date) <= ${prevMonth!}`, false) : Promise.resolve({ rows: [null] }),

    db.execute(sql`
      SELECT
        COALESCE(SUM(CASE WHEN a.status IN ('completed','documented') THEN a.duration_promised ELSE 0 END), 0)::int AS "productiveMinutes",
        COALESCE((
          SELECT SUM(t.duration_minutes)
          FROM employee_time_entries t
          WHERE t.deleted_at IS NULL
            AND EXTRACT(YEAR FROM t.entry_date::date) = ${year}
            ${cockpitTimeMonthFilter}
            AND t.entry_type IN ('bueroarbeit','vertrieb','sonstiges')
        ), 0)::int AS "overheadMinutes",
        COUNT(*) FILTER (WHERE a.status IN ('completed','documented'))::int AS "completedAppointments"
      FROM appointments a
      WHERE a.deleted_at IS NULL
        AND EXTRACT(YEAR FROM a.date::date) = ${year}
        ${cockpitMonthFilter}
    `),
    isMonthSelected ? db.execute(sql`
      SELECT
        COALESCE(SUM(CASE WHEN a.status IN ('completed','documented') THEN a.duration_promised ELSE 0 END), 0)::int AS "productiveMinutes",
        COALESCE((
          SELECT SUM(t.duration_minutes)
          FROM employee_time_entries t
          WHERE t.deleted_at IS NULL
            AND EXTRACT(YEAR FROM t.entry_date::date) = ${prevMonthYear!}
            AND EXTRACT(MONTH FROM t.entry_date::date) = ${prevMonth!}
            AND t.entry_type IN ('bueroarbeit','vertrieb','sonstiges')
        ), 0)::int AS "overheadMinutes",
        COUNT(*) FILTER (WHERE a.status IN ('completed','documented'))::int AS "completedAppointments"
      FROM appointments a
      WHERE a.deleted_at IS NULL
        AND EXTRACT(YEAR FROM a.date::date) = ${prevMonthYear!}
        AND EXTRACT(MONTH FROM a.date::date) = ${prevMonth!}
    `) : Promise.resolve({ rows: [null] }),
  ]);

  const cur = cockpitCurrent.rows[0] as any;
  const prev = cockpitPrev.rows[0] as any;
  const budCur = cockpitBudgetCurrent.rows[0] as any;
  const budPrev = cockpitBudgetPrev.rows[0] as any;
  const utilCur = cockpitUtilCurrent.rows[0] as any;
  const utilPrev = cockpitUtilPrev.rows[0] as any;

  const marginPct = (rev: number, cost: number) => rev > 0 ? Math.round(((rev - cost) / rev) * 100) : 0;
  const utilizationPct = (prod: number, overhead: number) => {
    const total = prod + overhead;
    return total > 0 ? Math.round((prod / total) * 100) : 0;
  };
  const budgetPct = (used: number, allocated: number) => allocated > 0 ? Math.round((used / allocated) * 100) : 0;

  const cockpit = {
    month: month,
    year: year,
    hasPreviousMonth: isMonthSelected,
    margin: {
      revenueCents: Number(cur?.revenueCents || 0),
      costCents: Number(cur?.costCents || 0),
      marginCents: Number(cur?.revenueCents || 0) - Number(cur?.costCents || 0),
      marginPercent: marginPct(Number(cur?.revenueCents || 0), Number(cur?.costCents || 0)),
      appointments: Number(cur?.appointments || 0),
      totalMinutes: Number(cur?.totalMinutes || 0),
    },
    marginPrev: prev ? {
      revenueCents: Number(prev.revenueCents || 0),
      costCents: Number(prev.costCents || 0),
      marginCents: Number(prev.revenueCents || 0) - Number(prev.costCents || 0),
      marginPercent: marginPct(Number(prev.revenueCents || 0), Number(prev.costCents || 0)),
      appointments: Number(prev.appointments || 0),
      totalMinutes: Number(prev.totalMinutes || 0),
    } : null,
    utilization: {
      productiveMinutes: Number(utilCur?.productiveMinutes || 0),
      overheadMinutes: Number(utilCur?.overheadMinutes || 0),
      percent: utilizationPct(Number(utilCur?.productiveMinutes || 0), Number(utilCur?.overheadMinutes || 0)),
      appointments: Number(utilCur?.completedAppointments || 0),
    },
    utilizationPrev: utilPrev ? {
      productiveMinutes: Number(utilPrev.productiveMinutes || 0),
      overheadMinutes: Number(utilPrev.overheadMinutes || 0),
      percent: utilizationPct(Number(utilPrev.productiveMinutes || 0), Number(utilPrev.overheadMinutes || 0)),
      appointments: Number(utilPrev.completedAppointments || 0),
    } : null,
    budget: {
      allocatedCents: Number(budCur?.allocatedCents || 0),
      usedCents: Number(budCur?.usedCents || 0),
      percent: budgetPct(Number(budCur?.usedCents || 0), Number(budCur?.allocatedCents || 0)),
      customerCount: Number(budCur?.customerCount || 0),
    },
    budgetPrev: budPrev ? {
      allocatedCents: Number(budPrev.allocatedCents || 0),
      usedCents: Number(budPrev.usedCents || 0),
      percent: budgetPct(Number(budPrev.usedCents || 0), Number(budPrev.allocatedCents || 0)),
    } : null,
  };

  res.json({
    year,
    month,
    employees: employeeStats.rows,
    revenue: revenueStats.rows[0],
    customers: customerStats.rows[0],
    efficiency: efficiencyStats.rows[0],
    monthlyTrends: monthlyTrends.rows,
    pflegegradDistribution: pflegegradDistribution.rows,
    budgetUtilization: budgetUtilization.rows[0],
    cockpit,
  });
}));

export default router;
