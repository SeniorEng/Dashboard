import { Router, Request, Response } from "express";
import { timeTrackingStorage } from "../../storage/time-tracking";
import { 
  insertVacationAllowanceSchema,
} from "@shared/schema";
import { asyncHandler } from "../../lib/errors";

const router = Router();

// ============================================
// TIME TRACKING (Admin)
// ============================================

router.get("/time-entries", asyncHandler("Zeiteinträge konnten nicht geladen werden", async (req: Request, res: Response) => {
  const { year, month, userId, entryType } = req.query;
  
  const entries = await timeTrackingStorage.getAllTimeEntries({
    year: year ? parseInt(year as string) : undefined,
    month: month ? parseInt(month as string) : undefined,
    userId: userId ? parseInt(userId as string) : undefined,
    entryType: entryType as string | undefined,
  });
  
  res.json(entries);
}));

router.get("/employee-appointments", asyncHandler("Termine konnten nicht geladen werden", async (req: Request, res: Response) => {
  const { year, month, userId } = req.query;
  if (!year || !month) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Jahr und Monat sind erforderlich" });
    return;
  }
  const y = parseInt(year as string);
  const m = parseInt(month as string);
  const monthStr = m.toString().padStart(2, "0");
  const startDate = `${y}-${monthStr}-01`;
  const lastDay = new Date(y, m, 0).getDate();
  const endDate = `${y}-${monthStr}-${lastDay}`;

  if (userId && userId !== "all") {
    const uid = parseInt(userId as string);
    const appts = await timeTrackingStorage.getEmployeeAppointments(uid, startDate, endDate);
    res.json(appts.map(a => ({ ...a, assignedEmployeeId: uid })));
  } else {
    const { storage } = await import("../../storage");
    const employees = await storage.getEmployees();
    const allAppts: Array<any> = [];
    const seen = new Set<number>();
    for (const emp of employees) {
      const appts = await timeTrackingStorage.getEmployeeAppointments(emp.id, startDate, endDate);
      for (const a of appts) {
        if (!seen.has(a.id)) {
          seen.add(a.id);
          allAppts.push({ ...a, assignedEmployeeId: emp.id });
        }
      }
    }
    res.json(allAppts);
  }
}));

router.get("/time-entries/vacation-summary/:userId/:year", asyncHandler("Urlaubsübersicht konnte nicht geladen werden", async (req: Request, res: Response) => {
  const userId = parseInt(req.params.userId);
  const year = parseInt(req.params.year);
  
  if (isNaN(userId) || isNaN(year)) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Parameter" });
    return;
  }
  
  const summary = await timeTrackingStorage.getVacationSummary(userId, year);
  res.json(summary);
}));

router.put("/time-entries/vacation-allowance", asyncHandler("Urlaubskontingent konnte nicht aktualisiert werden", async (req: Request, res: Response) => {
  const validatedData = insertVacationAllowanceSchema.parse(req.body);
  const allowance = await timeTrackingStorage.setVacationAllowance(validatedData);
  res.json(allowance);
}));

export default router;
