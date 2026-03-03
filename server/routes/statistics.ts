import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { asyncHandler, forbidden } from "../lib/errors";
import { db } from "../lib/db";
import { sql } from "drizzle-orm";

const router = Router();
router.use(requireAuth);

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
    // 1. Employee Performance
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

    // 2. Revenue Stats – only count rechnung/nachberechnung, exclude stornorechnung
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

    // 3. Customer Stats
    db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE c.status = 'aktiv' AND c.deleted_at IS NULL)::int AS "activeCustomers",
        COUNT(*) FILTER (WHERE c.status = 'inaktiv' AND c.deleted_at IS NULL)::int AS "inactiveCustomers",
        COUNT(*) FILTER (WHERE c.status = 'interessent' AND c.deleted_at IS NULL)::int AS "prospects",
        COUNT(*) FILTER (WHERE c.status = 'erstberatung' AND c.deleted_at IS NULL)::int AS "consultation",
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
        )::numeric(10,1) AS "avgAppointmentsPerCustomer"
      FROM customers c
    `),

    // 4. Efficiency Stats
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

    // 5. Monthly Trends (revenue + appointments + hours per month)
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
        COALESCE(te.besprechung_minutes, 0)::int AS "besprechungMinutes",
        COALESCE(te.vertrieb_minutes, 0)::int AS "vertriebMinutes",
        COALESCE(te.sonstiges_minutes, 0)::int AS "sonstigesMinutes",
        COALESCE(te.weiterbildung_minutes, 0)::int AS "weiterbildungMinutes"
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
          COALESCE(SUM(t.duration_minutes) FILTER (WHERE t.entry_type = 'besprechung'), 0) AS besprechung_minutes,
          COALESCE(SUM(t.duration_minutes) FILTER (WHERE t.entry_type = 'vertrieb'), 0) AS vertrieb_minutes,
          COALESCE(SUM(t.duration_minutes) FILTER (WHERE t.entry_type = 'sonstiges'), 0) AS sonstiges_minutes,
          COALESCE(SUM(t.duration_minutes) FILTER (WHERE t.entry_type = 'schulung'), 0) AS weiterbildung_minutes
        FROM employee_time_entries t
        WHERE t.deleted_at IS NULL
          AND EXTRACT(YEAR FROM t.entry_date::date) = ${year}
        GROUP BY EXTRACT(MONTH FROM t.entry_date::date)
      ) te ON te.m = m.month
      ORDER BY m.month
    `),

    // 6. Pflegegrad distribution
    db.execute(sql`
      SELECT
        COALESCE(c.pflegegrad, 0)::int AS pflegegrad,
        COUNT(*)::int AS count
      FROM customers c
      WHERE c.status = 'aktiv' AND c.deleted_at IS NULL
      GROUP BY c.pflegegrad
      ORDER BY c.pflegegrad NULLS FIRST
    `),

    // 7. Budget utilization (§45b) – consumption amounts are stored as negative, use ABS()
    db.execute(sql`
      SELECT
        COALESCE(SUM(ba.amount_cents), 0)::bigint AS "totalAllocatedCents",
        COALESCE(ABS((
          SELECT SUM(bt.amount_cents)
          FROM budget_transactions bt
          WHERE bt.budget_type = 'entlastungsbetrag_45b'
            AND EXTRACT(YEAR FROM bt.transaction_date::date) = ${year}
            AND bt.transaction_type = 'consumption'
        )), 0)::bigint AS "totalUsedCents"
      FROM budget_allocations ba
      WHERE ba.budget_type = 'entlastungsbetrag_45b'
        AND ba.year = ${year}
    `),
  ]);

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
  });
}));

