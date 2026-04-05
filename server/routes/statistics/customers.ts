import { Router } from "express";
import { asyncHandler, forbidden } from "../../lib/errors";
import { db } from "../../lib/db";
import { sql } from "drizzle-orm";

const router = Router();

function currentMonth() {
  return new Date().getMonth() + 1;
}

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
        SELECT EXTRACT(MONTH FROM cc.contract_start::date)::int AS m, COUNT(DISTINCT cc.customer_id) AS cnt
        FROM customer_contracts cc
        JOIN customers c ON c.id = cc.customer_id
        WHERE c.deleted_at IS NULL
          AND EXTRACT(YEAR FROM cc.contract_start::date) = ${year}
        GROUP BY EXTRACT(MONTH FROM cc.contract_start::date)
      ) gained ON gained.m = m.month
      LEFT JOIN (
        SELECT EXTRACT(MONTH FROM c.inaktiv_ab)::int AS m, COUNT(*) AS cnt
        FROM customers c
        WHERE c.deleted_at IS NULL
          AND c.inaktiv_ab IS NOT NULL
          AND c.merged_into_customer_id IS NULL
          AND EXTRACT(YEAR FROM c.inaktiv_ab) = ${year}
        GROUP BY EXTRACT(MONTH FROM c.inaktiv_ab)
      ) lost ON lost.m = m.month
      ORDER BY m.month
    `),

    db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE c.status = 'aktiv' AND c.deleted_at IS NULL)::int AS "activeNow",
        COUNT(DISTINCT cc.customer_id) FILTER (WHERE c.deleted_at IS NULL AND EXTRACT(YEAR FROM cc.contract_start::date) = ${year})::int AS "gainedThisYear",
        COUNT(*) FILTER (WHERE c.deleted_at IS NULL AND c.inaktiv_ab IS NOT NULL AND c.merged_into_customer_id IS NULL AND EXTRACT(YEAR FROM c.inaktiv_ab) = ${year})::int AS "lostThisYear"
      FROM customers c
      LEFT JOIN customer_contracts cc ON cc.customer_id = c.id
    `),

    db.execute(sql`
      SELECT
        COUNT(DISTINCT cc.customer_id) FILTER (WHERE c.deleted_at IS NULL AND EXTRACT(YEAR FROM cc.contract_start::date) = ${year - 1})::int AS "gainedPrevYear",
        COUNT(*) FILTER (WHERE c.deleted_at IS NULL AND c.inaktiv_ab IS NOT NULL AND c.merged_into_customer_id IS NULL AND EXTRACT(YEAR FROM c.inaktiv_ab) = ${year - 1})::int AS "lostPrevYear"
      FROM customers c
      LEFT JOIN customer_contracts cc ON cc.customer_id = c.id
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

router.get("/lifecycle-details", asyncHandler("Lifecycle-Details konnten nicht geladen werden", async (req, res) => {
  if (!req.user!.isAdmin) throw forbidden("FORBIDDEN", "Nur für Administratoren");

  const year = parseInt(req.query.year as string) || new Date().getFullYear();
  const month = parseInt(req.query.month as string);
  if (!month || month < 1 || month > 12) {
    res.status(400).json({ error: "Ungültiger Monat" });
    return;
  }

  const [gained, lost] = await Promise.all([
    db.execute(sql`
      SELECT DISTINCT c.id, c.name, c.vorname, c.nachname, cc.contract_start
      FROM customer_contracts cc
      JOIN customers c ON c.id = cc.customer_id
      WHERE c.deleted_at IS NULL
        AND EXTRACT(YEAR FROM cc.contract_start::date) = ${year}
        AND EXTRACT(MONTH FROM cc.contract_start::date) = ${month}
      ORDER BY cc.contract_start
    `),
    db.execute(sql`
      SELECT c.id, c.name, c.vorname, c.nachname, c.inaktiv_ab, c.deactivation_reason
      FROM customers c
      WHERE c.deleted_at IS NULL
        AND c.inaktiv_ab IS NOT NULL
        AND c.merged_into_customer_id IS NULL
        AND EXTRACT(YEAR FROM c.inaktiv_ab) = ${year}
        AND EXTRACT(MONTH FROM c.inaktiv_ab) = ${month}
      ORDER BY c.inaktiv_ab
    `),
  ]);

  const mapName = (r: any) => r.name || [r.vorname, r.nachname].filter(Boolean).join(" ") || "Unbekannt";

  res.json({
    gained: gained.rows.map((r: any) => ({
      id: r.id,
      name: mapName(r),
      date: r.contract_start,
    })),
    lost: lost.rows.map((r: any) => ({
      id: r.id,
      name: mapName(r),
      date: r.inaktiv_ab,
      reason: r.deactivation_reason || null,
    })),
  });
}));

router.get("/budget-potential", asyncHandler("Budget-Potenzial konnte nicht geladen werden", async (req, res) => {
  if (!req.user!.isAdmin) throw forbidden("FORBIDDEN", "Nur für Administratoren");

  const year = parseInt(req.query.year as string) || new Date().getFullYear();
  const now = new Date();
  const effectiveMonth = year < now.getFullYear() ? 12 : currentMonth();

  const result = await db.execute(sql`
    WITH active_customers AS (
      SELECT id, name, pflegegrad
      FROM customers
      WHERE status = 'aktiv' AND deleted_at IS NULL
    ),
    alloc_45b AS (
      SELECT ba.customer_id, COALESCE(SUM(ba.amount_cents), 0)::bigint AS allocated
      FROM budget_allocations ba
      JOIN active_customers ac ON ac.id = ba.customer_id
      WHERE ba.budget_type = 'entlastungsbetrag_45b'
        AND ba.year = ${year} AND ba.month <= ${effectiveMonth}
      GROUP BY ba.customer_id
    ),
    alloc_45a AS (
      SELECT ba.customer_id, COALESCE(SUM(ba.amount_cents), 0)::bigint AS allocated
      FROM budget_allocations ba
      JOIN active_customers ac ON ac.id = ba.customer_id
      WHERE ba.budget_type = 'umwandlung_45a'
        AND ba.year = ${year} AND ba.month = ${effectiveMonth}
      GROUP BY ba.customer_id
    ),
    alloc_39 AS (
      SELECT ba.customer_id,
        CASE WHEN ${effectiveMonth} >= 12
          THEN COALESCE(SUM(ba.amount_cents), 0)::bigint
          ELSE ROUND(COALESCE(SUM(ba.amount_cents), 0)::numeric / 12 * ${effectiveMonth})::bigint
        END AS allocated
      FROM budget_allocations ba
      JOIN active_customers ac ON ac.id = ba.customer_id
      WHERE ba.budget_type = 'ersatzpflege_39_42a'
        AND ba.year = ${year}
      GROUP BY ba.customer_id
    ),
    all_alloc AS (
      SELECT customer_id, SUM(allocated) AS total_allocated FROM (
        SELECT customer_id, allocated FROM alloc_45b
        UNION ALL
        SELECT customer_id, allocated FROM alloc_45a
        UNION ALL
        SELECT customer_id, allocated FROM alloc_39
      ) u GROUP BY customer_id
    ),
    used AS (
      SELECT bt.customer_id, COALESCE(ABS(SUM(bt.amount_cents)), 0)::bigint AS total_used
      FROM budget_transactions bt
      JOIN active_customers ac ON ac.id = bt.customer_id
      WHERE bt.transaction_type = 'consumption'
        AND EXTRACT(YEAR FROM bt.transaction_date::date) = ${year}
        AND EXTRACT(MONTH FROM bt.transaction_date::date) <= ${effectiveMonth}
      GROUP BY bt.customer_id
    )
    SELECT
      ac.id,
      ac.name,
      ac.pflegegrad,
      COALESCE(aa.total_allocated, 0)::bigint AS "allocatedCents",
      COALESCE(u.total_used, 0)::bigint AS "usedCents",
      (COALESCE(aa.total_allocated, 0) - COALESCE(u.total_used, 0))::bigint AS "unusedCents"
    FROM active_customers ac
    LEFT JOIN all_alloc aa ON aa.customer_id = ac.id
    LEFT JOIN used u ON u.customer_id = ac.id
    WHERE COALESCE(aa.total_allocated, 0) > 0
    ORDER BY (COALESCE(aa.total_allocated, 0) - COALESCE(u.total_used, 0)) DESC
    LIMIT 10
  `);

  const customers = result.rows.map((r: any) => {
    const allocated = Number(r.allocatedCents || 0);
    const used = Number(r.usedCents || 0);
    return {
      id: r.id,
      name: r.name,
      pflegegrad: r.pflegegrad,
      allocatedCents: allocated,
      usedCents: used,
      unusedCents: Number(r.unusedCents || 0),
      percent: allocated > 0 ? Math.round((used / allocated) * 100) : 0,
    };
  });

  res.json({ customers });
}));

router.get("/customer-revenue", asyncHandler("Kunden-Umsatz-Statistiken konnten nicht geladen werden", async (req, res) => {
  if (!req.user!.isAdmin) throw forbidden("FORBIDDEN", "Nur für Administratoren");

  const year = parseInt(req.query.year as string) || new Date().getFullYear();
  const month = req.query.month ? parseInt(req.query.month as string) : null;

  if (month !== null && (month < 1 || month > 12 || isNaN(month))) {
    res.status(400).json({ error: "Ungültiger Monat (1-12)" });
    return;
  }

  if (month) {
    const prevMonth = month === 1 ? 12 : month - 1;
    const prevMonthYear = month === 1 ? year - 1 : year;

    const [currentData, prevData] = await Promise.all([
      db.execute(sql`
        SELECT
          COUNT(DISTINCT bt.customer_id)::int AS active_customers,
          COALESCE(SUM(ABS(bt.amount_cents)), 0)::bigint AS total_revenue_cents
        FROM budget_transactions bt
        WHERE bt.transaction_type = 'consumption'
          AND EXTRACT(YEAR FROM bt.transaction_date::date) = ${year}
          AND EXTRACT(MONTH FROM bt.transaction_date::date) = ${month}
      `),
      db.execute(sql`
        SELECT
          COUNT(DISTINCT bt.customer_id)::int AS active_customers,
          COALESCE(SUM(ABS(bt.amount_cents)), 0)::bigint AS total_revenue_cents
        FROM budget_transactions bt
        WHERE bt.transaction_type = 'consumption'
          AND EXTRACT(YEAR FROM bt.transaction_date::date) = ${prevMonthYear}
          AND EXTRACT(MONTH FROM bt.transaction_date::date) = ${prevMonth}
      `),
    ]);

    const cur = currentData.rows[0] as any;
    const prev = prevData.rows[0] as any;

    const activeCustomers = Number(cur?.active_customers || 0);
    const prevActiveCustomers = Number(prev?.active_customers || 0);
    const totalRevenueCents = Number(cur?.total_revenue_cents || 0);
    const prevTotalRevenueCents = Number(prev?.total_revenue_cents || 0);
    const avgRevenuePerCustomerCents = activeCustomers > 0 ? Math.round(totalRevenueCents / activeCustomers) : 0;
    const prevAvgRevenuePerCustomerCents = prevActiveCustomers > 0 ? Math.round(prevTotalRevenueCents / prevActiveCustomers) : 0;

    res.json({
      mode: "month" as const,
      month,
      year,
      activeCustomers,
      activeCustomersDelta: activeCustomers - prevActiveCustomers,
      totalRevenueCents,
      totalRevenueDeltaCents: totalRevenueCents - prevTotalRevenueCents,
      avgRevenuePerCustomerCents,
      avgRevenueDeltaCents: avgRevenuePerCustomerCents - prevAvgRevenuePerCustomerCents,
      prevMonth,
      prevMonthYear,
    });
  } else {
    const [currentData, prevData] = await Promise.all([
      db.execute(sql`
        SELECT
          COUNT(DISTINCT bt.customer_id)::int AS active_customers,
          COALESCE(SUM(ABS(bt.amount_cents)), 0)::bigint AS total_revenue_cents,
          COUNT(DISTINCT CONCAT(bt.customer_id, '-', EXTRACT(MONTH FROM bt.transaction_date::date)))::int AS customer_months
        FROM budget_transactions bt
        WHERE bt.transaction_type = 'consumption'
          AND EXTRACT(YEAR FROM bt.transaction_date::date) = ${year}
      `),
      db.execute(sql`
        SELECT
          COUNT(DISTINCT bt.customer_id)::int AS active_customers,
          COALESCE(SUM(ABS(bt.amount_cents)), 0)::bigint AS total_revenue_cents,
          COUNT(DISTINCT CONCAT(bt.customer_id, '-', EXTRACT(MONTH FROM bt.transaction_date::date)))::int AS customer_months
        FROM budget_transactions bt
        WHERE bt.transaction_type = 'consumption'
          AND EXTRACT(YEAR FROM bt.transaction_date::date) = ${year - 1}
      `),
    ]);

    const cur = currentData.rows[0] as any;
    const prev = prevData.rows[0] as any;

    const activeCustomers = Number(cur?.active_customers || 0);
    const prevActiveCustomers = Number(prev?.active_customers || 0);
    const totalRevenueCents = Number(cur?.total_revenue_cents || 0);
    const prevTotalRevenueCents = Number(prev?.total_revenue_cents || 0);
    const customerMonths = Number(cur?.customer_months || 0);
    const prevCustomerMonths = Number(prev?.customer_months || 0);
    const avgRevenuePerCustomerCents = customerMonths > 0 ? Math.round(totalRevenueCents / customerMonths) : 0;
    const prevAvgRevenuePerCustomerCents = prevCustomerMonths > 0 ? Math.round(prevTotalRevenueCents / prevCustomerMonths) : 0;

    res.json({
      mode: "year" as const,
      month: null,
      year,
      activeCustomers,
      activeCustomersDelta: activeCustomers - prevActiveCustomers,
      totalRevenueCents,
      totalRevenueDeltaCents: totalRevenueCents - prevTotalRevenueCents,
      avgRevenuePerCustomerCents,
      avgRevenueDeltaCents: avgRevenuePerCustomerCents - prevAvgRevenuePerCustomerCents,
      prevYear: year - 1,
    });
  }
}));

export default router;
