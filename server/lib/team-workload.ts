import { sql, type SQL } from "drizzle-orm";
import { db } from "./db";

export type EmploymentType = "minijobber" | "sozialversicherungspflichtig";

export interface WorkloadRow {
  employeeId: number;
  primaryCount: number;
  backupCount: number;
  backup2Count: number;
  avgMonthlyHwMinutes: number;
  avgMonthlyAllMinutes: number;
  monthsConsidered: number;
  monthlyWorkHours: number | null;
  employmentType: EmploymentType;
}

export interface SollIstResult {
  istHours: number;
  auslastungPct: number | null;
  freieStunden: number | null;
  moeglicheZusatzKunden: number | null;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function buildMonthWindow(now: Date): {
  windowStartStr: string;
  windowEndStr: string;
  monthStarts: [string, string, string];
} {
  const windowEnd = new Date(now.getFullYear(), now.getMonth(), 1);
  const windowStart = new Date(now.getFullYear(), now.getMonth() - 3, 1);
  const windowStartStr = `${windowStart.getFullYear()}-${pad2(windowStart.getMonth() + 1)}-01`;
  const windowEndStr = `${windowEnd.getFullYear()}-${pad2(windowEnd.getMonth() + 1)}-01`;
  const m1 = new Date(windowStart.getFullYear(), windowStart.getMonth() + 1, 1);
  const m2 = new Date(windowStart.getFullYear(), windowStart.getMonth() + 2, 1);
  const month1Start = `${m1.getFullYear()}-${pad2(m1.getMonth() + 1)}-01`;
  const month2Start = `${m2.getFullYear()}-${pad2(m2.getMonth() + 1)}-01`;
  return {
    windowStartStr,
    windowEndStr,
    monthStarts: [windowStartStr, month1Start, month2Start],
  };
}

export async function loadTeamWorkload(now: Date = new Date()): Promise<WorkloadRow[]> {
  const window = buildMonthWindow(now);
  const result = await db.execute(workloadSql(window));

  return result.rows.map((row) => {
    const r = row as Record<string, unknown>;
    const empType = String(r.employmentType ?? "sozialversicherungspflichtig");
    const monthly = r.monthlyWorkHours;
    return {
      employeeId: Number(r.employeeId),
      primaryCount: Number(r.primaryCount),
      backupCount: Number(r.backupCount),
      backup2Count: Number(r.backup2Count),
      avgMonthlyHwMinutes: Number(r.avgMonthlyHwMinutes),
      avgMonthlyAllMinutes: Number(r.avgMonthlyAllMinutes),
      monthsConsidered: Number(r.monthsConsidered),
      monthlyWorkHours: monthly === null || monthly === undefined ? null : Number(monthly),
      employmentType: (empType === "minijobber" ? "minijobber" : "sozialversicherungspflichtig"),
    };
  });
}

/**
 * Pure calculation: ergibt Soll-Ist und mögliche Zusatzkunden für eine Workload-Zeile.
 * Edge cases:
 * - monthlyWorkHours null oder <= 0 → alle Kennzahlen null (UI zeigt Hinweis "Vertragsstunden fehlen").
 * - monthsConsidered 0 → istHours 0, Auslastung null.
 * - globalAvgHoursPerCustomerPerMonth <= 0 → moeglicheZusatzKunden null.
 * - istHours > sollHours → freieStunden 0, moeglicheZusatzKunden 0.
 */
export function computeSollIst(
  row: Pick<WorkloadRow, "avgMonthlyHwMinutes" | "avgMonthlyAllMinutes" | "monthsConsidered" | "monthlyWorkHours">,
  globalAvgHoursPerCustomerPerMonth: number,
): SollIstResult {
  const istHours = (row.avgMonthlyHwMinutes + row.avgMonthlyAllMinutes) / 60;

  if (row.monthlyWorkHours === null || row.monthlyWorkHours <= 0) {
    return { istHours, auslastungPct: null, freieStunden: null, moeglicheZusatzKunden: null };
  }
  if (row.monthsConsidered <= 0) {
    return { istHours: 0, auslastungPct: null, freieStunden: row.monthlyWorkHours, moeglicheZusatzKunden: null };
  }

  const sollHours = row.monthlyWorkHours;
  const auslastungPct = (istHours / sollHours) * 100;
  const freieStunden = Math.max(0, sollHours - istHours);

  let moeglicheZusatzKunden: number | null;
  if (globalAvgHoursPerCustomerPerMonth <= 0) {
    moeglicheZusatzKunden = null;
  } else {
    moeglicheZusatzKunden = Math.floor(freieStunden / globalAvgHoursPerCustomerPerMonth);
  }

  return { istHours, auslastungPct, freieStunden, moeglicheZusatzKunden };
}

function workloadSql(params: {
  windowStartStr: string;
  windowEndStr: string;
  monthStarts: [string, string, string];
}): SQL {
  const { windowStartStr, windowEndStr, monthStarts } = params;
  return sql`
    WITH active_employees AS (
      SELECT id, eintrittsdatum, monthly_work_hours, employment_type
      FROM users
      WHERE is_active = true AND is_anonymized = false
    ),
    customer_counts AS (
      SELECT
        ae.id AS employee_id,
        COUNT(DISTINCT CASE WHEN c.primary_employee_id = ae.id THEN c.id END)::int AS hv_count,
        COUNT(DISTINCT CASE WHEN c.backup_employee_id = ae.id THEN c.id END)::int AS v1_count,
        COUNT(DISTINCT CASE WHEN c.backup_employee_id_2 = ae.id THEN c.id END)::int AS v2_count
      FROM active_employees ae
      LEFT JOIN customers c ON (
        c.deleted_at IS NULL
        AND c.status = 'aktiv'
        AND (c.primary_employee_id = ae.id OR c.backup_employee_id = ae.id OR c.backup_employee_id_2 = ae.id)
      )
      GROUP BY ae.id
    ),
    period_hours AS (
      SELECT
        COALESCE(a.performed_by_employee_id, a.assigned_employee_id) AS employee_id,
        s.lohnart_kategorie,
        SUM(COALESCE(asvc.actual_duration_minutes, asvc.planned_duration_minutes))::numeric AS total_minutes
      FROM appointments a
      JOIN appointment_services asvc ON asvc.appointment_id = a.id
      JOIN services s ON s.id = asvc.service_id
      WHERE a.deleted_at IS NULL
        AND a.status IN ('completed', 'documented')
        AND a.date::date >= ${windowStartStr}::date
        AND a.date::date < ${windowEndStr}::date
        AND s.unit_type = 'hours'
        AND COALESCE(a.performed_by_employee_id, a.assigned_employee_id) IN (SELECT id FROM active_employees)
      GROUP BY COALESCE(a.performed_by_employee_id, a.assigned_employee_id), s.lohnart_kategorie
    ),
    months AS (
      SELECT ${monthStarts[0]}::date AS month_start
      UNION ALL SELECT ${monthStarts[1]}::date
      UNION ALL SELECT ${monthStarts[2]}::date
    ),
    month_workdays AS (
      SELECT
        ae.id AS employee_id,
        m.month_start,
        COUNT(*) FILTER (WHERE EXTRACT(ISODOW FROM d.day) < 6)::int AS total_workdays,
        COUNT(*) FILTER (
          WHERE EXTRACT(ISODOW FROM d.day) < 6
            AND (ae.eintrittsdatum IS NULL OR d.day >= ae.eintrittsdatum)
            AND NOT EXISTS (
              SELECT 1 FROM employee_time_entries ete
              WHERE ete.user_id = ae.id
                AND ete.entry_date = d.day
                AND ete.entry_type IN ('urlaub','krankheit')
                AND ete.deleted_at IS NULL
            )
        )::int AS available_workdays
      FROM active_employees ae
      CROSS JOIN months m
      CROSS JOIN LATERAL generate_series(
        m.month_start,
        (m.month_start + INTERVAL '1 month' - INTERVAL '1 day')::date,
        INTERVAL '1 day'
      ) AS d(day)
      GROUP BY ae.id, m.month_start
    ),
    months_considered AS (
      SELECT
        employee_id,
        SUM(
          CASE WHEN total_workdays > 0
            THEN LEAST(1.0, available_workdays::numeric / total_workdays)
            ELSE 0
          END
        )::numeric AS months_considered
      FROM month_workdays
      GROUP BY employee_id
    ),
    avg_minutes AS (
      SELECT
        ae.id AS employee_id,
        CASE WHEN COALESCE(mc.months_considered, 0) > 0
          THEN ROUND(COALESCE(SUM(CASE WHEN ph.lohnart_kategorie = 'hauswirtschaft' THEN ph.total_minutes END), 0) / mc.months_considered)::int
          ELSE 0 END AS avg_hw_minutes,
        CASE WHEN COALESCE(mc.months_considered, 0) > 0
          THEN ROUND(COALESCE(SUM(CASE WHEN ph.lohnart_kategorie = 'alltagsbegleitung' THEN ph.total_minutes END), 0) / mc.months_considered)::int
          ELSE 0 END AS avg_all_minutes,
        COALESCE(mc.months_considered, 0)::numeric AS months_considered
      FROM active_employees ae
      LEFT JOIN period_hours ph ON ph.employee_id = ae.id
      LEFT JOIN months_considered mc ON mc.employee_id = ae.id
      GROUP BY ae.id, mc.months_considered
    )
    SELECT
      cc.employee_id AS "employeeId",
      cc.hv_count AS "primaryCount",
      cc.v1_count AS "backupCount",
      cc.v2_count AS "backup2Count",
      am.avg_hw_minutes AS "avgMonthlyHwMinutes",
      am.avg_all_minutes AS "avgMonthlyAllMinutes",
      am.months_considered AS "monthsConsidered",
      ae.monthly_work_hours AS "monthlyWorkHours",
      ae.employment_type AS "employmentType"
    FROM customer_counts cc
    JOIN avg_minutes am ON am.employee_id = cc.employee_id
    JOIN active_employees ae ON ae.id = cc.employee_id
  `;
}

// ---------------------------------------------------------------------------
// Globale Referenz: Ø Stunden je Kunde je Monat (letzte 3 abgeschlossene Monate)
// ---------------------------------------------------------------------------

const GLOBAL_AVG_TTL_MS = 5 * 60 * 1000;
let globalAvgCache: { value: number; expiresAt: number } | null = null;

export function clearGlobalAvgCache(): void {
  globalAvgCache = null;
}

export async function getGlobalAvgHoursPerCustomerPerMonth(now: Date = new Date()): Promise<number> {
  if (globalAvgCache && globalAvgCache.expiresAt > Date.now()) {
    return globalAvgCache.value;
  }

  const { windowStartStr, windowEndStr } = buildMonthWindow(now);
  const result = await db.execute(sql`
    WITH appointment_minutes AS (
      SELECT
        a.customer_id,
        DATE_TRUNC('month', a.date::date)::date AS month_start,
        COALESCE(asvc.actual_duration_minutes, asvc.planned_duration_minutes)::numeric AS minutes
      FROM appointments a
      JOIN appointment_services asvc ON asvc.appointment_id = a.id
      JOIN services s ON s.id = asvc.service_id
      JOIN customers c ON c.id = a.customer_id
      WHERE a.deleted_at IS NULL
        AND a.status IN ('completed', 'documented')
        AND a.date::date >= ${windowStartStr}::date
        AND a.date::date < ${windowEndStr}::date
        AND s.unit_type = 'hours'
        AND c.deleted_at IS NULL
        AND c.status = 'aktiv'
        AND a.customer_id IS NOT NULL
    )
    SELECT
      COALESCE(SUM(minutes), 0)::numeric AS total_minutes,
      COUNT(DISTINCT (customer_id, month_start))::int AS customer_months
    FROM appointment_minutes
  `);

  const row = result.rows[0] as Record<string, unknown> | undefined;
  const totalMinutes = Number(row?.total_minutes ?? 0);
  const customerMonths = Number(row?.customer_months ?? 0);

  const avg = customerMonths > 0 ? totalMinutes / 60 / customerMonths : 0;
  globalAvgCache = { value: avg, expiresAt: Date.now() + GLOBAL_AVG_TTL_MS };
  return avg;
}
