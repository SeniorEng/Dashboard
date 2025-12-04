import { Router, Request, Response } from "express";
import { requireAuth } from "../middleware/auth";
import { handleRouteError } from "../lib/errors";
import { timeTrackingStorage } from "../storage/time-tracking";
import { insertTimeEntrySchema, updateTimeEntrySchema } from "@shared/schema";

const router = Router();

// All routes require authentication
router.use(requireAuth);

/**
 * GET /time-entries
 * Get time entries for the authenticated user
 * Query params: year, month, entryType
 */
router.get("/", async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { year, month, entryType } = req.query;
    
    const entries = await timeTrackingStorage.getTimeEntries(userId, {
      year: year ? parseInt(year as string) : undefined,
      month: month ? parseInt(month as string) : undefined,
      entryType: entryType as string | undefined,
    });
    
    res.json(entries);
  } catch (error) {
    handleRouteError(res, error, "Zeiteinträge konnten nicht geladen werden");
  }
});

/**
 * GET /time-entries/vacation-summary/:year
 * Get vacation summary for a specific year
 */
router.get("/vacation-summary/:year", async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const year = parseInt(req.params.year);
    
    if (isNaN(year) || year < 2020 || year > 2100) {
      return res.status(400).json({ error: "Ungültiges Jahr" });
    }
    
    const summary = await timeTrackingStorage.getVacationSummary(userId, year);
    res.json(summary);
  } catch (error) {
    handleRouteError(res, error, "Urlaubsübersicht konnte nicht geladen werden");
  }
});

/**
 * GET /time-entries/overview/:year/:month
 * Get complete time overview for a month (appointments + time entries)
 */
router.get("/overview/:year/:month", async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const year = parseInt(req.params.year);
    const month = parseInt(req.params.month);
    
    if (isNaN(year) || year < 2020 || year > 2100) {
      return res.status(400).json({ error: "Ungültiges Jahr" });
    }
    
    if (isNaN(month) || month < 1 || month > 12) {
      return res.status(400).json({ error: "Ungültiger Monat" });
    }
    
    const overview = await timeTrackingStorage.getTimeOverview(userId, { year, month });
    res.json(overview);
  } catch (error) {
    handleRouteError(res, error, "Zeitübersicht konnte nicht geladen werden");
  }
});

/**
 * GET /time-entries/:id
 * Get a specific time entry
 */
router.get("/:id", async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const entryId = parseInt(req.params.id);
    
    const entry = await timeTrackingStorage.getTimeEntry(entryId);
    
    if (!entry) {
      return res.status(404).json({ error: "Zeiteintrag nicht gefunden" });
    }
    
    // Users can only view their own entries (unless admin)
    if (entry.userId !== userId && !req.user!.isAdmin) {
      return res.status(403).json({ error: "Keine Berechtigung" });
    }
    
    res.json(entry);
  } catch (error) {
    handleRouteError(res, error, "Zeiteintrag konnte nicht geladen werden");
  }
});

/**
 * POST /time-entries
 * Create a new time entry
 */
router.post("/", async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const validatedData = insertTimeEntrySchema.parse(req.body);
    
    const entry = await timeTrackingStorage.createTimeEntry(userId, validatedData);
    res.status(201).json(entry);
  } catch (error) {
    handleRouteError(res, error, "Zeiteintrag konnte nicht erstellt werden");
  }
});

/**
 * PUT /time-entries/:id
 * Update a time entry
 */
router.put("/:id", async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const entryId = parseInt(req.params.id);
    
    const existing = await timeTrackingStorage.getTimeEntry(entryId);
    if (!existing) {
      return res.status(404).json({ error: "Zeiteintrag nicht gefunden" });
    }
    
    // Users can only update their own entries (unless admin)
    if (existing.userId !== userId && !req.user!.isAdmin) {
      return res.status(403).json({ error: "Keine Berechtigung" });
    }
    
    const validatedData = updateTimeEntrySchema.parse(req.body);
    const updated = await timeTrackingStorage.updateTimeEntry(entryId, validatedData);
    
    res.json(updated);
  } catch (error) {
    handleRouteError(res, error, "Zeiteintrag konnte nicht aktualisiert werden");
  }
});

/**
 * DELETE /time-entries/:id
 * Delete a time entry
 */
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const entryId = parseInt(req.params.id);
    
    const existing = await timeTrackingStorage.getTimeEntry(entryId);
    if (!existing) {
      return res.status(404).json({ error: "Zeiteintrag nicht gefunden" });
    }
    
    // Users can only delete their own entries (unless admin)
    if (existing.userId !== userId && !req.user!.isAdmin) {
      return res.status(403).json({ error: "Keine Berechtigung" });
    }
    
    await timeTrackingStorage.deleteTimeEntry(entryId);
    res.status(204).send();
  } catch (error) {
    handleRouteError(res, error, "Zeiteintrag konnte nicht gelöscht werden");
  }
});

export default router;
