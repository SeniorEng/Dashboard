import { Router, Request, Response } from "express";
import { requireAuth } from "../middleware/auth";
import { handleRouteError } from "../lib/errors";
import { timeTrackingStorage } from "../storage/time-tracking";
import { insertTimeEntrySchema, updateTimeEntrySchema } from "@shared/schema";
import { storage } from "../storage";

/**
 * Convert time string (HH:MM, HH:MM:SS) or ISO timestamp to minutes since midnight
 * Handles both "16:30:00" and "2025-12-02T16:30:00.000Z" formats
 */
function timeToMinutes(time: string): number {
  if (!time || typeof time !== 'string') {
    return -1;
  }
  
  // Check if it's an ISO timestamp (contains 'T')
  if (time.includes('T')) {
    const date = new Date(time);
    if (isNaN(date.getTime())) {
      return -1;
    }
    return date.getHours() * 60 + date.getMinutes();
  }
  
  // Regular time string (HH:MM or HH:MM:SS)
  const parts = time.split(":");
  if (parts.length < 2) {
    return -1;
  }
  const hours = parseInt(parts[0], 10);
  const minutes = parseInt(parts[1], 10);
  if (isNaN(hours) || isNaN(minutes)) {
    return -1;
  }
  return hours * 60 + minutes;
}

/**
 * Check if two time ranges overlap
 */
function timeRangesOverlap(
  start1: number, end1: number,
  start2: number, end2: number
): boolean {
  return start1 < end2 && start2 < end1;
}

/**
 * Calculate appointment end time in minutes from midnight
 * Uses actualEnd > scheduledEnd > calculated duration (based on services + travel)
 */
function getAppointmentEndMinutes(appt: {
  scheduledStart: string;
  scheduledEnd: string | null;
  actualEnd: Date | string | null;
  hauswirtschaftActualDauer: number | null;
  hauswirtschaftDauer: number | null;
  alltagsbegleitungActualDauer: number | null;
  alltagsbegleitungDauer: number | null;
  erstberatungActualDauer: number | null;
  erstberatungDauer: number | null;
  travelMinutes: number | null;
}): number {
  const apptStart = timeToMinutes(appt.scheduledStart);
  
  // Prefer actualEnd if available (completed appointments)
  if (appt.actualEnd) {
    // Handle both Date objects and string timestamps
    if (appt.actualEnd instanceof Date) {
      return appt.actualEnd.getHours() * 60 + appt.actualEnd.getMinutes();
    }
    return timeToMinutes(appt.actualEnd);
  }
  
  // Then try scheduledEnd
  if (appt.scheduledEnd) {
    return timeToMinutes(appt.scheduledEnd);
  }
  
  // Calculate from service durations
  let duration = 0;
  if (appt.hauswirtschaftActualDauer) duration += appt.hauswirtschaftActualDauer;
  else if (appt.hauswirtschaftDauer) duration += appt.hauswirtschaftDauer;
  if (appt.alltagsbegleitungActualDauer) duration += appt.alltagsbegleitungActualDauer;
  else if (appt.alltagsbegleitungDauer) duration += appt.alltagsbegleitungDauer;
  if (appt.erstberatungActualDauer) duration += appt.erstberatungActualDauer;
  else if (appt.erstberatungDauer) duration += appt.erstberatungDauer;
  duration += appt.travelMinutes || 0;
  
  // Only use calculated duration if we have any service data
  if (duration > 0) {
    return apptStart + duration;
  }
  
  // No duration data at all - cannot determine end time, skip this appointment
  return -1;
}

/**
 * Check for time conflicts with existing appointments and time entries
 * Returns error message if conflict found, null otherwise
 */
