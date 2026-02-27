import { Router, Request, Response } from "express";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { asyncHandler } from "../lib/errors";
import { timeTrackingStorage } from "../storage/time-tracking";
import { insertTimeEntrySchema, updateTimeEntrySchema } from "@shared/schema";
import { storage } from "../storage";
import { authService } from "../services/auth";
import { auditService } from "../services/audit";
import { timeToMinutes, isWeekend, parseLocalDate, isPast, formatDateISO } from "@shared/utils/datetime";
import { getEntryTypeLabel, formatTimeShort, timeRangesOverlap, getAppointmentEndMinutes } from "@shared/domain/time-entries";
import monthClosingRouter from "./month-closing";

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
  excludeEntryId?: number,
  entryType?: string
): Promise<string | null> {
  if (entryType === "verfuegbar") {
    return null;
  }

  // Get appointments for this date
  const appointments = await storage.getAppointmentsForDay(userId, date);
  
  // Filter out cancelled appointments
  const activeAppointments = appointments.filter(a => a.status !== 'cancelled');
  
  // Get time entries for this date
  const timeEntries = await timeTrackingStorage.getTimeEntriesForDate(userId, date);
  
  // Filter out the entry we're updating (if any) and verfuegbar entries (organizational only)
  const otherEntries = timeEntries
    .filter(e => e.id !== excludeEntryId)
    .filter(e => e.entryType !== "verfuegbar");
  
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
router.get("/", asyncHandler("Zeiteinträge konnten nicht geladen werden", async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const { year, month, entryType } = req.query;
  
  const entries = await timeTrackingStorage.getTimeEntries(userId, {
    year: year ? parseInt(year as string) : undefined,
    month: month ? parseInt(month as string) : undefined,
    entryType: entryType as string | undefined,
  });
  
  res.json(entries);
}));

/**
 * GET /time-entries/vacation-summary/:year
 * Get vacation summary for a specific year
 */
router.get("/vacation-summary/:year", asyncHandler("Urlaubsübersicht konnte nicht geladen werden", async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const year = parseInt(req.params.year);
  
  if (isNaN(year) || year < 2020 || year > 2100) {
    return res.status(400).json({ error: "Ungültiges Jahr" });
  }
  
  const summary = await timeTrackingStorage.getVacationSummary(userId, year);
  res.json(summary);
}));

/**
 * GET /time-entries/page-data/:year/:month
 * Combined endpoint: overview + vacation-summary + open-tasks in one call
 */
router.get("/page-data/:year/:month", asyncHandler("Zeitdaten konnten nicht geladen werden", async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const year = parseInt(req.params.year);
  const month = parseInt(req.params.month);
  
  if (isNaN(year) || year < 2020 || year > 2100) {
    return res.status(400).json({ error: "Ungültiges Jahr" });
  }
  
  if (isNaN(month) || month < 1 || month > 12) {
    return res.status(400).json({ error: "Ungültiger Monat" });
  }
  
  const [overview, vacationSummary, openTasks] = await Promise.all([
    timeTrackingStorage.getTimeOverview(userId, { year, month }),
    timeTrackingStorage.getVacationSummary(userId, year),
    timeTrackingStorage.getOpenTasks(userId),
  ]);
  
  res.json({ overview, vacationSummary, openTasks });
}));

/**
 * GET /time-entries/overview/:year/:month
 * Get complete time overview for a month (appointments + time entries)
 */
router.get("/overview/:year/:month", asyncHandler("Zeitübersicht konnte nicht geladen werden", async (req: Request, res: Response) => {
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
}));

/**
 * GET /time-entries/open-tasks
 * Get open tasks (missing breaks, etc.)
 */
router.get("/open-tasks", asyncHandler("Offene Aufgaben konnten nicht geladen werden", async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const openTasks = await timeTrackingStorage.getOpenTasks(userId);
  res.json(openTasks);
}));

/**
 * POST /time-entries/check-conflicts
 * Real-time check for time conflicts (for validation while typing)
 */
router.post("/check-conflicts", asyncHandler("Konfliktprüfung fehlgeschlagen", async (req: Request, res: Response) => {
  const { date, startTime, endTime, isFullDay, excludeEntryId, targetUserId } = req.body;

  let userId = req.user!.id;
  const parsedTarget = targetUserId != null ? Number(targetUserId) : undefined;
  if (req.user!.isAdmin && parsedTarget != null && Number.isInteger(parsedTarget) && parsedTarget !== req.user!.id) {
    userId = parsedTarget;
  }
  
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
}));

/**
 * GET /time-entries/:id
 * Get a specific time entry
 */
router.get("/:id", asyncHandler("Zeiteintrag konnte nicht geladen werden", async (req: Request, res: Response) => {
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
}));


/**
 * Check if a time entry is locked (past urlaub/krankheit entries are immutable for non-admins)
 */
function isEntryLocked(entry: { entryType: string; entryDate: string }): boolean {
  const lockedTypes = ["urlaub", "krankheit"];
  return lockedTypes.includes(entry.entryType) && isPast(entry.entryDate);
}


/**
 * POST /time-entries
 * Create a new time entry (or multiple for date ranges)
 */
