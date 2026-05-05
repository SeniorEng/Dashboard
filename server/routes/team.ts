import { Router, Request, Response, NextFunction } from "express";
import { sql } from "drizzle-orm";
import { db } from "../lib/db";
import { asyncHandler } from "../lib/errors";
import { authService } from "../services/auth";
import { sanitizeUser } from "../utils/sanitize-user";
import { isTeamLead } from "../lib/team-lead";

const router = Router();

// Admins UND Teamleitungen dürfen die Auslastungs-Übersicht abrufen.
// Reine Mitarbeiter erhalten 403, damit Workload-Daten nicht leaken.
function requireAdminOrTeamLead(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: "UNAUTHORIZED", message: "Bitte melden Sie sich an" });
    return;
  }
  if (req.user.isAdmin || isTeamLead(req.user)) {
    next();
    return;
  }
  res.status(403).json({ error: "FORBIDDEN", message: "Sie haben keine Berechtigung für diese Übersicht" });
}

router.use(requireAdminOrTeamLead);

router.get("/workload", asyncHandler("Team-Auslastung konnte nicht geladen werden", async (_req: Request, res: Response) => {
  const now = new Date();
  const windowEnd = new Date(now.getFullYear(), now.getMonth(), 1);
  const windowStart = new Date(now.getFullYear(), now.getMonth() - 3, 1);
  const windowStartStr = `${windowStart.getFullYear()}-${String(windowStart.getMonth() + 1).padStart(2, "0")}-01`;
  const windowEndStr = `${windowEnd.getFullYear()}-${String(windowEnd.getMonth() + 1).padStart(2, "0")}-01`;

  const [employees, workloadRows] = await Promise.all([
    authService.getActiveEmployees(),
    db.execute(sql`
      WITH active_employees AS (
        SELECT id FROM users WHERE is_active = true AND is_anonymized = false
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
      avg_minutes AS (
        SELECT
          ae.id AS employee_id,
          ROUND(COALESCE(SUM(CASE WHEN ph.lohnart_kategorie = 'hauswirtschaft' THEN ph.total_minutes END) / 3.0, 0))::int AS avg_hw_minutes,
          ROUND(COALESCE(SUM(CASE WHEN ph.lohnart_kategorie = 'alltagsbegleitung' THEN ph.total_minutes END) / 3.0, 0))::int AS avg_all_minutes
        FROM active_employees ae
        LEFT JOIN period_hours ph ON ph.employee_id = ae.id
        GROUP BY ae.id
      )
      SELECT
        cc.employee_id AS "employeeId",
        cc.hv_count AS "primaryCount",
        cc.v1_count AS "backupCount",
        cc.v2_count AS "backup2Count",
        am.avg_hw_minutes AS "avgMonthlyHwMinutes",
        am.avg_all_minutes AS "avgMonthlyAllMinutes"
      FROM customer_counts cc
      JOIN avg_minutes am ON am.employee_id = cc.employee_id
    `),
  ]);

  const workload: Record<number, {
    primaryCount: number;
    backupCount: number;
    backup2Count: number;
    avgMonthlyHwMinutes: number;
    avgMonthlyAllMinutes: number;
  }> = {};
  for (const row of workloadRows.rows) {
    const r = row as Record<string, unknown>;
    workload[Number(r.employeeId)] = {
      primaryCount: Number(r.primaryCount),
      backupCount: Number(r.backupCount),
      backup2Count: Number(r.backup2Count),
      avgMonthlyHwMinutes: Number(r.avgMonthlyHwMinutes),
      avgMonthlyAllMinutes: Number(r.avgMonthlyAllMinutes),
    };
  }

  const safeEmployees = employees.map((e) => {
    const safe = sanitizeUser(e);
    return {
      id: safe.id,
      displayName: safe.displayName,
      vorname: safe.vorname,
      nachname: safe.nachname,
      telefon: safe.telefon,
      roles: safe.roles ?? [],
      isActive: safe.isActive,
      isTeamLead: Boolean(safe.isTeamLead),
    };
  });

  res.json({ employees: safeEmployees, workload });
}));

export default router;
