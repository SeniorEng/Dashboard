import { Router, Request, Response } from "express";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { handleRouteError } from "../lib/errors";
import { timeTrackingStorage } from "../storage/time-tracking";
import { insertTimeEntrySchema, updateTimeEntrySchema, closeMonthSchema, reopenMonthSchema, employeeMonthClosings } from "@shared/schema";
import { storage } from "../storage";
import { timeToMinutes, isWeekend } from "@shared/utils/datetime";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { eq, and } from "drizzle-orm";
import { generateAutoBreaksForMonth, insertAutoBreaks, previewAutoBreaksForMonth, removeAutoBreaksForMonth } from "../services/auto-breaks";

const sqlClient = neon(process.env.DATABASE_URL!);
const db = drizzle(sqlClient);

const entryTypeLabels: Record<string, string> = {
  urlaub: "Urlaub",
  krankheit: "Krankheit",
  pause: "Pause",
  bueroarbeit: "Büroarbeit",
  vertrieb: "Vertrieb",
  schulung: "Schulung",
  besprechung: "Besprechung",
  sonstiges: "Sonstiges",
};

function getEntryTypeLabel(entryType: string): string {
  return entryTypeLabels[entryType] || entryType;
}

function formatTimeShort(time: string): string {
  return time.slice(0, 5);
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
 * Note: actualEnd is now stored as time string "HH:MM:SS" (harmonized system)
 */
function getAppointmentEndMinutes(appt: {
  scheduledStart: string;
  scheduledEnd: string | null;
  actualEnd: string | null;
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
      const entryTypes = otherEntries.map(e => getEntryTypeLabel(e.entryType)).slice(0, 3).join(", ");
      return `An diesem Tag gibt es bereits Zeiteinträge (${entryTypes})`;
    }
    return null;
  }
  
  // Even without times, check if there's a full-day entry blocking this date
  for (const entry of otherEntries) {
    if (entry.isFullDay) {
      return `An diesem Tag ist bereits ein ganztägiger Eintrag (${getEntryTypeLabel(entry.entryType)}) vorhanden`;
    }
  }
  
  // For time-based entries, require both start and end times for overlap checks
  if (!startTime || !endTime) {
    // Can't check time overlaps without specific times
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
      return `An diesem Tag ist bereits ein ganztägiger Eintrag (${getEntryTypeLabel(entry.entryType)}) vorhanden`;
    }
    
    if (entry.startTime && entry.endTime) {
      const entryStart = timeToMinutes(entry.startTime);
      const entryEnd = timeToMinutes(entry.endTime);
      
      if (timeRangesOverlap(newStart, newEnd, entryStart, entryEnd)) {
        return `Überlappung mit bestehendem Eintrag (${getEntryTypeLabel(entry.entryType)}) von ${formatTimeShort(entry.startTime)} bis ${formatTimeShort(entry.endTime)} Uhr`;
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
 * POST /time-entries/check-conflicts
 * Real-time check for time conflicts (for validation while typing)
 */
router.post("/check-conflicts", async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { date, startTime, endTime, isFullDay, excludeEntryId } = req.body;
    
    if (!date || typeof date !== "string") {
      return res.status(400).json({ error: "Datum erforderlich" });
    }
    
    const conflict = await checkTimeConflicts(
      userId,
      date,
      startTime || null,
      endTime || null,
      isFullDay ?? false,
      excludeEntryId
    );
    
    res.json({ conflict });
  } catch (error) {
    handleRouteError(res, error, "Konfliktprüfung fehlgeschlagen");
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

async function isMonthClosed(userId: number, dateStr: string): Promise<boolean> {
  const [yearStr, monthStr] = dateStr.split("-");
  const year = parseInt(yearStr);
  const month = parseInt(monthStr);
  const closing = await db
    .select()
    .from(employeeMonthClosings)
    .where(
      and(
        eq(employeeMonthClosings.userId, userId),
        eq(employeeMonthClosings.year, year),
        eq(employeeMonthClosings.month, month)
      )
    )
    .limit(1);
  return closing.length > 0 && !closing[0].reopenedAt;
}

async function getMonthClosing(userId: number, year: number, month: number) {
  const rows = await db
    .select()
    .from(employeeMonthClosings)
    .where(
      and(
        eq(employeeMonthClosings.userId, userId),
        eq(employeeMonthClosings.year, year),
        eq(employeeMonthClosings.month, month)
      )
    )
    .limit(1);
  return rows[0] || null;
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
      
      // Collect weekday dates (skip weekends)
      const weekdayDates: string[] = [];
      const collectDate = new Date(startDate);
      while (collectDate <= end) {
        const dateStr = formatLocalDate(collectDate);
        if (!isWeekend(dateStr)) {
          weekdayDates.push(dateStr);
        }
        collectDate.setDate(collectDate.getDate() + 1);
      }
      
      if (weekdayDates.length === 0) {
        return res.status(400).json({ error: "Der gewählte Zeitraum enthält nur Wochenendtage. Bitte wählen Sie einen Zeitraum mit Werktagen." });
      }
      
      if (!req.user!.isAdmin) {
        const checkedMonths = new Map<string, boolean>();
        for (const dateStr of weekdayDates) {
          const monthKey = dateStr.substring(0, 7);
          if (!checkedMonths.has(monthKey)) {
            checkedMonths.set(monthKey, await isMonthClosed(userId, dateStr));
          }
          if (checkedMonths.get(monthKey)) {
            return res.status(403).json({ 
              error: `Der Monat für ${dateStr.split('-').reverse().join('.')} ist bereits abgeschlossen. Nur ein Admin kann Änderungen vornehmen.` 
            });
          }
        }
      }
      
      // Check conflicts for all weekdays first
      for (const dateStr of weekdayDates) {
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
      }
      
      const entries = [];
      for (const dateStr of weekdayDates) {
        const entry = await timeTrackingStorage.createTimeEntry(userId, {
          ...validatedData,
          entryDate: dateStr,
        });
        entries.push(entry);
      }
      
      // Return first entry for consistency, with count in header
      res.setHeader("X-Entries-Created", entries.length.toString());
      return res.status(201).json({ 
        ...entries[0],
        _multiDay: { count: entries.length, message: `${entries.length} Einträge erstellt` }
      });
    }
    
    // Check month closing for single day
    if (!req.user!.isAdmin && await isMonthClosed(userId, validatedData.entryDate)) {
      return res.status(403).json({ error: "Dieser Monat ist bereits abgeschlossen. Nur ein Admin kann Änderungen vornehmen." });
    }
    
    // Single day entry - block weekends
    if (isWeekend(validatedData.entryDate)) {
      return res.status(400).json({ error: "Zeiteinträge können nicht an Samstagen oder Sonntagen erstellt werden." });
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
    
    // Month closing lock
    if (!req.user!.isAdmin && await isMonthClosed(existing.userId, existing.entryDate)) {
      return res.status(403).json({ error: "Dieser Monat ist bereits abgeschlossen. Nur ein Admin kann Änderungen vornehmen." });
    }
    
    const validatedData = updateTimeEntrySchema.parse(req.body);
    
    // Block weekend dates on update
    const dateToCheck = validatedData.entryDate ?? existing.entryDate;
    if (isWeekend(dateToCheck)) {
      return res.status(400).json({ error: "Zeiteinträge können nicht auf Samstage oder Sonntage gelegt werden." });
    }
    
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
    
    // Month closing lock
    if (!req.user!.isAdmin && await isMonthClosed(existing.userId, existing.entryDate)) {
      return res.status(403).json({ error: "Dieser Monat ist bereits abgeschlossen. Nur ein Admin kann Änderungen vornehmen." });
    }
    
    await timeTrackingStorage.deleteTimeEntry(entryId);
    res.status(204).send();
  } catch (error) {
    handleRouteError(res, error, "Zeiteintrag konnte nicht gelöscht werden");
  }
});

// ============================================
// MONTH CLOSING ENDPOINTS
// ============================================

router.get("/month-closings/admin/:year/:month", requireAdmin, async (req: Request, res: Response) => {
  try {
    const year = parseInt(req.params.year);
    const month = parseInt(req.params.month);

    if (isNaN(year) || isNaN(month) || month < 1 || month > 12) {
      return res.status(400).json({ error: "Ungültiges Jahr oder Monat" });
    }

    const closings = await db
      .select()
      .from(employeeMonthClosings)
      .where(
        and(
          eq(employeeMonthClosings.year, year),
          eq(employeeMonthClosings.month, month)
        )
      );

    res.json({ closings });
  } catch (error) {
    handleRouteError(res, error, "Monatsabschlüsse konnten nicht geladen werden");
  }
});

router.get("/month-closing/:year/:month", async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const year = parseInt(req.params.year);
    const month = parseInt(req.params.month);

    if (isNaN(year) || isNaN(month) || month < 1 || month > 12) {
      return res.status(400).json({ error: "Ungültiges Jahr oder Monat" });
    }

    const closing = await getMonthClosing(userId, year, month);
    res.json({ closing: closing || null });
  } catch (error) {
    handleRouteError(res, error, "Monatsabschluss konnte nicht geladen werden");
  }
});