async function checkTimeConflicts(
  userId: number,
  date: string,
  startTime: string | null | undefined,
  endTime: string | null | undefined,
  isFullDay: boolean,
  excludeEntryId?: number
): Promise<string | null> {
  // Get appointments for this date
  const appointments = await storage.getAppointmentsForDay(userId, date);
  
  // Filter out cancelled appointments
  const activeAppointments = appointments.filter(a => a.status !== 'cancelled');
  
  // Get time entries for this date
  const timeEntries = await timeTrackingStorage.getTimeEntriesForDate(userId, date);
  
  // Filter out the entry we're updating (if any)
  const otherEntries = excludeEntryId 
    ? timeEntries.filter(e => e.id !== excludeEntryId)
    : timeEntries;
  
  // For full-day entries, check if there are any other active appointments or entries
  if (isFullDay) {
    if (activeAppointments.length > 0) {
      const apptTimes = activeAppointments
        .map(a => a.scheduledStart)
        .slice(0, 3)
        .join(", ");
      return `An diesem Tag gibt es bereits Termine (${apptTimes})`;
    }
    if (otherEntries.length > 0) {
      const entryTypes = otherEntries.map(e => e.entryType).slice(0, 3).join(", ");
      return `An diesem Tag gibt es bereits Zeiteinträge (${entryTypes})`;
    }
    return null;
  }
  
  // For time-based entries, require both start and end times
  if (!startTime || !endTime) {
    // Allow entries without times to pass - they don't have a specific time range
    // and thus cannot overlap with timed entries
    return null;
  }
  
  const newStart = timeToMinutes(startTime);
  const newEnd = timeToMinutes(endTime);
  
  if (newEnd <= newStart) {
    return "Die Endzeit muss nach der Startzeit liegen";
  }
  
  // Check against active appointments
  for (const appt of activeAppointments) {
    const apptStart = timeToMinutes(appt.scheduledStart);
    const apptEnd = getAppointmentEndMinutes(appt);
    
    // Skip appointments with no determinable end time
    if (apptEnd === -1) continue;
    
    if (timeRangesOverlap(newStart, newEnd, apptStart, apptEnd)) {
      const customerName = appt.customer?.name || `${appt.customer?.vorname || ''} ${appt.customer?.nachname || ''}`.trim() || 'Unbekannt';
      return `Überlappung mit Termin um ${appt.scheduledStart.slice(0, 5)} Uhr bei ${customerName}`;
    }
  }
  
  // Check against other time entries
  for (const entry of otherEntries) {
    if (entry.isFullDay) {
      return `An diesem Tag ist bereits ein ganztägiger Eintrag (${entry.entryType}) vorhanden`;
    }
    
    if (entry.startTime && entry.endTime) {
      const entryStart = timeToMinutes(entry.startTime);
      const entryEnd = timeToMinutes(entry.endTime);
      
      if (timeRangesOverlap(newStart, newEnd, entryStart, entryEnd)) {
        return `Überlappung mit bestehendem Eintrag (${entry.entryType}) von ${entry.startTime} bis ${entry.endTime}`;
      }
    }
  }
  
  return null;
}

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
      
      // Check conflicts for all days first
      const currentDate = new Date(startDate);
      while (currentDate <= end) {
        const dateStr = formatLocalDate(currentDate);
        const conflict = await checkTimeConflicts(
          userId,
          dateStr,
          validatedData.startTime,
          validatedData.endTime,
          validatedData.isFullDay ?? true
        );
        if (conflict) {
          return res.status(400).json({ 
            error: `Konflikt am ${dateStr.split('-').reverse().join('.')}: ${conflict}` 
          });
        }
        currentDate.setDate(currentDate.getDate() + 1);
      }
      
      const entries = [];
      const currentDate2 = new Date(startDate);
      
      while (currentDate2 <= end) {
        const dateStr = formatLocalDate(currentDate2);
        const entry = await timeTrackingStorage.createTimeEntry(userId, {
          ...validatedData,
          entryDate: dateStr,
        });
        entries.push(entry);
        currentDate2.setDate(currentDate2.getDate() + 1);
      }
      
      // Return first entry for consistency, with count in header
      res.setHeader("X-Entries-Created", entries.length.toString());
      return res.status(201).json({ 
        ...entries[0],
        _multiDay: { count: entries.length, message: `${entries.length} Einträge erstellt` }
      });
    }
    
    // Single day entry - check for conflicts
    const conflict = await checkTimeConflicts(
      userId,
      validatedData.entryDate,
      validatedData.startTime,
      validatedData.endTime,
      validatedData.isFullDay ?? false
    );
    if (conflict) {
      return res.status(400).json({ error: conflict });
    }
    
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
    
    // Check for time conflicts with updated values
    const newDate = validatedData.entryDate ?? existing.entryDate;
    const newStartTime = validatedData.startTime !== undefined ? validatedData.startTime : existing.startTime;
    const newEndTime = validatedData.endTime !== undefined ? validatedData.endTime : existing.endTime;
    const newIsFullDay = validatedData.isFullDay !== undefined ? validatedData.isFullDay : existing.isFullDay;
    
    const conflict = await checkTimeConflicts(
      existing.userId,
      newDate,
      newStartTime,
      newEndTime,
      newIsFullDay,
      entryId // Exclude the entry being updated
    );
    if (conflict) {
      return res.status(400).json({ error: conflict });
    }
    
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
