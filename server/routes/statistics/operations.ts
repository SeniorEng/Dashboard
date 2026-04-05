import { Router } from "express";
import { asyncHandler, forbidden } from "../../lib/errors";
import { db } from "../../lib/db";
import { sql } from "drizzle-orm";

const router = Router();

const MONTH_NAMES_DE = [
  "", "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember",
];

router.get("/planning", asyncHandler("Planungsdaten konnten nicht geladen werden", async (req, res) => {
  if (!req.user!.isAdmin) throw forbidden("FORBIDDEN", "Nur für Administratoren");

  const year = parseInt(req.query.year as string) || new Date().getFullYear();
  const monthRaw = req.query.month ? parseInt(req.query.month as string) : null;
  const month = monthRaw && monthRaw >= 1 && monthRaw <= 12 ? monthRaw : null;

  const monthFilter = month
    ? sql`AND EXTRACT(MONTH FROM a.date::date) = ${month}`
    : sql``;

  const result = await db.execute(sql`
    WITH filtered_appointments AS (
      SELECT
        a.id,
        a.customer_id,
        a.date::date AS appt_date,
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
        COALESCE(
          (SELECT csp.price_cents FROM customer_service_prices csp
           WHERE csp.customer_id = fa.customer_id AND csp.service_id = s.id
             AND csp.deleted_at IS NULL
             AND csp.valid_from::date <= fa.appt_date AND (csp.valid_to IS NULL OR csp.valid_to::date >= fa.appt_date)
           ORDER BY csp.valid_from DESC LIMIT 1),
          s.default_price_cents
        ) AS hourly_price,
        s.employee_rate_cents AS hourly_cost
      FROM filtered_appointments fa
      JOIN appointment_services asvc ON asvc.appointment_id = fa.id
      JOIN services s ON s.id = asvc.service_id
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
          (SELECT csp.price_cents FROM customer_service_prices csp
           JOIN services sp ON sp.id = csp.service_id AND sp.code = 'travel_km'
           WHERE csp.customer_id = fa.customer_id
             AND csp.deleted_at IS NULL
             AND csp.valid_from::date <= fa.appt_date AND (csp.valid_to IS NULL OR csp.valid_to::date >= fa.appt_date)
           ORDER BY csp.valid_from DESC LIMIT 1),
          (SELECT default_price_cents FROM services WHERE code = 'travel_km')
        )) AS revenue_km_cents,
        ROUND(fa.travel_km * (SELECT employee_rate_cents FROM services WHERE code = 'travel_km')) AS cost_km_cents,
        ROUND(fa.customer_km * COALESCE(
          (SELECT csp.price_cents FROM customer_service_prices csp
           JOIN services sp ON sp.id = csp.service_id AND sp.code = 'customer_km'
           WHERE csp.customer_id = fa.customer_id
             AND csp.deleted_at IS NULL
             AND csp.valid_from::date <= fa.appt_date AND (csp.valid_to IS NULL OR csp.valid_to::date >= fa.appt_date)
           ORDER BY csp.valid_from DESC LIMIT 1),
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

router.get("/alerts", asyncHandler("Handlungsbedarf konnte nicht geladen werden", async (req, res) => {
  if (!req.user!.isAdmin) throw forbidden("FORBIDDEN", "Nur für Administratoren");

  const now = new Date();
  const curYear = now.getFullYear();
  const curMonth = now.getMonth() + 1;
  const prevM = curMonth === 1 ? 12 : curMonth - 1;
  const prevMYear = curMonth === 1 ? curYear - 1 : curYear;
  const threeDaysAgoDate = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
  const threeDaysAgo = `${threeDaysAgoDate.getFullYear()}-${String(threeDaysAgoDate.getMonth() + 1).padStart(2, "0")}-${String(threeDaysAgoDate.getDate()).padStart(2, "0")}`;

  const [undocumented, budgetOverspend, noAppointments, missingRecords, newCustomers] = await Promise.all([
    db.execute(sql`
      SELECT COUNT(*)::int AS count
      FROM appointments a
      WHERE a.deleted_at IS NULL
        AND a.status = 'completed'
        AND a.date::date < ${threeDaysAgo}::date
    `),

    db.execute(sql`
      SELECT COUNT(DISTINCT sub.customer_id)::int AS count
      FROM (
        SELECT ba.customer_id,
          COALESCE(SUM(ba.amount_cents), 0) AS allocated,
          COALESCE(ABS((
            SELECT SUM(bt.amount_cents)
            FROM budget_transactions bt
            WHERE bt.customer_id = ba.customer_id
              AND bt.budget_type = 'entlastungsbetrag_45b'
              AND bt.transaction_type = 'consumption'
              AND EXTRACT(YEAR FROM bt.transaction_date::date) = ${curYear}
          )), 0) AS used
        FROM budget_allocations ba
        WHERE ba.budget_type = 'entlastungsbetrag_45b'
          AND ba.year = ${curYear}
        GROUP BY ba.customer_id
        HAVING COALESCE(ABS((
          SELECT SUM(bt.amount_cents)
          FROM budget_transactions bt
          WHERE bt.customer_id = ba.customer_id
            AND bt.budget_type = 'entlastungsbetrag_45b'
            AND bt.transaction_type = 'consumption'
            AND EXTRACT(YEAR FROM bt.transaction_date::date) = ${curYear}
        )), 0) > COALESCE(SUM(ba.amount_cents), 0)
      ) sub
    `),

    db.execute(sql`
      SELECT COUNT(*)::int AS count
      FROM customers c
      WHERE c.status = 'aktiv' AND c.deleted_at IS NULL
        AND c.id NOT IN (
          SELECT DISTINCT a.customer_id
          FROM appointments a
          WHERE a.deleted_at IS NULL
            AND a.status != 'cancelled'
            AND EXTRACT(YEAR FROM a.date::date) = ${curYear}
            AND EXTRACT(MONTH FROM a.date::date) = ${curMonth}
        )
    `),

    db.execute(sql`
      SELECT COUNT(DISTINCT sub.customer_id)::int AS count
      FROM (
        SELECT DISTINCT a.customer_id
        FROM appointments a
        WHERE a.deleted_at IS NULL
          AND a.status IN ('completed','documented')
          AND EXTRACT(YEAR FROM a.date::date) = ${prevMYear}
          AND EXTRACT(MONTH FROM a.date::date) = ${prevM}
      ) sub
      WHERE sub.customer_id NOT IN (
        SELECT msr.customer_id
        FROM monthly_service_records msr
        WHERE msr.year = ${prevMYear} AND msr.month = ${prevM}
      )
    `),

    db.execute(sql`
      SELECT COUNT(*)::int AS count
      FROM customers c
      WHERE c.status = 'aktiv' AND c.deleted_at IS NULL
        AND EXTRACT(YEAR FROM c.created_at) = ${curYear}
        AND EXTRACT(MONTH FROM c.created_at) = ${curMonth}
    `),
  ]);

  interface AlertItem {
    severity: "rot" | "gelb" | "gruen";
    title: string;
    description: string;
    count: number;
    link?: string;
  }

  const alerts: AlertItem[] = [];

  const undocCount = Number(undocumented.rows[0]?.count || 0);
  if (undocCount > 0) {
    alerts.push({
      severity: "rot",
      title: "Undokumentierte Termine",
      description: `${undocCount} abgeschlossene Termine warten seit mehr als 3 Tagen auf Dokumentation.`,
      count: undocCount,
      link: "/undocumented",
    });
  }

  const overCount = Number(budgetOverspend.rows[0]?.count || 0);
  if (overCount > 0) {
    alerts.push({
      severity: "rot",
      title: "Budget-Überschreitung",
      description: `${overCount} Kunden haben ihr §45b-Budget für ${curYear} überschritten.`,
      count: overCount,
      link: "/admin/billing",
    });
  }

  const noApptCount = Number(noAppointments.rows[0]?.count || 0);
  if (noApptCount > 0) {
    alerts.push({
      severity: "gelb",
      title: "Kunden ohne Termine",
      description: `${noApptCount} aktive Kunden haben keine Termine im ${MONTH_NAMES_DE[curMonth]}.`,
      count: noApptCount,
      link: "/admin/statistics?tab=planning",
    });
  }

  const missingCount = Number(missingRecords.rows[0]?.count || 0);
  if (missingCount > 0) {
    alerts.push({
      severity: "gelb",
      title: "Fehlende Leistungsnachweise",
      description: `${missingCount} Kunden haben noch keinen Leistungsnachweis für ${MONTH_NAMES_DE[prevM]}.`,
      count: missingCount,
      link: "/service-records",
    });
  }

  const newCustCount = Number(newCustomers.rows[0]?.count || 0);
  if (newCustCount > 0) {
    alerts.push({
      severity: "gruen",
      title: "Neue Kunden",
      description: `${newCustCount} neue Kunden im ${MONTH_NAMES_DE[curMonth]} gewonnen.`,
      count: newCustCount,
    });
  }

  res.json(alerts);
}));

export default router;