// Top customers by revenue
router.get("/top-customers", asyncHandler("Top-Kunden konnten nicht geladen werden", async (req, res) => {
  if (!req.user!.isAdmin) throw forbidden("FORBIDDEN", "Nur für Administratoren");

  const year = parseInt(req.query.year as string) || new Date().getFullYear();

  const result = await db.execute(sql`
    SELECT
      c.id,
      c.name,
      c.pflegegrad,
      COALESCE(SUM(i.gross_amount_cents), 0)::bigint AS "revenueCents",
      COUNT(DISTINCT i.id)::int AS "invoiceCount",
      (
        SELECT COUNT(*)
        FROM appointments a
        WHERE a.customer_id = c.id
          AND a.deleted_at IS NULL
          AND a.status IN ('completed', 'documented')
          AND EXTRACT(YEAR FROM a.date::date) = ${year}
      )::int AS "appointmentCount"
    FROM customers c
    LEFT JOIN invoices i ON i.customer_id = c.id
      AND i.billing_year = ${year}
      AND i.status != 'storniert'
      AND i.invoice_type != 'stornorechnung'
    WHERE c.deleted_at IS NULL AND c.status = 'aktiv'
    GROUP BY c.id, c.name, c.pflegegrad
    ORDER BY "revenueCents" DESC
    LIMIT 20
  `);

  res.json(result.rows);
}));

