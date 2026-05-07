import { sql } from "drizzle-orm";
import { db } from "../../lib/db";
import type { RevenueStatsResponse, RevenueGapRow, PlannedRevenueTotals } from "@shared/statistics";
import { billingPeriodFilter, buildKpi, dateFilter, num, periodToResponse, previousPeriod, previousYearPeriod, type ResolvedPeriod } from "./common";

function perAppointmentCte(p: ResolvedPeriod) {
  const dFilter = dateFilter(p, sql`a.date::date`);
  return sql`
    per_appt AS (
      SELECT a.id, a.customer_id,
        COALESCE(a.performed_by_employee_id, a.assigned_employee_id) AS employee_id,
        COALESCE(a.service_type, 'sonstige') AS service_type,
        a.appointment_type, a.status, a.date::date AS d,
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
      GROUP BY a.id, a.customer_id, a.performed_by_employee_id, a.assigned_employee_id, a.service_type, a.appointment_type, a.status, a.date
    )
  `;
}

async function computeStages(p: ResolvedPeriod) {
  const invFilter = billingPeriodFilter(p, sql`i.billing_year`, sql`i.billing_month`);
  const r = await db.execute(sql`
    WITH ${perAppointmentCte(p)}
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
    FROM invoice_line_items li JOIN invoices i ON i.id = li.invoice_id
    WHERE i.status != 'storniert' AND i.invoice_type != 'stornorechnung' ${invFilter}
  `);
  const row = r.rows[0] as Record<string, unknown>;
  const inv0 = inv.rows[0] as Record<string, unknown>;
  return { planned: num(row.planned), documented: num(row.documented), proven: num(row.proven), invoiced: num(inv0.invoiced) };
}

async function stageSparklines(year: number) {
  const r = await db.execute(sql`
    WITH per_appt AS (
      SELECT EXTRACT(MONTH FROM a.date::date)::int AS m, a.id, a.status,
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
        AND EXTRACT(YEAR FROM a.date::date) = ${year}
      GROUP BY EXTRACT(MONTH FROM a.date::date), a.id, a.status
    ),
    monthly AS (
      SELECT m,
        COALESCE(SUM(CASE WHEN status IN ('scheduled','completed','documented') THEN revenue_cents END), 0)::bigint AS planned,
        COALESCE(SUM(CASE WHEN status IN ('completed','documented') THEN revenue_cents END), 0)::bigint AS documented,
        COALESCE(SUM(CASE WHEN id IN (
          SELECT sra.appointment_id FROM service_record_appointments sra
          JOIN monthly_service_records msr ON msr.id = sra.service_record_id
          WHERE msr.deleted_at IS NULL AND msr.status = 'completed'
        ) THEN revenue_cents END), 0)::bigint AS proven
      FROM per_appt GROUP BY m
    ),
    invoiced AS (
      SELECT i.billing_month AS m, COALESCE(SUM(li.total_cents), 0)::bigint AS invoiced
      FROM invoice_line_items li JOIN invoices i ON i.id = li.invoice_id
      WHERE i.status != 'storniert' AND i.invoice_type != 'stornorechnung'
        AND i.billing_year = ${year}
      GROUP BY i.billing_month
    )
    SELECT g.m AS month,
      COALESCE(monthly.planned, 0)::bigint AS planned,
      COALESCE(monthly.documented, 0)::bigint AS documented,
      COALESCE(monthly.proven, 0)::bigint AS proven,
      COALESCE(invoiced.invoiced, 0)::bigint AS invoiced
    FROM generate_series(1, 12) AS g(m)
    LEFT JOIN monthly ON monthly.m = g.m
    LEFT JOIN invoiced ON invoiced.m = g.m
    ORDER BY g.m
  `);
  return r.rows.map((row: Record<string, unknown>) => ({
    period: `${year}-${String(num(row.month)).padStart(2, "0")}`,
    planned: num(row.planned),
    documented: num(row.documented),
    proven: num(row.proven),
    invoiced: num(row.invoiced),
  }));
}

