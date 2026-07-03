import { sql, type SQL } from "drizzle-orm";
import { db } from "./db";

type EmploymentType = "minijobber" | "sozialversicherungspflichtig";

type AssignmentRole = "HV" | "V1" | "V2";

interface CustomerAssignment {
  id: number;
  name: string;
  role: AssignmentRole;
}

export interface WorkloadRow {
  employeeId: number;
  primaryCount: number;
  backupCount: number;
  backup2Count: number;
  /** Ø selbst geleistete produktive HW-Minuten/Monat (alle Rollen, HV + Vertretung). */
  avgMonthlyHwMinutes: number;
  /** Ø selbst geleistete produktive Alltagsbegleitungs-Minuten/Monat (alle Rollen). */
  avgMonthlyAllMinutes: number;
  /** Ø produktive Minuten/Monat der EIGENEN HV-Kunden (HW + AB). Kapazitäts-Basis. */
  avgProdHvMinutes: number;
  /** Ø Overhead-Minuten/Monat (Büroarbeit/Vertrieb/Sonstiges). */
  avgOverheadMinutes: number;
  /** Ø Krank-/Urlaubs-Minuten/Monat. */
  avgSickVacMinutes: number;
  /** Beschäftigungsmonate im Fenster (0..3, fraktional). Divisor aller Ø-Werte. */
  monthsConsidered: number;
  monthlyWorkHours: number | null;
  employmentType: EmploymentType;
  assignments: CustomerAssignment[];
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
    const rawAssignments = r.assignments;
    let assignments: CustomerAssignment[] = [];
    if (Array.isArray(rawAssignments)) {
      assignments = rawAssignments
        .map((a): CustomerAssignment | null => {
          if (!a || typeof a !== "object") return null;
          const obj = a as Record<string, unknown>;
          const id = Number(obj.id);
          const name = String(obj.name ?? "").trim();
          const role = obj.role === "HV" || obj.role === "V1" || obj.role === "V2" ? obj.role : null;
          if (!Number.isFinite(id) || id <= 0 || !role) return null;
          return { id, name: name || `Kunde #${id}`, role };
        })
        .filter((a): a is CustomerAssignment => a !== null);
    }
    return {
      employeeId: Number(r.employeeId),
      primaryCount: Number(r.primaryCount),
      backupCount: Number(r.backupCount),
      backup2Count: Number(r.backup2Count),
      avgMonthlyHwMinutes: Number(r.avgMonthlyHwMinutes),
      avgMonthlyAllMinutes: Number(r.avgMonthlyAllMinutes),
      avgProdHvMinutes: Number(r.avgProdHvMinutes),
      avgOverheadMinutes: Number(r.avgOverheadMinutes),
      avgSickVacMinutes: Number(r.avgSickVacMinutes),
      monthsConsidered: Number(r.monthsConsidered),
      monthlyWorkHours: monthly === null || monthly === undefined ? null : Number(monthly),
      employmentType: (empType === "minijobber" ? "minijobber" : "sozialversicherungspflichtig"),
      assignments,
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
    customer_assignments AS (
      SELECT ae.id AS employee_id, c.id AS customer_id,
        TRIM(BOTH FROM (COALESCE(c.vorname,'') || ' ' || COALESCE(c.nachname,''))) AS name,
        'HV'::text AS role
      FROM active_employees ae
      JOIN customers c ON c.primary_employee_id = ae.id
      WHERE c.deleted_at IS NULL AND c.status = 'aktiv'
      UNION ALL
      SELECT ae.id, c.id,
        TRIM(BOTH FROM (COALESCE(c.vorname,'') || ' ' || COALESCE(c.nachname,''))),
        'V1'::text
      FROM active_employees ae
      JOIN customers c ON c.backup_employee_id = ae.id
      WHERE c.deleted_at IS NULL AND c.status = 'aktiv'
      UNION ALL
      SELECT ae.id, c.id,
        TRIM(BOTH FROM (COALESCE(c.vorname,'') || ' ' || COALESCE(c.nachname,''))),
        'V2'::text
      FROM active_employees ae
      JOIN customers c ON c.backup_employee_id_2 = ae.id
      WHERE c.deleted_at IS NULL AND c.status = 'aktiv'
    ),
    customer_assignments_agg AS (
      SELECT
        ae.id AS employee_id,
        COALESCE(
          json_agg(
            json_build_object('id', ca.customer_id, 'name', ca.name, 'role', ca.role)
            ORDER BY
              CASE ca.role WHEN 'HV' THEN 0 WHEN 'V1' THEN 1 WHEN 'V2' THEN 2 ELSE 3 END,
              ca.name
          ) FILTER (WHERE ca.customer_id IS NOT NULL),
          '[]'::json
        ) AS assignments
      FROM active_employees ae
      LEFT JOIN customer_assignments ca ON ca.employee_id = ae.id
      GROUP BY ae.id
    ),
    prod_minutes AS (
      -- Produktive Minuten je Mitarbeiter (= Durchführender, COALESCE
      -- performed/assigned), getrennt nach Kategorie und danach, ob er dabei
      -- Hauptverantwortlicher des Kunden ist (is_hv). prodPerformed = ALLE
      -- selbst geleisteten Minuten (HV + Vertretung) → Last-Seite; prodHV =
      -- nur is_hv → Kapazitäts-Seite. Vertretung fließt so in die Auslastung,
      -- aber nicht in die Kapazität pro HV-Kunde.
      SELECT
        COALESCE(a.performed_by_employee_id, a.assigned_employee_id) AS employee_id,
        s.lohnart_kategorie AS category,
        (c.primary_employee_id = COALESCE(a.performed_by_employee_id, a.assigned_employee_id)) AS is_hv,
        SUM(COALESCE(asvc.actual_duration_minutes, asvc.planned_duration_minutes))::numeric AS total_minutes
      FROM appointments a
      JOIN appointment_services asvc ON asvc.appointment_id = a.id
      JOIN services s ON s.id = asvc.service_id
      JOIN customers c ON c.id = a.customer_id
      WHERE a.deleted_at IS NULL
        AND a.status IN ('completed', 'documented')
        AND a.date::date >= ${windowStartStr}::date
        AND a.date::date < ${windowEndStr}::date
        AND s.unit_type = 'hours'
        AND s.lohnart_kategorie IN ('hauswirtschaft', 'alltagsbegleitung')
        AND COALESCE(a.performed_by_employee_id, a.assigned_employee_id) IN (SELECT id FROM active_employees)
      GROUP BY 1, 2, 3
    ),
    time_entry_minutes AS (
      -- Overhead (Büro/Vertrieb/Sonstiges) und Krank/Urlaub aus den
      -- Zeiterfassungen im selben Fenster. Kategorien identisch zur
      -- Statistik-Performance-Definition.
      SELECT
        ete.user_id AS employee_id,
        COALESCE(SUM(ete.duration_minutes) FILTER (WHERE ete.entry_type IN ('bueroarbeit','vertrieb','sonstiges')), 0)::numeric AS overhead_minutes,
        COALESCE(SUM(ete.duration_minutes) FILTER (WHERE ete.entry_type IN ('krankheit','urlaub')), 0)::numeric AS sickvac_minutes
      FROM employee_time_entries ete
      WHERE ete.deleted_at IS NULL
        AND ete.entry_date >= ${windowStartStr}::date
        AND ete.entry_date < ${windowEndStr}::date
        AND ete.user_id IN (SELECT id FROM active_employees)
      GROUP BY ete.user_id
    ),
    months AS (
      SELECT ${monthStarts[0]}::date AS month_start
      UNION ALL SELECT ${monthStarts[1]}::date
      UNION ALL SELECT ${monthStarts[2]}::date
    ),
    month_workdays AS (
      -- Beschäftigungs-Basis: Werktage ab Eintrittsdatum. Abwesenheit
      -- (Urlaub/Krankheit) schrumpft den Divisor NICHT mehr — sie wird
      -- ausschließlich über den expliziten sickVac-Abzug im SSoT verrechnet,
      -- damit Abwesenheit nicht doppelt zählt.
      SELECT
        ae.id AS employee_id,
        m.month_start,
        COUNT(*) FILTER (WHERE EXTRACT(ISODOW FROM d.day) < 6)::int AS total_workdays,
        COUNT(*) FILTER (
          WHERE EXTRACT(ISODOW FROM d.day) < 6
            AND (ae.eintrittsdatum IS NULL OR d.day >= ae.eintrittsdatum)
        )::int AS employed_workdays
      FROM active_employees ae
      CROSS JOIN months m
      CROSS JOIN LATERAL generate_series(
        m.month_start,
        (m.month_start + INTERVAL '1 month' - INTERVAL '1 day')::date,
        INTERVAL '1 day'
      ) AS d(day)
      GROUP BY ae.id, m.month_start
    ),
    window_months AS (
      SELECT
        employee_id,
        SUM(
          CASE WHEN total_workdays > 0
            THEN LEAST(1.0, employed_workdays::numeric / total_workdays)
            ELSE 0
          END
        )::numeric AS window_months
      FROM month_workdays
      GROUP BY employee_id
    ),
    avg_minutes AS (
      SELECT
        ae.id AS employee_id,
        CASE WHEN COALESCE(wm.window_months, 0) > 0
          THEN ROUND(COALESCE(SUM(pm.total_minutes) FILTER (WHERE pm.category = 'hauswirtschaft'), 0) / wm.window_months)::int
          ELSE 0 END AS avg_hw_minutes,
        CASE WHEN COALESCE(wm.window_months, 0) > 0
          THEN ROUND(COALESCE(SUM(pm.total_minutes) FILTER (WHERE pm.category = 'alltagsbegleitung'), 0) / wm.window_months)::int
          ELSE 0 END AS avg_all_minutes,
        CASE WHEN COALESCE(wm.window_months, 0) > 0
          THEN ROUND(COALESCE(SUM(pm.total_minutes) FILTER (WHERE pm.is_hv), 0) / wm.window_months)::int
          ELSE 0 END AS avg_prod_hv_minutes,
        COALESCE(wm.window_months, 0)::numeric AS months_considered
      FROM active_employees ae
      LEFT JOIN prod_minutes pm ON pm.employee_id = ae.id
      LEFT JOIN window_months wm ON wm.employee_id = ae.id
      GROUP BY ae.id, wm.window_months
    ),
    avg_time_entries AS (
      SELECT
        ae.id AS employee_id,
        CASE WHEN COALESCE(wm.window_months, 0) > 0
          THEN ROUND(COALESCE(tem.overhead_minutes, 0) / wm.window_months)::int
          ELSE 0 END AS avg_overhead_minutes,
        CASE WHEN COALESCE(wm.window_months, 0) > 0
          THEN ROUND(COALESCE(tem.sickvac_minutes, 0) / wm.window_months)::int
          ELSE 0 END AS avg_sickvac_minutes
      FROM active_employees ae
      LEFT JOIN time_entry_minutes tem ON tem.employee_id = ae.id
      LEFT JOIN window_months wm ON wm.employee_id = ae.id
    )
    SELECT
      cc.employee_id AS "employeeId",
      cc.hv_count AS "primaryCount",
      cc.v1_count AS "backupCount",
      cc.v2_count AS "backup2Count",
      am.avg_hw_minutes AS "avgMonthlyHwMinutes",
      am.avg_all_minutes AS "avgMonthlyAllMinutes",
      am.avg_prod_hv_minutes AS "avgProdHvMinutes",
      ate.avg_overhead_minutes AS "avgOverheadMinutes",
      ate.avg_sickvac_minutes AS "avgSickVacMinutes",
      am.months_considered AS "monthsConsidered",
      ae.monthly_work_hours AS "monthlyWorkHours",
      ae.employment_type AS "employmentType",
      caa.assignments AS "assignments"
    FROM customer_counts cc
    JOIN avg_minutes am ON am.employee_id = cc.employee_id
    JOIN avg_time_entries ate ON ate.employee_id = cc.employee_id
    JOIN active_employees ae ON ae.id = cc.employee_id
    LEFT JOIN customer_assignments_agg caa ON caa.employee_id = cc.employee_id
  `;
}

// ---------------------------------------------------------------------------
// Globale Referenz: Ø Stunden je Kunde je Monat (letzte 3 abgeschlossene Monate)
// ---------------------------------------------------------------------------

const GLOBAL_AVG_TTL_MS = 5 * 60 * 1000;
let globalAvgCache: { value: number; expiresAt: number } | null = null;

/**
 * Pure helper: errechnet aus den SQL-Aggregaten den Ø Stunden je Kunde je Monat.
 * - customerMonths == 0 → 0 (keine Datenbasis).
 * - sonst totalMinutes / 60 / customerMonths.
 * customerMonths kommt aus COUNT(DISTINCT (customer_id, month_start)), d.h.
 * jeder Kunde zählt pro Monat genau einmal, auch bei mehreren Terminen.
 */
export function computeGlobalAvgFromAggregates(totalMinutes: number, customerMonths: number): number {
  if (!Number.isFinite(totalMinutes) || !Number.isFinite(customerMonths) || customerMonths <= 0) {
    return 0;
  }
  return totalMinutes / 60 / customerMonths;
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

  const avg = computeGlobalAvgFromAggregates(totalMinutes, customerMonths);
  globalAvgCache = { value: avg, expiresAt: Date.now() + GLOBAL_AVG_TTL_MS };
  return avg;
}