router.get("/profitability", asyncHandler("Deckungsbeitrag konnte nicht berechnet werden", async (req, res) => {
  if (!req.user!.isAdmin) throw forbidden("FORBIDDEN", "Nur für Administratoren");

  const year = parseInt(req.query.year as string) || new Date().getFullYear();
  const month = req.query.month ? parseInt(req.query.month as string) : null;

  const monthFilter = month
    ? sql`AND EXTRACT(MONTH FROM a.date::date) = ${month}`
    : sql``;

  const result = await db.execute(sql`
    WITH active_customer_prices AS (
      SELECT csp.customer_id, csp.service_id, csp.price_cents
      FROM customer_service_prices csp
      WHERE csp.valid_to IS NULL
    ),
    filtered_appointments AS (
      SELECT
        a.id,
        a.customer_id,
        COALESCE(a.performed_by_employee_id, a.assigned_employee_id) AS employee_id,
        a.duration_promised,
        COALESCE(a.travel_kilometers, 0) AS travel_km,
        COALESCE(a.customer_kilometers, 0) AS customer_km
      FROM appointments a
      WHERE a.deleted_at IS NULL
        AND a.status IN ('completed', 'documented')
        AND a.appointment_type != 'Erstberatung'
        AND EXTRACT(YEAR FROM a.date::date) = ${year}
        ${monthFilter}
    ),
    service_line_calc AS (
      SELECT
        fa.id AS appointment_id,
        fa.employee_id,
        fa.customer_id,
        COALESCE(asvc.actual_duration_minutes, asvc.planned_duration_minutes) AS duration_minutes,
        COALESCE(acp.price_cents, s.default_price_cents) AS hourly_price,
        s.employee_rate_cents AS hourly_cost
      FROM filtered_appointments fa
      JOIN appointment_services asvc ON asvc.appointment_id = fa.id
      JOIN services s ON s.id = asvc.service_id
      LEFT JOIN active_customer_prices acp ON acp.customer_id = fa.customer_id AND acp.service_id = s.id
      WHERE s.unit_type = 'hours'
    ),
    service_totals AS (
      SELECT
        slc.appointment_id,
        slc.employee_id,
        slc.customer_id,
        SUM(slc.duration_minutes)::int AS total_service_minutes,
        SUM(ROUND(slc.duration_minutes / 60.0 * slc.hourly_price))::bigint AS revenue_service_cents,
        SUM(ROUND(slc.duration_minutes / 60.0 * slc.hourly_cost))::bigint AS cost_service_cents
      FROM service_line_calc slc
      GROUP BY slc.appointment_id, slc.employee_id, slc.customer_id
    ),
    per_appointment AS (
      SELECT
        fa.id,
        fa.customer_id,
        fa.employee_id,
        fa.duration_promised,
        fa.travel_km,
        fa.customer_km,
        COALESCE(st.total_service_minutes, fa.duration_promised) AS service_minutes,
        COALESCE(st.revenue_service_cents, 0) AS revenue_service_cents,
        COALESCE(st.cost_service_cents, 0) AS cost_service_cents,
        ROUND(fa.travel_km * COALESCE(
          (SELECT acp.price_cents FROM active_customer_prices acp
           JOIN services sp ON sp.id = acp.service_id AND sp.code = 'travel_km'
           WHERE acp.customer_id = fa.customer_id),
          (SELECT default_price_cents FROM services WHERE code = 'travel_km')
        )) AS revenue_km_cents,
        ROUND(fa.travel_km * (SELECT employee_rate_cents FROM services WHERE code = 'travel_km')) AS cost_km_cents,
        ROUND(fa.customer_km * COALESCE(
          (SELECT acp.price_cents FROM active_customer_prices acp
           JOIN services sp ON sp.id = acp.service_id AND sp.code = 'customer_km'
           WHERE acp.customer_id = fa.customer_id),
          (SELECT default_price_cents FROM services WHERE code = 'customer_km')
        )) AS revenue_ckm_cents,
        ROUND(fa.customer_km * (SELECT employee_rate_cents FROM services WHERE code = 'customer_km')) AS cost_ckm_cents
      FROM filtered_appointments fa
      LEFT JOIN service_totals st ON st.appointment_id = fa.id
    )
    SELECT
      u.id AS "employeeId",
      u.display_name AS "employeeName",
      COUNT(pa.id)::int AS appointments,
      COUNT(DISTINCT pa.customer_id)::int AS customers,
      COALESCE(SUM(pa.service_minutes), 0)::int AS "totalMinutes",
      COALESCE(SUM(pa.travel_km), 0)::numeric(10,1) AS "totalTravelKm",
      COALESCE(SUM(pa.customer_km), 0)::numeric(10,1) AS "totalCustomerKm",
      COALESCE(SUM(pa.revenue_service_cents + pa.revenue_km_cents + pa.revenue_ckm_cents), 0)::bigint AS "revenueCents",
      COALESCE(SUM(pa.cost_service_cents + pa.cost_km_cents + pa.cost_ckm_cents), 0)::bigint AS "costCents",
      COALESCE(SUM(
        (pa.revenue_service_cents + pa.revenue_km_cents + pa.revenue_ckm_cents) -
        (pa.cost_service_cents + pa.cost_km_cents + pa.cost_ckm_cents)
      ), 0)::bigint AS "marginCents",
      COALESCE(SUM(pa.revenue_service_cents), 0)::bigint AS "revenueServiceCents",
      COALESCE(SUM(pa.revenue_km_cents + pa.revenue_ckm_cents), 0)::bigint AS "revenueKmCents",
      COALESCE(SUM(pa.cost_service_cents), 0)::bigint AS "costServiceCents",
      COALESCE(SUM(pa.cost_km_cents + pa.cost_ckm_cents), 0)::bigint AS "costKmCents"
    FROM users u
    LEFT JOIN per_appointment pa ON pa.employee_id = u.id
    WHERE u.is_active = true AND u.is_anonymized = false
    GROUP BY u.id, u.display_name
    HAVING COUNT(pa.id) > 0
    ORDER BY "marginCents" DESC
  `);

  interface ProfitabilityTotals {
    appointments: number;
    customers: number;
    totalMinutes: number;
    totalTravelKm: number;
    totalCustomerKm: number;
    revenueCents: number;
    costCents: number;
    marginCents: number;
    revenueServiceCents: number;
    revenueKmCents: number;
    costServiceCents: number;
    costKmCents: number;
  }

  const totals = result.rows.reduce<ProfitabilityTotals>((acc, r: Record<string, unknown>) => ({
    appointments: acc.appointments + Number(r.appointments),
    customers: acc.customers + Number(r.customers),
    totalMinutes: acc.totalMinutes + Number(r.totalMinutes),
    totalTravelKm: acc.totalTravelKm + Number(r.totalTravelKm),
    totalCustomerKm: acc.totalCustomerKm + Number(r.totalCustomerKm),
    revenueCents: acc.revenueCents + Number(r.revenueCents),
    costCents: acc.costCents + Number(r.costCents),
    marginCents: acc.marginCents + Number(r.marginCents),
    revenueServiceCents: acc.revenueServiceCents + Number(r.revenueServiceCents),
    revenueKmCents: acc.revenueKmCents + Number(r.revenueKmCents),
    costServiceCents: acc.costServiceCents + Number(r.costServiceCents),
    costKmCents: acc.costKmCents + Number(r.costKmCents),
  }), {
    appointments: 0, customers: 0, totalMinutes: 0, totalTravelKm: 0, totalCustomerKm: 0,
    revenueCents: 0, costCents: 0, marginCents: 0,
    revenueServiceCents: 0, revenueKmCents: 0, costServiceCents: 0, costKmCents: 0,
  });

  const uniqueCustomers = await db.execute(sql`
    SELECT COUNT(DISTINCT a.customer_id)::int AS count
    FROM appointments a
    WHERE a.deleted_at IS NULL
      AND a.status IN ('completed', 'documented')
      AND EXTRACT(YEAR FROM a.date::date) = ${year}
      ${monthFilter}
  `);
  totals.customers = Number(uniqueCustomers.rows[0]?.count || 0);

  const servicePrices = await db.execute(sql`
    SELECT code, default_price_cents AS "priceCents", employee_rate_cents AS "rateCents"
    FROM services WHERE code IN ('hauswirtschaft', 'alltagsbegleitung', 'travel_km', 'customer_km')
  `);

  res.json({
    employees: result.rows,
    totals,
    servicePrices: servicePrices.rows,
    marginPercent: Number(totals.revenueCents) > 0
      ? Math.round((Number(totals.marginCents) / Number(totals.revenueCents)) * 100)
      : 0,
  });
}));