export async function getRevenueStats(period: ResolvedPeriod): Promise<RevenueStatsResponse> {
  const prev = previousPeriod(period);
  const prevY = previousYearPeriod(period);
  const dFilter = dateFilter(period, sql`a.date::date`);
  const invFilter = billingPeriodFilter(period, sql`i.billing_year`, sql`i.billing_month`);

  const [stagesCur, stagesPrev, stagesYoy, byServiceTypeRow, byEmployeeRow, byCustomerRow, gapsRow, ttdRows, ttiRows, forecast, travelRow, travelByEmpRow, plannedRow, sparkRows] = await Promise.all([
    computeStages(period),
    computeStages(prev),
    computeStages(prevY),
    // byServiceType: planned/documented/proven from per_appt; invoiced via invoice line items joined to appointments
    db.execute(sql`
      WITH ${perAppointmentCte(period)},
      svc_appt AS (
        SELECT
          CASE WHEN appointment_type = 'Erstberatung' THEN 'erstberatung' ELSE service_type END AS service_type,
          status, id, revenue_cents
        FROM per_appt
      ),
      base AS (
        SELECT service_type,
          COALESCE(SUM(CASE WHEN status IN ('scheduled','completed','documented') THEN revenue_cents END), 0)::bigint AS planned,
          COALESCE(SUM(CASE WHEN status IN ('completed','documented') THEN revenue_cents END), 0)::bigint AS documented,
          COALESCE(SUM(CASE WHEN id IN (
            SELECT sra.appointment_id FROM service_record_appointments sra
            JOIN monthly_service_records msr ON msr.id = sra.service_record_id
            WHERE msr.deleted_at IS NULL AND msr.status = 'completed'
          ) THEN revenue_cents END), 0)::bigint AS proven
        FROM svc_appt GROUP BY service_type
      ),
      inv_by_svc AS (
        SELECT CASE WHEN a.appointment_type = 'Erstberatung' THEN 'erstberatung'
                    ELSE COALESCE(a.service_type, 'sonstige') END AS service_type,
          COALESCE(SUM(li.total_cents), 0)::bigint AS invoiced
        FROM invoice_line_items li
        JOIN invoices i ON i.id = li.invoice_id
        JOIN appointments a ON a.id = li.appointment_id
        WHERE i.status != 'storniert' AND i.invoice_type != 'stornorechnung' ${invFilter}
        GROUP BY 1
      )
      SELECT b.service_type, b.planned, b.documented, b.proven,
        COALESCE(iv.invoiced, 0)::bigint AS invoiced
      FROM base b LEFT JOIN inv_by_svc iv ON iv.service_type = b.service_type
      UNION ALL
      SELECT iv.service_type, 0::bigint, 0::bigint, 0::bigint, iv.invoiced
      FROM inv_by_svc iv WHERE iv.service_type NOT IN (SELECT service_type FROM base)
    `),
    db.execute(sql`
      WITH ${perAppointmentCte(period)},
      stages AS (
        SELECT employee_id,
          COALESCE(SUM(CASE WHEN status IN ('scheduled','completed','documented') THEN revenue_cents END), 0)::bigint AS planned,
          COALESCE(SUM(CASE WHEN status IN ('completed','documented') THEN revenue_cents END), 0)::bigint AS documented,
          COALESCE(SUM(CASE WHEN id IN (
            SELECT sra.appointment_id FROM service_record_appointments sra
            JOIN monthly_service_records msr ON msr.id = sra.service_record_id
            WHERE msr.deleted_at IS NULL AND msr.status = 'completed'
          ) THEN revenue_cents END), 0)::bigint AS proven
        FROM per_appt WHERE employee_id IS NOT NULL GROUP BY employee_id
      ),
      inv_by_emp AS (
        SELECT COALESCE(a.performed_by_employee_id, a.assigned_employee_id) AS employee_id,
          COALESCE(SUM(li.total_cents), 0)::bigint AS invoiced
        FROM invoice_line_items li JOIN invoices i ON i.id = li.invoice_id
        JOIN appointments a ON a.id = li.appointment_id
        WHERE i.status != 'storniert' AND i.invoice_type != 'stornorechnung' ${invFilter}
        GROUP BY 1
      )
      SELECT u.id AS employee_id, u.display_name AS employee_name,
        COALESCE(s.planned, 0)::bigint AS planned,
        COALESCE(s.documented, 0)::bigint AS documented,
        COALESCE(s.proven, 0)::bigint AS proven,
        COALESCE(iv.invoiced, 0)::bigint AS invoiced
      FROM users u
      LEFT JOIN stages s ON s.employee_id = u.id
      LEFT JOIN inv_by_emp iv ON iv.employee_id = u.id
      WHERE u.is_active = true AND u.is_anonymized = false
        AND (COALESCE(s.documented, 0) > 0 OR COALESCE(iv.invoiced, 0) > 0 OR COALESCE(s.planned, 0) > 0)
      ORDER BY documented DESC
    `),
    db.execute(sql`
      WITH ${perAppointmentCte(period)},
      stages AS (
        SELECT customer_id,
          COALESCE(SUM(CASE WHEN status IN ('scheduled','completed','documented') THEN revenue_cents END), 0)::bigint AS planned,
          COALESCE(SUM(CASE WHEN status IN ('completed','documented') THEN revenue_cents END), 0)::bigint AS documented,
          COALESCE(SUM(CASE WHEN id IN (
            SELECT sra.appointment_id FROM service_record_appointments sra
            JOIN monthly_service_records msr ON msr.id = sra.service_record_id
            WHERE msr.deleted_at IS NULL AND msr.status = 'completed'
          ) THEN revenue_cents END), 0)::bigint AS proven
        FROM per_appt GROUP BY customer_id
      ),
      inv_by_cust AS (
        SELECT i.customer_id, COALESCE(SUM(li.total_cents), 0)::bigint AS invoiced
        FROM invoice_line_items li JOIN invoices i ON i.id = li.invoice_id
        WHERE i.status != 'storniert' AND i.invoice_type != 'stornorechnung' ${invFilter}
        GROUP BY i.customer_id
      )
      SELECT c.id AS customer_id,
        COALESCE(NULLIF(TRIM(CONCAT_WS(' ', c.vorname, c.nachname)), ''), c.name) AS customer_name,
        COALESCE(s.planned, 0)::bigint AS planned,
        COALESCE(s.documented, 0)::bigint AS documented,
        COALESCE(s.proven, 0)::bigint AS proven,
        COALESCE(iv.invoiced, 0)::bigint AS invoiced
      FROM customers c
      LEFT JOIN stages s ON s.customer_id = c.id
      LEFT JOIN inv_by_cust iv ON iv.customer_id = c.id
      WHERE c.deleted_at IS NULL
        AND (COALESCE(s.documented, 0) > 0 OR COALESCE(iv.invoiced, 0) > 0 OR COALESCE(s.planned, 0) > 0)
      ORDER BY documented DESC LIMIT 50
    `),
    db.execute(sql`
      WITH ${perAppointmentCte(period)},
      doc AS (SELECT id, revenue_cents FROM per_appt WHERE status IN ('completed','documented')),
      proven AS (
        SELECT id, revenue_cents FROM per_appt
        WHERE id IN (
          SELECT sra.appointment_id FROM service_record_appointments sra
          JOIN monthly_service_records msr ON msr.id = sra.service_record_id
          WHERE msr.deleted_at IS NULL AND msr.status = 'completed'
        )
      )
      SELECT
        (COALESCE((SELECT SUM(revenue_cents) FROM doc), 0) - COALESCE((SELECT SUM(revenue_cents) FROM proven), 0))::bigint AS doc_minus_proven,
        ((SELECT COUNT(*) FROM doc) - (SELECT COUNT(*) FROM proven))::int AS doc_minus_proven_count,
        (
          COALESCE((SELECT SUM(revenue_cents) FROM proven), 0) -
          COALESCE((SELECT SUM(li.total_cents) FROM invoice_line_items li
            JOIN invoices i ON i.id = li.invoice_id
            WHERE i.status != 'storniert' AND i.invoice_type != 'stornorechnung' ${invFilter}), 0)
        )::bigint AS proven_minus_invoiced,
        ((SELECT COUNT(*) FROM proven) - (SELECT COUNT(DISTINCT li.appointment_id)
          FROM invoice_line_items li JOIN invoices i ON i.id = li.invoice_id
          WHERE i.status != 'storniert' AND i.invoice_type != 'stornorechnung' ${invFilter}
            AND li.appointment_id IS NOT NULL))::int AS proven_minus_invoiced_count
    `),
    db.execute(sql`
      SELECT EXTRACT(MONTH FROM a.date::date)::int AS month,
        ROUND(AVG(EXTRACT(EPOCH FROM (sra.created_at - a.date::timestamp)) / 86400.0)::numeric, 1) AS avg_days,
        ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (sra.created_at - a.date::timestamp)) / 86400.0)::numeric, 1) AS median_days,
        ROUND(PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (sra.created_at - a.date::timestamp)) / 86400.0)::numeric, 1) AS p90_days
      FROM appointments a JOIN service_record_appointments sra ON sra.appointment_id = a.id
      WHERE a.deleted_at IS NULL AND EXTRACT(YEAR FROM a.date::date) = ${period.year}
      GROUP BY 1 ORDER BY 1
    `),
    db.execute(sql`
      SELECT EXTRACT(MONTH FROM msr.created_at)::int AS month,
        ROUND(AVG(EXTRACT(EPOCH FROM (i.created_at - msr.created_at)) / 86400.0)::numeric, 1) AS avg_days,
        ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (i.created_at - msr.created_at)) / 86400.0)::numeric, 1) AS median_days,
        ROUND(PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (i.created_at - msr.created_at)) / 86400.0)::numeric, 1) AS p90_days
      FROM monthly_service_records msr
      JOIN invoices i ON i.customer_id = msr.customer_id AND i.billing_year = msr.year AND i.billing_month = msr.month
        AND i.status != 'storniert' AND i.invoice_type != 'stornorechnung'
      WHERE msr.deleted_at IS NULL AND msr.year = ${period.year} AND i.created_at >= msr.created_at
      GROUP BY 1 ORDER BY 1
    `),
    (async (): Promise<number> => {
      // Monatsprognose = laufender Kalendermonat, hochgerechnet auf den ganzen Monat
      // basierend auf Tages-Run-Rate (already-realized revenue / elapsed days * total days).
      // Diese Kennzahl ist immer der CURRENT real-world month — unabhängig vom gewählten
      // Auswahl-Zeitraum (Gesamtjahr, Vorjahr etc.), damit „laufender Monat" stets sichtbar bleibt.
      const now = new Date();
      const curYear = now.getFullYear();
      const curMonth = now.getMonth() + 1;
      const totalDays = new Date(curYear, curMonth, 0).getDate();
      const elapsedDays = Math.max(1, Math.min(now.getDate(), totalDays));
      const r = await db.execute(sql`
        WITH per_appt AS (
          SELECT a.id,
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
            a.status, a.date::date AS d
          FROM appointments a
          JOIN appointment_services asvc ON asvc.appointment_id = a.id
          JOIN services s ON s.id = asvc.service_id
          WHERE a.deleted_at IS NULL AND s.unit_type = 'hours'
            AND EXTRACT(YEAR FROM a.date::date) = ${curYear}
            AND EXTRACT(MONTH FROM a.date::date) = ${curMonth}
          GROUP BY a.id, a.status, a.date
        )
        SELECT
          COALESCE(SUM(CASE WHEN status IN ('completed','documented') THEN revenue_cents END), 0)::bigint AS realized,
          COALESCE(SUM(CASE WHEN status IN ('scheduled','completed','documented') THEN revenue_cents END), 0)::bigint AS planned_total
        FROM per_appt
      `);
      const row = r.rows[0] as Record<string, unknown>;
      const realized = num(row?.realized);
      const plannedTotal = num(row?.planned_total);
      // Hochrechnung = max(realisiert/elapsedDays * totalDays, geplante Termine im Monat).
      const runRate = Math.round((realized / elapsedDays) * totalDays);
      return Math.max(runRate, plannedTotal);
    })(),
    db.execute(sql`
      WITH ${perAppointmentCte(period)},
      doc_rev AS (SELECT COALESCE(SUM(revenue_cents), 0)::bigint AS r FROM per_appt WHERE status IN ('completed','documented')),
      travel_cost AS (
        SELECT COALESCE(SUM(ROUND(COALESCE(a.travel_kilometers, 0) * COALESCE((SELECT employee_rate_cents FROM services WHERE code = 'travel_km'), 0))), 0)::bigint AS c
        FROM appointments a
        WHERE a.deleted_at IS NULL AND a.status IN ('completed','documented') ${dFilter}
      )
      SELECT (SELECT r FROM doc_rev) AS revenue, (SELECT c FROM travel_cost) AS travel_cost
    `),
    db.execute(sql`
      WITH per_appt_planned AS (
        SELECT a.id, a.customer_id,
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
          ))::bigint AS cost_cents
        FROM appointments a
        JOIN appointment_services asvc ON asvc.appointment_id = a.id
        JOIN services s ON s.id = asvc.service_id
        WHERE a.deleted_at IS NULL AND s.unit_type = 'hours'
          AND a.status IN ('scheduled','completed','documented')
          ${dFilter}
        GROUP BY a.id, a.customer_id, a.duration_promised
      )
      SELECT
        COALESCE(SUM(revenue_cents), 0)::bigint AS revenue_cents,
        COALESCE(SUM(cost_cents), 0)::bigint AS cost_cents,
        COALESCE(SUM(minutes), 0)::int AS total_minutes,
        COUNT(*)::int AS appointments,
        COUNT(DISTINCT customer_id)::int AS customers
      FROM per_appt_planned
    `),
    db.execute(sql`
      WITH ${perAppointmentCte(period)},
      doc_by_emp AS (
        SELECT employee_id, COALESCE(SUM(revenue_cents), 0)::bigint AS revenue FROM per_appt
        WHERE status IN ('completed','documented') AND employee_id IS NOT NULL GROUP BY employee_id
      ),
      tc_by_emp AS (
        SELECT COALESCE(a.performed_by_employee_id, a.assigned_employee_id) AS employee_id,
          COALESCE(SUM(ROUND(COALESCE(a.travel_kilometers, 0) * COALESCE((SELECT employee_rate_cents FROM services WHERE code = 'travel_km'), 0))), 0)::bigint AS travel_cost
        FROM appointments a
        WHERE a.deleted_at IS NULL AND a.status IN ('completed','documented') ${dFilter}
        GROUP BY 1
      )
      SELECT u.id AS employee_id, u.display_name AS employee_name,
        COALESCE(d.revenue, 0)::bigint AS revenue, COALESCE(t.travel_cost, 0)::bigint AS travel_cost
      FROM users u LEFT JOIN doc_by_emp d ON d.employee_id = u.id LEFT JOIN tc_by_emp t ON t.employee_id = u.id
      WHERE u.is_active = true AND u.is_anonymized = false AND COALESCE(d.revenue, 0) > 0
    `),
    stageSparklines(period.year),
  ]);

  const gaps = gapsRow.rows[0] as Record<string, unknown>;
  const travel = travelRow.rows[0] as Record<string, unknown>;
  const revenueDoc = num(travel?.revenue);
  const travelCost = num(travel?.travel_cost);

  return {
    period: periodToResponse(period),
    byStage: {
      planned: buildKpi(stagesCur.planned, stagesPrev.planned, stagesYoy.planned),
      documented: buildKpi(stagesCur.documented, stagesPrev.documented, stagesYoy.documented),
      proven: buildKpi(stagesCur.proven, stagesPrev.proven, stagesYoy.proven),
      invoiced: buildKpi(stagesCur.invoiced, stagesPrev.invoiced, stagesYoy.invoiced),
    },
    byServiceType: byServiceTypeRow.rows.map((r: Record<string, unknown>) => ({
      serviceType: String(r.service_type ?? "sonstige"),
      planned: num(r.planned), documented: num(r.documented),
      proven: num(r.proven), invoiced: num(r.invoiced),
    })),
    byEmployee: byEmployeeRow.rows.map((r: Record<string, unknown>) => ({
      id: num(r.employee_id), name: String(r.employee_name ?? ""),
      planned: num(r.planned), documented: num(r.documented),
      proven: num(r.proven), invoiced: num(r.invoiced),
    })),
    byCustomer: byCustomerRow.rows.map((r: Record<string, unknown>) => ({
      id: num(r.customer_id), name: String(r.customer_name ?? ""),
      planned: num(r.planned), documented: num(r.documented),
      proven: num(r.proven), invoiced: num(r.invoiced),
    })),
    gaps: {
      documentedMinusProvenCents: num(gaps?.doc_minus_proven),
      documentedMinusProvenCount: num(gaps?.doc_minus_proven_count),
      provenMinusInvoicedCents: num(gaps?.proven_minus_invoiced),
      provenMinusInvoicedCount: num(gaps?.proven_minus_invoiced_count),
    },
    timeToDocumentDays: ttdRows.rows.map((r: Record<string, unknown>) => ({
      month: num(r.month), avgDays: num(r.avg_days),
      medianDays: num(r.median_days), p90Days: num(r.p90_days),
    })),
    timeToInvoiceDays: ttiRows.rows.map((r: Record<string, unknown>) => ({
      month: num(r.month), avgDays: num(r.avg_days),
      medianDays: num(r.median_days), p90Days: num(r.p90_days),
    })),
    monthForecastCents: forecast,
    planned: ((): PlannedRevenueTotals => {
      const p = plannedRow.rows[0] as Record<string, unknown> | undefined;
      const revenueCents = num(p?.revenue_cents);
      const costCents = num(p?.cost_cents);
      const marginCents = revenueCents - costCents;
      return {
        revenueCents,
        costCents,
        marginCents,
        marginPercent: revenueCents > 0 ? Math.round((marginCents / revenueCents) * 100) : 0,
        totalMinutes: num(p?.total_minutes),
        appointments: num(p?.appointments),
        customers: num(p?.customers),
      };
    })(),
    travelCostRatioPct: revenueDoc > 0 ? Math.round((travelCost / revenueDoc) * 100) : 0,
    travelCostRatioByEmployee: travelByEmpRow.rows.map((r: Record<string, unknown>) => {
      const rev = num(r.revenue); const cost = num(r.travel_cost);
      return {
        employeeId: num(r.employee_id), employeeName: String(r.employee_name ?? ""),
        ratioPct: rev > 0 ? Math.round((cost / rev) * 100) : 0,
      };
    }),
    sparklines: {
      planned: sparkRows.map((s) => ({ period: s.period, value: s.planned })),
      documented: sparkRows.map((s) => ({ period: s.period, value: s.documented })),
      proven: sparkRows.map((s) => ({ period: s.period, value: s.proven })),
      invoiced: sparkRows.map((s) => ({ period: s.period, value: s.invoiced })),
    },
  };
}

