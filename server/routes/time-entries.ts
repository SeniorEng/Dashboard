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
 * GET /time-entries/open-tasks
 * Get open tasks (missing breaks, etc.)
 */
router.get("/open-tasks", async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const openTasks = await timeTrackingStorage.getOpenTasks(userId);
    res.json(openTasks);
  } catch (error) {
    handleRouteError(res, error, "Offene Aufgaben konnten nicht geladen werden");
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
 * Helper to format date as YYYY-MM-DD without timezone issues
 */
function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Parse date string as local date components
 */
function parseLocalDate(dateStr: string): Date {
  const [year, month, day] = dateStr.split("-").map(Number);
  return new Date(year, month - 1, day, 12, 0, 0);
}

/**
 * Check if a date string is in the past (before today)
 */
function isDateInPast(dateStr: string): boolean {
  const entryDate = parseLocalDate(dateStr);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  entryDate.setHours(0, 0, 0, 0);
  return entryDate < today;
}

/**
 * Check if a time entry is locked (past urlaub/krankheit entries are immutable for non-admins)
 */
function isEntryLocked(entry: { entryType: string; entryDate: string }): boolean {
  const lockedTypes = ["urlaub", "krankheit"];
  return lockedTypes.includes(entry.entryType) && isDateInPast(entry.entryDate);
}

/**
 * POST /time-entries
 * Create a new time entry (or multiple for date ranges)
 */
router.post("/", async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { endDate, ...entryData } = req.body;
    const validatedData = insertTimeEntrySchema.parse(entryData);
    
    // For urlaub and krankheit with date range, create entries for each day
    if (endDate && typeof endDate === "string" && endDate.trim() && 
        (validatedData.entryType === "urlaub" || validatedData.entryType === "krankheit")) {
      
      // Validate endDate format
      if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
        return res.status(400).json({ error: "Ungültiges Datumsformat für Enddatum" });
      }
      
      const startDate = parseLocalDate(validatedData.entryDate);
      const end = parseLocalDate(endDate);
      
      if (end < startDate) {
        return res.status(400).json({ error: "Enddatum muss nach Startdatum liegen" });
      }
      
      const entries = [];
      const currentDate = new Date(startDate);
      
      while (currentDate <= end) {
        const dateStr = formatLocalDate(currentDate);
        const entry = await timeTrackingStorage.createTimeEntry(userId, {
          ...validatedData,
          entryDate: dateStr,
        });
        entries.push(entry);
        currentDate.setDate(currentDate.getDate() + 1);
      }
      
      // Return first entry for consistency, with count in header
      res.setHeader("X-Entries-Created", entries.length.toString());
      return res.status(201).json({ 
        ...entries[0],
        _multiDay: { count: entries.length, message: `${entries.length} Einträge erstellt` }
      });
    }
    
    // Single day entry
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
    
    // Past urlaub/krankheit entries are locked for non-admins
    if (isEntryLocked(existing) && !req.user!.isAdmin) {
      return res.status(403).json({ 
        error: "Vergangene Urlaubs- oder Krankheitstage können nicht mehr geändert werden" 
      });
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
    
    // Past urlaub/krankheit entries are locked for non-admins
    if (isEntryLocked(existing) && !req.user!.isAdmin) {
      return res.status(403).json({ 
        error: "Vergangene Urlaubs- oder Krankheitstage können nicht mehr gelöscht werden" 
      });
    }
    
    await timeTrackingStorage.deleteTimeEntry(entryId);
    res.status(204).send();
  } catch (error) {
    handleRouteError(res, error, "Zeiteintrag konnte nicht gelöscht werden");
  }
});

export default router;
