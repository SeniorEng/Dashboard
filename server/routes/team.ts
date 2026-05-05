import { Router, Request, Response, NextFunction } from "express";
import { asyncHandler } from "../lib/errors";
import { authService } from "../services/auth";
import { sanitizeUser } from "../utils/sanitize-user";
import { isTeamLead } from "../lib/team-lead";
import { loadTeamWorkload, getGlobalAvgHoursPerCustomerPerMonth } from "../lib/team-workload";

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
  const [employees, workloadRows, globalAvgHoursPerCustomerPerMonth] = await Promise.all([
    authService.getActiveEmployees(),
    loadTeamWorkload(),
    getGlobalAvgHoursPerCustomerPerMonth(),
  ]);

  const workload: Record<number, {
    primaryCount: number;
    backupCount: number;
    backup2Count: number;
    avgMonthlyHwMinutes: number;
    avgMonthlyAllMinutes: number;
    monthsConsidered: number;
    monthlyWorkHours: number | null;
    employmentType: "minijobber" | "sozialversicherungspflichtig";
    assignments: { id: number; name: string; role: "HV" | "V1" | "V2" }[];
  }> = {};
  for (const r of workloadRows) {
    workload[r.employeeId] = {
      primaryCount: r.primaryCount,
      backupCount: r.backupCount,
      backup2Count: r.backup2Count,
      avgMonthlyHwMinutes: r.avgMonthlyHwMinutes,
      avgMonthlyAllMinutes: r.avgMonthlyAllMinutes,
      monthsConsidered: r.monthsConsidered,
      monthlyWorkHours: r.monthlyWorkHours,
      employmentType: r.employmentType,
      assignments: r.assignments,
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

  res.json({ employees: safeEmployees, workload, globalAvgHoursPerCustomerPerMonth });
}));

export default router;