function mapGapRow(r: Record<string, unknown>): RevenueGapRow {
  return {
    appointmentId: num(r.appointment_id),
    date: String(r.date ?? ""),
    customerId: r.customer_id == null ? null : num(r.customer_id),
    customerName: String(r.customer_name ?? "Unbekannt"),
    employeeId: r.employee_id == null ? null : num(r.employee_id),
    employeeName: r.employee_name == null ? null : String(r.employee_name),
    serviceType: String(r.service_type ?? "sonstige"),
    revenueCents: num(r.revenue_cents),
  };
}

/** Termine, die im Zeitraum dokumentiert wurden, aber keinem Leistungsnachweis (proven) zugeordnet sind. */
export async function listDocumentedWithoutProven(period: ResolvedPeriod): Promise<RevenueGapRow[]> {
  const r = await db.execute(sql`
    WITH ${perAppointmentCte(period)}
    SELECT p.id AS appointment_id,
      to_char(p.d, 'YYYY-MM-DD') AS date,
      p.customer_id,
      COALESCE(NULLIF(TRIM(CONCAT_WS(' ', c.vorname, c.nachname)), ''), c.name) AS customer_name,
      p.employee_id,
      u.display_name AS employee_name,
      p.service_type,
      p.revenue_cents
    FROM per_appt p
    LEFT JOIN customers c ON c.id = p.customer_id
    LEFT JOIN users u ON u.id = p.employee_id
    WHERE p.status IN ('completed','documented')
      AND p.id NOT IN (
        SELECT sra.appointment_id FROM service_record_appointments sra
        JOIN monthly_service_records msr ON msr.id = sra.service_record_id
        WHERE msr.deleted_at IS NULL AND msr.status = 'completed'
      )
    ORDER BY p.d DESC, p.id DESC
    LIMIT 500
  `);
  return r.rows.map(mapGapRow as (r: Record<string, unknown>) => RevenueGapRow);
}

