import { sql } from "drizzle-orm";
import { db } from "../../lib/db";
import type { ProcessHealthRow, ProcessHealthSummary } from "@shared/statistics";
import { billingPeriodFilter, buildKpi, dateFilter, getHealthThresholds, num, periodToResponse, previousPeriod, previousYearPeriod, scoreFor, type ResolvedPeriod } from "./common";

interface PeriodCounts {
  woEmployee: number;
  woAppointments: number;
  woRecord: number;
  recordsWoInvoice: number;
}

/** Cutoff for "Vormonat und älter": last day of the month preceding today. */
function undocumentedCutoff(): string {
  const now = new Date();
  const firstOfThisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const lastOfPrevMonth = new Date(firstOfThisMonth.getTime() - 86400000);
  return lastOfPrevMonth.toISOString().slice(0, 10);
}

async function periodCounts(p: ResolvedPeriod): Promise<PeriodCounts> {
  const dFilter = dateFilter(p, sql`a.date::date`);
  const invFilter = billingPeriodFilter(p, sql`msr.year`, sql`msr.month`);
  const r = await db.execute(sql`
    SELECT
      (SELECT COUNT(*)::int FROM customers c
        WHERE c.status = 'aktiv' AND c.deleted_at IS NULL AND c.primary_employee_id IS NULL) AS wo_employee,
      (SELECT COUNT(*)::int FROM customers c
        WHERE c.status = 'aktiv' AND c.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM appointments a
            WHERE a.customer_id = c.id AND a.deleted_at IS NULL AND a.status != 'cancelled'
              ${dFilter}
          )) AS wo_appts,
      (SELECT COUNT(*)::int FROM appointments a
        WHERE a.deleted_at IS NULL AND a.status IN ('completed','documented')
          ${dFilter}
          AND NOT EXISTS (SELECT 1 FROM service_record_appointments sra WHERE sra.appointment_id = a.id)) AS wo_record,
      (SELECT COUNT(DISTINCT msr.id)::int FROM monthly_service_records msr
        WHERE msr.deleted_at IS NULL AND msr.status = 'completed'
          ${invFilter}
          AND NOT EXISTS (
            SELECT 1 FROM invoices i
            WHERE i.customer_id = msr.customer_id AND i.billing_year = msr.year AND i.billing_month = msr.month
              AND i.status != 'storniert' AND i.invoice_type != 'stornorechnung'
          )) AS records_wo_invoice
  `);
  const row = r.rows[0] as Record<string, unknown>;
  return {
    woEmployee: num(row.wo_employee),
    woAppointments: num(row.wo_appts),
    woRecord: num(row.wo_record),
    recordsWoInvoice: num(row.records_wo_invoice),
  };
}

async function undocumentedCount(): Promise<number> {
  const cutoff = undocumentedCutoff();
  const r = await db.execute(sql`
    SELECT COUNT(*)::int AS c FROM appointments a
    WHERE a.deleted_at IS NULL AND a.status = 'completed'
      AND a.date::date <= ${cutoff}::date
  `);
  return num((r.rows[0] as Record<string, unknown>).c);
}

export async function getProcessHealthSummary(period: ResolvedPeriod): Promise<ProcessHealthSummary> {
  const prev = previousPeriod(period);
  const prevY = previousYearPeriod(period);
  const [cur, pre, yoy, undoc] = await Promise.all([
    periodCounts(period),
    periodCounts(prev),
    periodCounts(prevY),
    undocumentedCount(),
  ]);
  const total = cur.woEmployee + cur.woAppointments + undoc + cur.woRecord + cur.recordsWoInvoice;
  const totalPrev = pre.woEmployee + pre.woAppointments + undoc + pre.woRecord + pre.recordsWoInvoice;
  const totalYoy = yoy.woEmployee + yoy.woAppointments + undoc + yoy.woRecord + yoy.recordsWoInvoice;
  const thresholds = getHealthThresholds();

  return {
    period: periodToResponse(period),
    customersWithoutEmployee: buildKpi(cur.woEmployee, pre.woEmployee, yoy.woEmployee),
    customersWithoutAppointments: buildKpi(cur.woAppointments, pre.woAppointments, yoy.woAppointments),
    // Backlog metric — strictly "Vormonat und älter", independent of selected period.
    undocumentedAppointments: buildKpi(undoc, null, null),
    appointmentsWithoutRecord: buildKpi(cur.woRecord, pre.woRecord, yoy.woRecord),
    recordsWithoutInvoice: buildKpi(cur.recordsWoInvoice, pre.recordsWoInvoice, yoy.recordsWoInvoice),
    total: buildKpi(total, totalPrev, totalYoy),
    healthScore: scoreFor(total, thresholds),
    thresholds,
  };
}

export async function listCustomersWithoutEmployee(): Promise<ProcessHealthRow[]> {
  const r = await db.execute(sql`
    SELECT c.id, COALESCE(NULLIF(TRIM(CONCAT_WS(' ', c.vorname, c.nachname)), ''), c.name) AS label
    FROM customers c
    WHERE c.status = 'aktiv' AND c.deleted_at IS NULL AND c.primary_employee_id IS NULL
    ORDER BY label LIMIT 500
  `);
  return r.rows.map((row: Record<string, unknown>) => ({
    id: num(row.id), customerId: num(row.id),
    label: String(row.label ?? "Unbekannt"),
    link: `/admin/customers/${num(row.id)}`,
  }));
}

