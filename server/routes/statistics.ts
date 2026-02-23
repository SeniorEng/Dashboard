import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { asyncHandler, forbidden } from "../lib/errors";
import { db } from "../lib/db";
import { sql } from "drizzle-orm";

const router = Router();
router.use(requireAuth);

router.get("/overview", asyncHandler("Statistiken konnten nicht geladen werden", async (req, res) => {
  if (!req.user!.isAdmin) throw forbidden("Nur für Administratoren");

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
        COUNT(*) FILTER (WHERE a.status IN ('completed', 'documented'))::int AS "completedAppointments",
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

    // 5. Monthly Trends (revenue + appointments per month)
    db.execute(sql`
      SELECT
        m.month::int AS month,
        COALESCE(inv.revenue_cents, 0)::bigint AS "revenueCents",
        COALESCE(inv.invoice_count, 0)::int AS "invoiceCount",
        COALESCE(apt.appointment_count, 0)::int AS "appointmentCount",
        COALESCE(apt.completed_count, 0)::int AS "completedCount",
        COALESCE(apt.cancelled_count, 0)::int AS "cancelledCount",
        COALESCE(apt.unique_customers, 0)::int AS "activeCustomers"
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
          COUNT(*) FILTER (WHERE a.status = 'cancelled') AS cancelled_count,
          COUNT(DISTINCT a.customer_id) FILTER (WHERE a.status IN ('completed', 'documented')) AS unique_customers
        FROM appointments a
        WHERE a.deleted_at IS NULL
          AND EXTRACT(YEAR FROM a.date::date) = ${year}
        GROUP BY EXTRACT(MONTH FROM a.date::date)
      ) apt ON apt.m = m.month
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
  if (!req.user!.isAdmin) throw forbidden("Nur für Administratoren");

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

export default router;