router.get("/month-closing/:year/:month/preview", async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const year = parseInt(req.params.year);
    const month = parseInt(req.params.month);

    if (isNaN(year) || isNaN(month) || month < 1 || month > 12) {
      return res.status(400).json({ error: "Ungültiges Jahr oder Monat" });
    }

    const autoBreaks = await previewAutoBreaksForMonth(userId, year, month);
    res.json({ autoBreaks });
  } catch (error) {
    handleRouteError(res, error, "Vorschau konnte nicht erstellt werden");
  }
});

router.post("/close-month", async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const parsed = closeMonthSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Ungültige Eingabe" });
    }

    const { year, month } = parsed.data;

    const existing = await getMonthClosing(userId, year, month);
    if (existing && !existing.reopenedAt) {
      return res.status(400).json({ error: "Dieser Monat ist bereits abgeschlossen." });
    }

    const autoBreaks = await generateAutoBreaksForMonth(userId, year, month);
    const insertedCount = await insertAutoBreaks(userId, autoBreaks);

    if (existing && existing.reopenedAt) {
      await db
        .update(employeeMonthClosings)
        .set({
          closedAt: new Date(),
          closedByUserId: userId,
          reopenedAt: null,
          reopenedByUserId: null,
        })
        .where(eq(employeeMonthClosings.id, existing.id));
    } else {
      await db.insert(employeeMonthClosings).values({
        userId,
        year,
        month,
        closedByUserId: userId,
      });
    }

    res.json({
      message: `Monat ${month}/${year} abgeschlossen`,
      autoBreaksInserted: insertedCount,
    });
  } catch (error) {
    handleRouteError(res, error, "Monatsabschluss fehlgeschlagen");
  }
});

router.post("/reopen-month", requireAdmin, async (req: Request, res: Response) => {
  try {
    const parsed = reopenMonthSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Ungültige Eingabe: year, month und userId erforderlich" });
    }

    const { year, month, userId: targetUserId } = parsed.data;

    const existing = await getMonthClosing(targetUserId, year, month);
    if (!existing || existing.reopenedAt) {
      return res.status(400).json({ error: "Dieser Monat ist nicht abgeschlossen." });
    }

    await db
      .update(employeeMonthClosings)
      .set({
        reopenedAt: new Date(),
        reopenedByUserId: req.user!.id,
      })
      .where(eq(employeeMonthClosings.id, existing.id));

    await removeAutoBreaksForMonth(targetUserId, year, month);

    res.json({ message: `Monat ${month}/${year} wieder geöffnet` });
  } catch (error) {
    handleRouteError(res, error, "Monat konnte nicht wieder geöffnet werden");
  }
});

export default router;