export async function listCustomersWithoutAppointments(p: ResolvedPeriod): Promise<ProcessHealthRow[]> {
  const dFilter = dateFilter(p, sql`a.date::date`);
  const r = await db.execute(sql`
    SELECT c.id,
      COALESCE(NULLIF(TRIM(CONCAT_WS(' ', c.vorname, c.nachname)), ''), c.name) AS label,
      u.display_name AS employee_name
    FROM customers c
    LEFT JOIN users u ON u.id = c.primary_employee_id
    WHERE c.status = 'aktiv' AND c.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM appointments a
        WHERE a.customer_id = c.id AND a.deleted_at IS NULL AND a.status != 'cancelled'
          ${dFilter}
      )
    ORDER BY label LIMIT 500
  `);
  const periodLabel = p.from && p.to ? `${p.from} – ${p.to}` : p.month ? `${p.year}-${String(p.month).padStart(2, "0")}` : `${p.year}`;
  return r.rows.map((row: Record<string, unknown>) => ({
    id: num(row.id), customerId: num(row.id),
    label: String(row.label ?? "Unbekannt"),
    employeeName: row.employee_name ? String(row.employee_name) : null,
    date: periodLabel,
    link: `/admin/customers/${num(row.id)}`,
  }));
}

/**
 * Backlog drill-down: completed appointments dated in the previous calendar month or earlier
 * that are still not marked documented. Independent of the selected reporting period.
 */
export async function listUndocumentedAppointments(): Promise<ProcessHealthRow[]> {
  const cutoff = undocumentedCutoff();
  const r = await db.execute(sql`
    SELECT a.id, a.date, a.customer_id,
      COALESCE(NULLIF(TRIM(CONCAT_WS(' ', c.vorname, c.nachname)), ''), c.name) AS label,
      u.display_name AS employee_name
    FROM appointments a
    JOIN customers c ON c.id = a.customer_id
    LEFT JOIN users u ON u.id = COALESCE(a.performed_by_employee_id, a.assigned_employee_id)
    WHERE a.deleted_at IS NULL AND a.status = 'completed' AND a.date::date <= ${cutoff}::date
    ORDER BY a.date LIMIT 500
  `);
  return r.rows.map((row: Record<string, unknown>) => ({
    id: num(row.id), appointmentId: num(row.id), customerId: num(row.customer_id),
    label: String(row.label ?? "Termin"),
    date: row.date ? String(row.date) : null,
    employeeName: row.employee_name ? String(row.employee_name) : null,
    link: `/appointments/${num(row.id)}`,
  }));
}

export async function listAppointmentsWithoutRecord(p: ResolvedPeriod): Promise<ProcessHealthRow[]> {
  const dFilter = dateFilter(p, sql`a.date::date`);
  const r = await db.execute(sql`
    SELECT a.id, a.date, a.customer_id,
      COALESCE(NULLIF(TRIM(CONCAT_WS(' ', c.vorname, c.nachname)), ''), c.name) AS label,
      u.display_name AS employee_name
    FROM appointments a
    JOIN customers c ON c.id = a.customer_id
    LEFT JOIN users u ON u.id = COALESCE(a.performed_by_employee_id, a.assigned_employee_id)
    WHERE a.deleted_at IS NULL AND a.status IN ('completed','documented')
      ${dFilter}
      AND NOT EXISTS (SELECT 1 FROM service_record_appointments sra WHERE sra.appointment_id = a.id)
    ORDER BY a.date DESC LIMIT 500
  `);
  return r.rows.map((row: Record<string, unknown>) => ({
    id: num(row.id), appointmentId: num(row.id), customerId: num(row.customer_id),
    label: String(row.label ?? "Termin"),
    date: row.date ? String(row.date) : null,
    employeeName: row.employee_name ? String(row.employee_name) : null,
    link: `/appointments/${num(row.id)}`,
  }));
}

export async function listRecordsWithoutInvoice(p: ResolvedPeriod): Promise<ProcessHealthRow[]> {
  const invFilter = billingPeriodFilter(p, sql`msr.year`, sql`msr.month`);
  const r = await db.execute(sql`
    SELECT msr.id, msr.year, msr.month, msr.customer_id,
      COALESCE(NULLIF(TRIM(CONCAT_WS(' ', c.vorname, c.nachname)), ''), c.name) AS label,
      u.display_name AS employee_name
    FROM monthly_service_records msr
    JOIN customers c ON c.id = msr.customer_id
    LEFT JOIN users u ON u.id = msr.employee_id
    WHERE msr.deleted_at IS NULL AND msr.status = 'completed'
      ${invFilter}
      AND NOT EXISTS (
        SELECT 1 FROM invoices i
        WHERE i.customer_id = msr.customer_id AND i.billing_year = msr.year AND i.billing_month = msr.month
          AND i.status != 'storniert' AND i.invoice_type != 'stornorechnung'
      )
    ORDER BY msr.year DESC, msr.month DESC LIMIT 500
  `);
  return r.rows.map((row: Record<string, unknown>) => ({
    id: num(row.id), serviceRecordId: num(row.id), customerId: num(row.customer_id),
    label: String(row.label ?? "Leistungsnachweis"),
    date: `${num(row.year)}-${String(num(row.month)).padStart(2, "0")}`,
    employeeName: row.employee_name ? String(row.employee_name) : null,
    link: `/service-records/${num(row.id)}`,
  }));
}