router.get("/planning", asyncHandler("Planungsdaten konnten nicht geladen werden", async (req, res) => {
  if (!req.user!.isAdmin) throw forbidden("FORBIDDEN", "Nur für Administratoren");

  const year = parseInt(req.query.year as string) || new Date().getFullYear();
  const monthRaw = req.query.month ? parseInt(req.query.month as string) : null;
  const month = monthRaw && monthRaw >= 1 && monthRaw <= 12 ? monthRaw : null;

  const monthFilter = month
    ? sql`AND EXTRACT(MONTH FROM a.date::date) = ${month}`
    : sql``;

  const result = await db.execute(sql`
    WITH active_customer_prices AS (
      SELECT csp.customer_id, csp.service_id, csp.price_cents
      FROM customer_service_prices csp
      WHERE csp.valid_to IS NULL
    ),
    filtered_appointments AS (
      SELECT
        a.id,
        a.customer_id,
        COALESCE(a.assigned_employee_id, a.performed_by_employee_id) AS employee_id,
        a.status,
        a.duration_promised,
        COALESCE(a.travel_kilometers, 0) AS travel_km,
        COALESCE(a.customer_kilometers, 0) AS customer_km
      FROM appointments a
      WHERE a.deleted_at IS NULL
        AND a.status != 'cancelled'
        AND a.appointment_type != 'Erstberatung'
        AND EXTRACT(YEAR FROM a.date::date) = ${year}
        ${monthFilter}
    ),
    service_line_calc AS (
      SELECT
        fa.id AS appointment_id,
        fa.employee_id,
        fa.customer_id,
        COALESCE(asvc.actual_duration_minutes, asvc.planned_duration_minutes) AS duration_minutes,
        COALESCE(acp.price_cents, s.default_price_cents) AS hourly_price,
        s.employee_rate_cents AS hourly_cost
      FROM filtered_appointments fa
      JOIN appointment_services asvc ON asvc.appointment_id = fa.id
      JOIN services s ON s.id = asvc.service_id
      LEFT JOIN active_customer_prices acp ON acp.customer_id = fa.customer_id AND acp.service_id = s.id
      WHERE s.unit_type = 'hours'
    ),
    service_totals AS (
      SELECT
        slc.appointment_id,
        slc.employee_id,
        slc.customer_id,
        SUM(slc.duration_minutes)::int AS total_service_minutes,
        SUM(ROUND(slc.duration_minutes / 60.0 * slc.hourly_price))::bigint AS revenue_service_cents,
        SUM(ROUND(slc.duration_minutes / 60.0 * slc.hourly_cost))::bigint AS cost_service_cents
      FROM service_line_calc slc
      GROUP BY slc.appointment_id, slc.employee_id, slc.customer_id
    ),
    per_appointment AS (
      SELECT
        fa.id,
        fa.customer_id,
        fa.employee_id,
        fa.status,
        fa.duration_promised,
        fa.travel_km,
        fa.customer_km,
        COALESCE(st.total_service_minutes, fa.duration_promised) AS service_minutes,
        COALESCE(st.revenue_service_cents, 0) AS revenue_service_cents,
        COALESCE(st.cost_service_cents, 0) AS cost_service_cents,
        ROUND(fa.travel_km * COALESCE(
          (SELECT acp.price_cents FROM active_customer_prices acp
           JOIN services sp ON sp.id = acp.service_id AND sp.code = 'travel_km'
           WHERE acp.customer_id = fa.customer_id),
          (SELECT default_price_cents FROM services WHERE code = 'travel_km')
        )) AS revenue_km_cents,
        ROUND(fa.travel_km * (SELECT employee_rate_cents FROM services WHERE code = 'travel_km')) AS cost_km_cents,
        ROUND(fa.customer_km * COALESCE(
          (SELECT acp.price_cents FROM active_customer_prices acp
           JOIN services sp ON sp.id = acp.service_id AND sp.code = 'customer_km'
           WHERE acp.customer_id = fa.customer_id),
          (SELECT default_price_cents FROM services WHERE code = 'customer_km')
        )) AS revenue_ckm_cents,
        ROUND(fa.customer_km * (SELECT employee_rate_cents FROM services WHERE code = 'customer_km')) AS cost_ckm_cents
      FROM filtered_appointments fa
      LEFT JOIN service_totals st ON st.appointment_id = fa.id
    )
    SELECT
      u.id AS "employeeId",
      u.display_name AS "employeeName",
      COUNT(pa.id)::int AS appointments,
      COUNT(pa.id) FILTER (WHERE pa.status = 'scheduled')::int AS "scheduledCount",
      COUNT(pa.id) FILTER (WHERE pa.status = 'completed')::int AS "completedCount",
      COUNT(pa.id) FILTER (WHERE pa.status = 'documented')::int AS "documentedCount",
      COUNT(DISTINCT pa.customer_id)::int AS customers,
      COALESCE(SUM(pa.service_minutes), 0)::int AS "totalMinutes",
      COALESCE(SUM(pa.travel_km), 0)::numeric(10,1) AS "totalTravelKm",
      COALESCE(SUM(pa.customer_km), 0)::numeric(10,1) AS "totalCustomerKm",
      COALESCE(SUM(pa.revenue_service_cents + pa.revenue_km_cents + pa.revenue_ckm_cents), 0)::bigint AS "revenueCents",
      COALESCE(SUM(pa.cost_service_cents + pa.cost_km_cents + pa.cost_ckm_cents), 0)::bigint AS "costCents",
      COALESCE(SUM(
        (pa.revenue_service_cents + pa.revenue_km_cents + pa.revenue_ckm_cents) -
        (pa.cost_service_cents + pa.cost_km_cents + pa.cost_ckm_cents)
      ), 0)::bigint AS "marginCents",
      COALESCE(SUM(pa.revenue_service_cents), 0)::bigint AS "revenueServiceCents",
      COALESCE(SUM(pa.revenue_km_cents + pa.revenue_ckm_cents), 0)::bigint AS "revenueKmCents",
      COALESCE(SUM(pa.cost_service_cents), 0)::bigint AS "costServiceCents",
      COALESCE(SUM(pa.cost_km_cents + pa.cost_ckm_cents), 0)::bigint AS "costKmCents"
    FROM users u
    LEFT JOIN per_appointment pa ON pa.employee_id = u.id
    WHERE u.is_active = true AND u.is_anonymized = false
    GROUP BY u.id, u.display_name
    HAVING COUNT(pa.id) > 0
    ORDER BY "marginCents" DESC
  `);

  interface PlanningTotals {
    appointments: number;
    scheduledCount: number;
    completedCount: number;
    documentedCount: number;
    customers: number;
    totalMinutes: number;
    revenueCents: number;
    costCents: number;
    marginCents: number;
    revenueServiceCents: number;
    revenueKmCents: number;
    costServiceCents: number;
    costKmCents: number;
  }

  const totals = result.rows.reduce<PlanningTotals>((acc, r: Record<string, unknown>) => ({
    appointments: acc.appointments + Number(r.appointments),
    scheduledCount: acc.scheduledCount + Number(r.scheduledCount),
    completedCount: acc.completedCount + Number(r.completedCount),
    documentedCount: acc.documentedCount + Number(r.documentedCount),
    customers: acc.customers + Number(r.customers),
    totalMinutes: acc.totalMinutes + Number(r.totalMinutes),
    revenueCents: acc.revenueCents + Number(r.revenueCents),
    costCents: acc.costCents + Number(r.costCents),
    marginCents: acc.marginCents + Number(r.marginCents),
    revenueServiceCents: acc.revenueServiceCents + Number(r.revenueServiceCents),
    revenueKmCents: acc.revenueKmCents + Number(r.revenueKmCents),
    costServiceCents: acc.costServiceCents + Number(r.costServiceCents),
    costKmCents: acc.costKmCents + Number(r.costKmCents),
  }), {
    appointments: 0, scheduledCount: 0, completedCount: 0, documentedCount: 0, customers: 0, totalMinutes: 0,
    revenueCents: 0, costCents: 0, marginCents: 0,
    revenueServiceCents: 0, revenueKmCents: 0, costServiceCents: 0, costKmCents: 0,
  });

  const uniqueCustomers = await db.execute(sql`
    SELECT COUNT(DISTINCT a.customer_id)::int AS count
    FROM appointments a
    WHERE a.deleted_at IS NULL
      AND a.status != 'cancelled'
      AND a.appointment_type != 'Erstberatung'
      AND EXTRACT(YEAR FROM a.date::date) = ${year}
      ${monthFilter}
  `);
  totals.customers = Number(uniqueCustomers.rows[0]?.count || 0);

  const customersWithoutAppointments = await db.execute(sql`
    SELECT
      c.id,
      c.name,
      c.vorname,
      c.nachname,
      c.pflegegrad,
      u.display_name AS "primaryEmployeeName"
    FROM customers c
    LEFT JOIN users u ON u.id = c.primary_employee_id
    WHERE c.status = 'aktiv'
      AND c.deleted_at IS NULL
      AND c.id NOT IN (
        SELECT DISTINCT a.customer_id
        FROM appointments a
        WHERE a.deleted_at IS NULL
          AND a.status != 'cancelled'
          AND a.appointment_type != 'Erstberatung'
          AND EXTRACT(YEAR FROM a.date::date) = ${year}
          ${monthFilter}
      )
    ORDER BY c.name
  `);

  const servicePrices = await db.execute(sql`
    SELECT code, default_price_cents AS "priceCents", employee_rate_cents AS "rateCents"
    FROM services WHERE code IN ('hauswirtschaft', 'alltagsbegleitung', 'travel_km', 'customer_km')
  `);

  res.json({
    employees: result.rows,
    totals,
    servicePrices: servicePrices.rows,
    marginPercent: Number(totals.revenueCents) > 0
      ? Math.round((Number(totals.marginCents) / Number(totals.revenueCents)) * 100)
      : 0,
    customersWithoutAppointments: customersWithoutAppointments.rows,
  });
}));

