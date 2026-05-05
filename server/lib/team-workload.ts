import { sql, type SQL } from "drizzle-orm";
import { db } from "./db";

export interface WorkloadRow {
  employeeId: number;
  primaryCount: number;
  backupCount: number;
  backup2Count: number;
  avgMonthlyHwMinutes: number;
  avgMonthlyAllMinutes: number;
  monthsConsidered: number;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export async function loadTeamWorkload(now: Date = new Date()): Promise<WorkloadRow[]> {
  const windowEnd = new Date(now.getFullYear(), now.getMonth(), 1);
  const windowStart = new Date(now.getFullYear(), now.getMonth() - 3, 1);
  const windowStartStr = `${windowStart.getFullYear()}-${pad2(windowStart.getMonth() + 1)}-01`;
  const windowEndStr = `${windowEnd.getFullYear()}-${pad2(windowEnd.getMonth() + 1)}-01`;
  const month0Start = windowStartStr;
  const month1Start = `${new Date(windowStart.getFullYear(), windowStart.getMonth() + 1, 1).getFullYear()}-${pad2(new Date(windowStart.getFullYear(), windowStart.getMonth() + 1, 1).getMonth() + 1)}-01`;
  const month2Start = `${new Date(windowStart.getFullYear(), windowStart.getMonth() + 2, 1).getFullYear()}-${pad2(new Date(windowStart.getFullYear(), windowStart.getMonth() + 2, 1).getMonth() + 1)}-01`;

  const result = await db.execute(workloadSql({
    windowStartStr,
    windowEndStr,
    monthStarts: [month0Start, month1Start, month2Start],
  }));

  return result.rows.map((row) => {
    const r = row as Record<string, unknown>;
    return {
      employeeId: Number(r.employeeId),
      primaryCount: Number(r.primaryCount),
      backupCount: Number(r.backupCount),
      backup2Count: Number(r.backup2Count),
      avgMonthlyHwMinutes: Number(r.avgMonthlyHwMinutes),
      avgMonthlyAllMinutes: Number(r.avgMonthlyAllMinutes),
      monthsConsidered: Number(r.monthsConsidered),
    };
  });
}

function workloadSql(params: {
  windowStartStr: string;
  windowEndStr: string;
  monthStarts: [string, string, string];
}): SQL {
  const { windowStartStr, windowEndStr, monthStarts } = params;
  return sql`
    WITH active_employees AS (
      SELECT id, eintrittsdatum FROM users WHERE is_active = true AND is_anonymized = false
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
      am.months_considered AS "monthsConsidered"
    FROM customer_counts cc
    JOIN avg_minutes am ON am.employee_id = cc.employee_id
  `;
}
