import { Router, Request, Response } from "express";
import { asyncHandler } from "../lib/errors";
import { requireAuth, requireTeamLeadOrAdmin } from "../middleware/auth";
import { getTeamLeadVisibleEmployeeIds } from "../lib/team-lead";
import {
  loadEmployeesWeeklyAvailability,
  buildDateRange,
  isValidCalendarDate,
} from "../services/employee-availability";
import { db } from "../lib/db";
import { users } from "@shared/schema";
import { and, eq, inArray, asc } from "drizzle-orm";

const router = Router();

router.use(requireAuth);
router.use(requireTeamLeadOrAdmin);

async function resolveVisibleEmployeeIds(req: Request): Promise<number[]> {
  const user = req.user!;
  if (user.isAdmin) {
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.isActive, true), eq(users.isAnonymized, false)));
    return rows.map((r) => r.id);
  }
  return getTeamLeadVisibleEmployeeIds(user.id);
}

router.get("/members", asyncHandler("Team-Mitglieder konnten nicht geladen werden", async (req: Request, res: Response) => {
  const user = req.user!;
  let memberIds: number[];
  if (user.isAdmin) {
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.isActive, true), eq(users.isAnonymized, false)));
    memberIds = rows.map((r) => r.id);
  } else {
    memberIds = await getTeamLeadVisibleEmployeeIds(user.id);
  }

  if (memberIds.length === 0) return res.json({ leadId: user.isAdmin ? null : user.id, members: [] });

  const rows = await db
    .select({
      id: users.id,
      displayName: users.displayName,
      vorname: users.vorname,
      nachname: users.nachname,
      teamLeadId: users.teamLeadId,
    })
    .from(users)
    .where(inArray(users.id, memberIds))
    .orderBy(asc(users.displayName));

  res.json({
    leadId: user.isAdmin ? null : user.id,
    members: rows.map((r) => ({
      id: r.id,
      displayName: r.displayName || `${r.vorname || ""} ${r.nachname || ""}`.trim(),
      isLead: !user.isAdmin && r.id === user.id,
      teamLeadId: r.teamLeadId,
    })),
  });
}));

router.get("/weekly-availability", asyncHandler("Wochen-Verfügbarkeit konnte nicht geladen werden", async (req: Request, res: Response) => {
  const { startDate, days: daysParam } = req.query;
  if (!startDate || typeof startDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !isValidCalendarDate(startDate)) {
    return res.status(400).json({ error: "Gültiges startDate im Format YYYY-MM-DD erforderlich" });
  }
  const days = Math.min(Math.max(parseInt(daysParam as string) || 5, 1), 7);
  const dates = buildDateRange(startDate, days);

  const employeeIds = await resolveVisibleEmployeeIds(req);
  if (employeeIds.length === 0) {
    return res.json({ dates, employees: [] });
  }

  const result = await loadEmployeesWeeklyAvailability(employeeIds, dates);
  res.json(result);
}));

export default router;