router.get("/growth", asyncHandler("Wachstums-Statistiken konnten nicht geladen werden", async (req, res) => {
  if (!req.user!.isAdmin) throw forbidden("FORBIDDEN", "Nur für Administratoren");

  const year = parseInt(req.query.year as string) || new Date().getFullYear();

  const [
    hoursByServiceType,
    hoursByEntryType,
    customerLifecycle,
    customerGrowth,
    prevYearCustomers,
  ] = await Promise.all([
    db.execute(sql`
      SELECT
        a.service_type,
        COUNT(*)::int AS count,
        COALESCE(SUM(a.duration_promised), 0)::int AS total_minutes
      FROM appointments a
      WHERE a.deleted_at IS NULL
        AND a.status IN ('completed', 'documented')
        AND EXTRACT(YEAR FROM a.date::date) = ${year}
      GROUP BY a.service_type
      ORDER BY total_minutes DESC
    `),

    db.execute(sql`
      SELECT
        t.entry_type,
        COUNT(*)::int AS count,
        COALESCE(SUM(t.duration_minutes), 0)::int AS total_minutes
      FROM employee_time_entries t
      WHERE t.deleted_at IS NULL
        AND EXTRACT(YEAR FROM t.entry_date::date) = ${year}
      GROUP BY t.entry_type
      ORDER BY total_minutes DESC
    `),

    db.execute(sql`
      SELECT
        m.month::int AS month,
        COALESCE(gained.cnt, 0)::int AS "customersGained",
        COALESCE(lost.cnt, 0)::int AS "customersLost"
      FROM generate_series(1, 12) AS m(month)
      LEFT JOIN (
        SELECT EXTRACT(MONTH FROM c.created_at)::int AS m, COUNT(*) AS cnt
        FROM customers c
        WHERE c.deleted_at IS NULL
          AND c.status IN ('aktiv', 'inaktiv', 'gekuendigt')
          AND EXTRACT(YEAR FROM c.created_at) = ${year}
        GROUP BY EXTRACT(MONTH FROM c.created_at)
      ) gained ON gained.m = m.month
      LEFT JOIN (
        SELECT EXTRACT(MONTH FROM c.inaktiv_ab::date)::int AS m, COUNT(*) AS cnt
        FROM customers c
        WHERE c.deleted_at IS NULL
          AND c.inaktiv_ab IS NOT NULL
          AND EXTRACT(YEAR FROM c.inaktiv_ab::date) = ${year}
        GROUP BY EXTRACT(MONTH FROM c.inaktiv_ab::date)
      ) lost ON lost.m = m.month
      ORDER BY m.month
    `),

    db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE c.status = 'aktiv' AND c.deleted_at IS NULL)::int AS "activeNow",
        COUNT(*) FILTER (WHERE c.deleted_at IS NULL AND EXTRACT(YEAR FROM c.created_at) = ${year})::int AS "gainedThisYear",
        COUNT(*) FILTER (WHERE c.deleted_at IS NULL AND c.inaktiv_ab IS NOT NULL AND EXTRACT(YEAR FROM c.inaktiv_ab::date) = ${year})::int AS "lostThisYear"
      FROM customers c
    `),

    db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE c.deleted_at IS NULL AND EXTRACT(YEAR FROM c.created_at) = ${year - 1})::int AS "gainedPrevYear",
        COUNT(*) FILTER (WHERE c.deleted_at IS NULL AND c.inaktiv_ab IS NOT NULL AND EXTRACT(YEAR FROM c.inaktiv_ab::date) = ${year - 1})::int AS "lostPrevYear"
      FROM customers c
    `),
  ]);

  const growth = customerGrowth.rows[0] as any;
  const prevYear = prevYearCustomers.rows[0] as any;

  res.json({
    year,
    hoursByServiceType: hoursByServiceType.rows,
    hoursByEntryType: hoursByEntryType.rows,
    customerLifecycle: customerLifecycle.rows,
    summary: {
      activeCustomers: growth?.activeNow ?? 0,
      gainedThisYear: growth?.gainedThisYear ?? 0,
      lostThisYear: growth?.lostThisYear ?? 0,
      netGrowth: (growth?.gainedThisYear ?? 0) - (growth?.lostThisYear ?? 0),
      gainedPrevYear: prevYear?.gainedPrevYear ?? 0,
      lostPrevYear: prevYear?.lostPrevYear ?? 0,
    },
  });
}));

