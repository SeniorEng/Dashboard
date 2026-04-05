import { Router } from "express";
import { asyncHandler, forbidden } from "../../lib/errors";
import { db } from "../../lib/db";
import { sql } from "drizzle-orm";

const router = Router();

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
    WITH filtered_appointments AS (
      SELECT
        a.id,
        a.customer_id,
        a.date::date AS appt_date,
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
    km_defaults AS (
      SELECT
        code,
        default_price_cents,
        employee_rate_cents
      FROM services
      WHERE code IN ('travel_km', 'customer_km')
    ),
    service_line_calc AS (
      SELECT
        fa.id AS appointment_id,
        fa.employee_id,
        fa.customer_id,
        COALESCE(asvc.actual_duration_minutes, asvc.planned_duration_minutes) AS duration_minutes,
        COALESCE(csp_svc.price_cents, s.default_price_cents) AS hourly_price,
        s.employee_rate_cents AS hourly_cost
      FROM filtered_appointments fa
      JOIN appointment_services asvc ON asvc.appointment_id = fa.id
      JOIN services s ON s.id = asvc.service_id
      LEFT JOIN LATERAL (
        SELECT csp.price_cents
        FROM customer_service_prices csp
        WHERE csp.customer_id = fa.customer_id
          AND csp.service_id = s.id
          AND csp.deleted_at IS NULL
          AND csp.valid_from::date <= fa.appt_date
          AND (csp.valid_to IS NULL OR csp.valid_to::date >= fa.appt_date)
        ORDER BY csp.valid_from DESC
        LIMIT 1
      ) csp_svc ON true
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
        ROUND(fa.travel_km * COALESCE(csp_tkm.price_cents, tkm.default_price_cents)) AS revenue_km_cents,
        ROUND(fa.travel_km * tkm.employee_rate_cents) AS cost_km_cents,
        ROUND(fa.customer_km * COALESCE(csp_ckm.price_cents, ckm.default_price_cents)) AS revenue_ckm_cents,
        ROUND(fa.customer_km * ckm.employee_rate_cents) AS cost_ckm_cents
      FROM filtered_appointments fa
      LEFT JOIN service_totals st ON st.appointment_id = fa.id
      LEFT JOIN km_defaults tkm ON tkm.code = 'travel_km'
      LEFT JOIN km_defaults ckm ON ckm.code = 'customer_km'
      LEFT JOIN LATERAL (
        SELECT csp.price_cents
        FROM customer_service_prices csp
        JOIN services sp ON sp.id = csp.service_id AND sp.code = 'travel_km'
        WHERE csp.customer_id = fa.customer_id
          AND csp.deleted_at IS NULL
          AND csp.valid_from::date <= fa.appt_date
          AND (csp.valid_to IS NULL OR csp.valid_to::date >= fa.appt_date)
        ORDER BY csp.valid_from DESC
        LIMIT 1
      ) csp_tkm ON true
      LEFT JOIN LATERAL (
        SELECT csp.price_cents
        FROM customer_service_prices csp
        JOIN services sp ON sp.id = csp.service_id AND sp.code = 'customer_km'
        WHERE csp.customer_id = fa.customer_id
          AND csp.deleted_at IS NULL
          AND csp.valid_from::date <= fa.appt_date
          AND (csp.valid_to IS NULL OR csp.valid_to::date >= fa.appt_date)
        ORDER BY csp.valid_from DESC
        LIMIT 1
      ) csp_ckm ON true
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

export default router;
