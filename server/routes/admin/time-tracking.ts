import { Router, Request, Response } from "express";
import { timeTrackingStorage } from "../../storage/time-tracking";
import { compensationStorage } from "../../storage/compensation";
import { 
  insertVacationAllowanceSchema,
  insertEmployeeCompensationSchema,
} from "@shared/schema";
import { handleRouteError } from "../../lib/errors";
import { fromError } from "zod-validation-error";
import { todayISO } from "@shared/utils/datetime";

const router = Router();

// ============================================
// TIME TRACKING (Admin)
// ============================================

router.get("/time-entries", async (req: Request, res: Response) => {
  try {
    const { year, month, userId, entryType } = req.query;
    
    const entries = await timeTrackingStorage.getAllTimeEntries({
      year: year ? parseInt(year as string) : undefined,
      month: month ? parseInt(month as string) : undefined,
      userId: userId ? parseInt(userId as string) : undefined,
      entryType: entryType as string | undefined,
    });
    
    res.json(entries);
  } catch (error) {
    handleRouteError(res, error, "Zeiteinträge konnten nicht geladen werden");
  }
});

router.get("/time-entries/vacation-summary/:userId/:year", async (req: Request, res: Response) => {
  try {
    const userId = parseInt(req.params.userId);
    const year = parseInt(req.params.year);
    
    if (isNaN(userId) || isNaN(year)) {
      res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Parameter" });
      return;
    }
    
    const summary = await timeTrackingStorage.getVacationSummary(userId, year);
    res.json(summary);
  } catch (error) {
    handleRouteError(res, error, "Urlaubsübersicht konnte nicht geladen werden");
  }
});

router.put("/time-entries/vacation-allowance", async (req: Request, res: Response) => {
  try {
    const validatedData = insertVacationAllowanceSchema.parse(req.body);
    const allowance = await timeTrackingStorage.setVacationAllowance(validatedData);
    res.json(allowance);
  } catch (error: any) {
    if (error.name === "ZodError") {
      res.status(400).json({ error: "VALIDATION_ERROR", message: fromError(error).toString() });
      return;
    }
    handleRouteError(res, error, "Urlaubskontingent konnte nicht aktualisiert werden");
  }
});

// ============================================
// EMPLOYEE COMPENSATION
// ============================================

router.get("/users/:userId/compensation", async (req: Request, res: Response) => {
  try {
    const userId = parseInt(req.params.userId);
    if (isNaN(userId)) {
      res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Benutzer-ID" });
      return;
    }

    const history = await compensationStorage.getCompensationHistory(userId);
    res.json(history);
  } catch (error) {
    handleRouteError(res, error, "Vergütungshistorie konnte nicht geladen werden");
  }
});

router.get("/users/:userId/compensation/current", async (req: Request, res: Response) => {
  try {
    const userId = parseInt(req.params.userId);
    if (isNaN(userId)) {
      res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Benutzer-ID" });
      return;
    }

    const current = await compensationStorage.getCurrentCompensation(userId);
    res.json(current);
  } catch (error) {
    handleRouteError(res, error, "Aktuelle Vergütung konnte nicht geladen werden");
  }
});

router.post("/users/:userId/compensation", async (req: Request, res: Response) => {
  try {
    const userId = parseInt(req.params.userId);
    if (isNaN(userId)) {
      res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Benutzer-ID" });
      return;
    }

    const data = { ...req.body, userId };
    const validatedData = insertEmployeeCompensationSchema.parse(data);
    
    // Prevent backdated compensation entries - only today or future allowed
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
  } catch (error: any) {
    if (error.name === "ZodError") {
      res.status(400).json({ error: "VALIDATION_ERROR", message: fromError(error).toString() });
      return;
    }
    handleRouteError(res, error, "Vergütung konnte nicht hinzugefügt werden");
  }
});

export default router;
