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