router.post("/", asyncHandler("Zeiteintrag konnte nicht erstellt werden", async (req: Request, res: Response) => {
  const { endDate, targetUserId, ...entryData } = req.body;
  
  let userId = req.user!.id;
  const parsedTargetUserId = targetUserId != null ? Number(targetUserId) : undefined;
  const isAdminActingForOther = req.user!.isAdmin && parsedTargetUserId != null && Number.isInteger(parsedTargetUserId) && parsedTargetUserId !== req.user!.id;
  
  if (isAdminActingForOther) {
    const targetUser = await authService.getUser(parsedTargetUserId);
    if (!targetUser) {
      return res.status(400).json({ error: "Mitarbeiter nicht gefunden" });
    }
    userId = parsedTargetUserId;
  }
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
      const dateStr = formatDateISO(collectDate);
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
          checkedMonths.set(monthKey, await timeTrackingStorage.isMonthClosed(userId, dateStr));
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
        validatedData.isFullDay ?? true,
        undefined,
        validatedData.entryType
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
    
    for (const e of entries) {
      await auditService.log(req.user!.id, isAdminActingForOther ? "admin_time_entry_created" : "time_entry_created", "time_entry", e.id, {
        entryType: validatedData.entryType,
        entryDate: e.entryDate,
        isFullDay: validatedData.isFullDay ?? true,
        multiDay: true,
        totalEntries: entries.length,
        ...(isAdminActingForOther ? { adminUserId: req.user!.id, targetUserId: userId } : {}),
      }, req.ip);
    }

    // Return first entry for consistency, with count in header
    res.setHeader("X-Entries-Created", entries.length.toString());
    return res.status(201).json({ 
      ...entries[0],
      _multiDay: { count: entries.length, message: `${entries.length} Einträge erstellt` }
    });
  }
  
  // Check month closing for single day
  if (!req.user!.isAdmin && await timeTrackingStorage.isMonthClosed(userId, validatedData.entryDate)) {
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
    validatedData.isFullDay ?? false,
    undefined,
    validatedData.entryType
  );
  if (conflict) {
    return res.status(400).json({ error: conflict });
  }
  
  const entry = await timeTrackingStorage.createTimeEntry(userId, validatedData);

  await auditService.log(req.user!.id, isAdminActingForOther ? "admin_time_entry_created" : "time_entry_created", "time_entry", entry.id, {
    entryType: validatedData.entryType,
    entryDate: validatedData.entryDate,
    startTime: validatedData.startTime || null,
    endTime: validatedData.endTime || null,
    isFullDay: validatedData.isFullDay ?? false,
    ...(isAdminActingForOther ? { adminUserId: req.user!.id, targetUserId: userId } : {}),
  }, req.ip);

  res.status(201).json(entry);
}));

/**
 * PUT /time-entries/:id
 * Update a time entry
 */
router.put("/:id", asyncHandler("Zeiteintrag konnte nicht aktualisiert werden", async (req: Request, res: Response) => {
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
  if (!req.user!.isAdmin && await timeTrackingStorage.isMonthClosed(existing.userId, existing.entryDate)) {
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
  
  const newEntryType = validatedData.entryType ?? existing.entryType;
  const conflict = await checkTimeConflicts(
    existing.userId,
    newDate,
    newStartTime,
    newEndTime,
    newIsFullDay,
    entryId,
    newEntryType
  );
  if (conflict) {
    return res.status(400).json({ error: conflict });
  }
  
  const updated = await timeTrackingStorage.updateTimeEntry(entryId, validatedData);

  const changedFields: string[] = [];
  const oldValues: Record<string, unknown> = {};
  const newValues: Record<string, unknown> = {};
  for (const key of Object.keys(validatedData) as Array<keyof typeof validatedData>) {
    if (validatedData[key] !== undefined && validatedData[key] !== (existing as any)[key]) {
      changedFields.push(key);
      oldValues[key] = (existing as any)[key];
      newValues[key] = validatedData[key];
    }
  }

  const isAdminEditingOther = req.user!.isAdmin && existing.userId !== req.user!.id;
  await auditService.log(req.user!.id, isAdminEditingOther ? "admin_time_entry_updated" : "time_entry_updated", "time_entry", entryId, {
    entryType: existing.entryType,
    entryDate: existing.entryDate,
    changedFields,
    oldValues,
    newValues,
    ...(isAdminEditingOther ? { adminUserId: req.user!.id, targetUserId: existing.userId } : {}),
  }, req.ip);

  res.json(updated);
}));

/**
 * DELETE /time-entries/:id
 * Delete a time entry
 */
router.delete("/:id", asyncHandler("Zeiteintrag konnte nicht gelöscht werden", async (req: Request, res: Response) => {
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
  if (!req.user!.isAdmin && await timeTrackingStorage.isMonthClosed(existing.userId, existing.entryDate)) {
    return res.status(403).json({ error: "Dieser Monat ist bereits abgeschlossen. Nur ein Admin kann Änderungen vornehmen." });
  }
  
  await timeTrackingStorage.deleteTimeEntry(entryId);

  const isAdminDeletingOther = req.user!.isAdmin && existing.userId !== req.user!.id;
  await auditService.log(req.user!.id, isAdminDeletingOther ? "admin_time_entry_deleted" : "time_entry_deleted", "time_entry", entryId, {
    entryType: existing.entryType,
    entryDate: existing.entryDate,
    startTime: existing.startTime,
    endTime: existing.endTime,
    isFullDay: existing.isFullDay,
    ...(isAdminDeletingOther ? { adminUserId: req.user!.id, targetUserId: existing.userId } : {}),
  }, req.ip);

  res.status(204).send();
}));

// ============================================
router.use(monthClosingRouter);

export default router;