router.post("/repair-appointment-types", asyncHandler("Datenbereinigung der Termintypen fehlgeschlagen", async (req, res) => {
  if (!req.user!.isAdmin) throw forbidden("FORBIDDEN", "Nur Admins dürfen diese Aktion ausführen");

  const result = await db.execute(sql`
    UPDATE appointments SET appointment_type = 'Kundentermin'
    WHERE appointment_type = 'service' AND deleted_at IS NULL
  `);

  const count = result.rowCount ?? 0;
  console.log(`[REPAIR] appointment_type 'service' -> 'Kundentermin': ${count} updated`);
  res.json({ updated: count });
}));

router.post("/repair-appointment-services", asyncHandler("Reparatur der Termin-Services fehlgeschlagen", async (req, res) => {
  if (!req.user!.isAdmin) throw forbidden("FORBIDDEN", "Nur Admins dürfen diese Aktion ausführen");

  const dryRun = req.query.dryRun === "true";

  const missing = await db.execute(sql`
    SELECT a.id AS appointment_id, a.service_type, a.duration_promised
    FROM appointments a
    WHERE a.deleted_at IS NULL
      AND a.status IN ('completed', 'documented')
      AND NOT EXISTS (SELECT 1 FROM appointment_services asvc WHERE asvc.appointment_id = a.id)
      AND a.service_type IS NOT NULL
  `);

  const serviceMap = await db.execute(sql`SELECT id, code FROM services WHERE unit_type = 'hours'`);
  const codeToId: Record<string, number> = {};
  for (const s of serviceMap.rows as { id: number; code: string }[]) {
    codeToId[s.code] = s.id;
  }

  const toInsert: { appointmentId: number; serviceId: number; planned: number; actual: number | null }[] = [];
  const skipped: { appointmentId: number; reason: string }[] = [];

  for (const row of missing.rows as { appointment_id: number; service_type: string; duration_promised: number | null }[]) {
    const serviceId = codeToId[row.service_type];
    if (!serviceId) {
      skipped.push({ appointmentId: row.appointment_id, reason: `Unknown service_type: ${row.service_type}` });
      continue;
    }
    toInsert.push({
      appointmentId: row.appointment_id,
      serviceId,
      planned: row.duration_promised || 60,
      actual: null,
    });
  }

  let inserted = 0;
  if (!dryRun && toInsert.length > 0) {
    for (const item of toInsert) {
      await db.execute(sql`
        INSERT INTO appointment_services (appointment_id, service_id, planned_duration_minutes, actual_duration_minutes)
        VALUES (${item.appointmentId}, ${item.serviceId}, ${item.planned}, ${item.actual})
      `);
      inserted++;
    }
  }

  console.log(`[REPAIR] dryRun=${dryRun} | found=${missing.rows.length} missing | toInsert=${toInsert.length} | skipped=${skipped.length} | inserted=${inserted}`);

  res.json({
    dryRun,
    found: missing.rows.length,
    toInsert: toInsert.length,
    skipped,
    inserted,
    serviceMap: codeToId,
  });
}));

export default router;