/** Termine in einem abgeschlossenen Leistungsnachweis, die noch nicht in einer Rechnung berechnet wurden. */
export async function listProvenWithoutInvoiced(period: ResolvedPeriod): Promise<RevenueGapRow[]> {
  const invFilter = billingPeriodFilter(period, sql`i.billing_year`, sql`i.billing_month`);
  const r = await db.execute(sql`
    WITH ${perAppointmentCte(period)},
    proven AS (
      SELECT p.* FROM per_appt p
      WHERE p.id IN (
        SELECT sra.appointment_id FROM service_record_appointments sra
        JOIN monthly_service_records msr ON msr.id = sra.service_record_id
        WHERE msr.deleted_at IS NULL AND msr.status = 'completed'
      )
    ),
    invoiced AS (
      SELECT DISTINCT li.appointment_id FROM invoice_line_items li
      JOIN invoices i ON i.id = li.invoice_id
      WHERE i.status != 'storniert' AND i.invoice_type != 'stornorechnung' ${invFilter}
        AND li.appointment_id IS NOT NULL
    )
    SELECT p.id AS appointment_id,
      to_char(p.d, 'YYYY-MM-DD') AS date,
      p.customer_id,
      COALESCE(NULLIF(TRIM(CONCAT_WS(' ', c.vorname, c.nachname)), ''), c.name) AS customer_name,
      p.employee_id,
      u.display_name AS employee_name,
      p.service_type,
      p.revenue_cents
    FROM proven p
    LEFT JOIN customers c ON c.id = p.customer_id
    LEFT JOIN users u ON u.id = p.employee_id
    WHERE p.id NOT IN (SELECT appointment_id FROM invoiced)
    ORDER BY p.d DESC, p.id DESC
    LIMIT 500
  `);
  return r.rows.map(mapGapRow as (r: Record<string, unknown>) => RevenueGapRow);
}
