import { Router, Request, Response } from "express";
import { timeTrackingStorage } from "../../storage/time-tracking";
import { compensationStorage } from "../../storage/compensation";
import { 
  insertVacationAllowanceSchema,
  insertEmployeeCompensationSchema,
} from "@shared/schema";
import { asyncHandler } from "../../lib/errors";
import { todayISO } from "@shared/utils/datetime";

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

// ============================================
// EMPLOYEE COMPENSATION
// ============================================

router.get("/users/:userId/compensation", asyncHandler("Vergütungshistorie konnte nicht geladen werden", async (req: Request, res: Response) => {
  const userId = parseInt(req.params.userId);
  if (isNaN(userId)) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Benutzer-ID" });
    return;
  }

  const history = await compensationStorage.getCompensationHistory(userId);
  res.json(history);
}));

router.get("/users/:userId/compensation/current", asyncHandler("Aktuelle Vergütung konnte nicht geladen werden", async (req: Request, res: Response) => {
  const userId = parseInt(req.params.userId);
  if (isNaN(userId)) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Benutzer-ID" });
    return;
  }

  const current = await compensationStorage.getCurrentCompensation(userId);
  res.json(current);
}));

router.post("/users/:userId/compensation", asyncHandler("Vergütung konnte nicht hinzugefügt werden", async (req: Request, res: Response) => {
  const userId = parseInt(req.params.userId);
  if (isNaN(userId)) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Benutzer-ID" });
    return;
  }

  const data = { ...req.body, userId };
  const validatedData = insertEmployeeCompensationSchema.parse(data);
  
  const today = todayISO();
  if (validatedData.validFrom < today) {
    res.status(400).json({ 
      error: "VALIDATION_ERROR", 
      message: "Vergütung kann nicht rückwirkend angelegt werden. Bitte wählen Sie ein Datum ab heute." 
    });
    return;
  }
  
  const compensation = await compensationStorage.addCompensation(validatedData, req.user!.id);
  res.status(201).json(compensation);
}));

export default router;
