import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { asyncHandler, sendBadRequest, sendNotFound, sendForbidden } from "../lib/errors";
import { requireIntParam } from "../lib/params";
import { createSeriesSchema, updateSeriesSchema, type Weekday } from "@shared/schema";
import * as seriesStorage from "../storage/appointment-series-storage";
import { validateSeriesDates, createSeriesAppointments } from "../services/appointment-series";
import { storage } from "../storage";
import { timeTrackingStorage } from "../storage/time-tracking";
import { budgetLedgerStorage } from "../storage/budget-ledger";
import { todayISO, addMinutesToTimeHHMMSS } from "@shared/utils/datetime";
import { db } from "../lib/db";

const router = Router();
router.use(requireAuth);

async function checkSeriesAccess(
  user: { id: number; isAdmin: boolean },
  series: { assignedEmployeeId: number; customerId: number },
): Promise<boolean> {
  if (user.isAdmin) return true;
  return series.assignedEmployeeId === user.id;
}

async function collectEligibleFutureIds(
  seriesId: number,
  fromDate: string,
  options?: { includeExceptions?: boolean },
): Promise<number[]> {
  const futureAppointments = await seriesStorage.getFutureSeriesAppointments(seriesId, fromDate, options);
  const eligibleIds: number[] = [];

  for (const apt of futureAppointments) {
    if (apt.status === "completed") continue;

    const employeeId = apt.assignedEmployeeId || apt.performedByEmployeeId;
    if (employeeId) {
      const monthClosed = await timeTrackingStorage.isMonthClosed(employeeId, apt.date);
      if (monthClosed) continue;
    }

    const isLocked = await storage.isAppointmentLocked(apt.id);
    if (isLocked) continue;

    eligibleIds.push(apt.id);
  }

  return eligibleIds;
}

function formatDateFromObj(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

router.post("/", asyncHandler("Serie konnte nicht erstellt werden", async (req, res) => {
  const user = req.user!;
  const parsed = createSeriesSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendBadRequest(res, "Validierungsfehler: " + parsed.error.issues.map(i => i.message).join(", "));
  }
  const input = parsed.data;

  const customer = await storage.getCustomer(input.customerId);
  if (!customer) return sendNotFound(res, "Kunde nicht gefunden.");

  if (!user.isAdmin) {
    input.assignedEmployeeId = user.id;
    const assignedIds = await storage.getCurrentlyAssignedCustomerIds(user.id);
    if (!assignedIds.includes(input.customerId)) {
      return sendForbidden(res, "NOT_ASSIGNED", "Sie sind diesem Kunden nicht zugeordnet.");
    }
  } else {
    const isAssigned =
      customer.primaryEmployeeId === input.assignedEmployeeId ||
      customer.backupEmployeeId === input.assignedEmployeeId ||
      customer.backupEmployeeId2 === input.assignedEmployeeId;
    if (!isAssigned) {
      return sendBadRequest(res, "Der Mitarbeiter ist diesem Kunden nicht zugeordnet.");
    }
  }

  if (input.startDate >= input.endDate) {
    return sendBadRequest(res, "Das Enddatum muss nach dem Startdatum liegen.");
  }

  const validation = await validateSeriesDates(input);

  if (!validation.valid) {
    return res.status(409).json({
      error: "SERIES_VALIDATION",
      message: validation.error || "Keine gültigen Termine gefunden.",
      conflicts: validation.conflicts,
      dates: validation.dates,
    });
  }

  const totalDuration = input.services.reduce((sum, s) => sum + s.durationMinutes, 0);

  const result = await db.transaction(async (tx) => {
    const series = await seriesStorage.createSeries({
      customerId: input.customerId,
      assignedEmployeeId: input.assignedEmployeeId,
      createdByUserId: user.id,
      frequency: input.frequency,
      weekdays: input.weekdays,
      scheduledStart: input.scheduledStart,
      durationMinutes: totalDuration,
      serviceIds: input.services.map(s => s.serviceId),
      serviceDurations: input.services.map(s => s.durationMinutes),
      startDate: input.startDate,
      endDate: input.endDate,
      notes: input.notes || null,
      status: "active",
    }, tx);

    const createdCount = await createSeriesAppointments(
      series.id,
      input,
      validation.validDates,
      user.id,
      tx,
    );

    return { series, createdCount };
  });

  let _budgetWarning: string | undefined;
  try {
    await budgetLedgerStorage.syncBudgetAllocations(input.customerId);
    const budgetSummary = await budgetLedgerStorage.getBudgetSummary(input.customerId);
    if (budgetSummary.availableAfterPlannedCents < 0) {
      _budgetWarning = "Achtung: Das Budget dieses Kunden reicht möglicherweise nicht für alle geplanten Termine.";
    }
  } catch {}

  res.status(201).json({
    series: result.series,
    createdAppointments: result.createdCount,
    skippedDates: validation.dates.filter(d => d.skipped),
    conflicts: validation.conflicts,
    _budgetWarning,
  });
}));

router.get("/:id", asyncHandler("Serie konnte nicht geladen werden", async (req, res) => {
  const user = req.user!;
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const series = await seriesStorage.getSeriesWithCustomer(id);
  if (!series) return sendNotFound(res, "Serie nicht gefunden.");

  if (!(await checkSeriesAccess(user, series))) {
    return sendForbidden(res, "ACCESS_DENIED", "Kein Zugriff auf diese Serie.");
  }

  const appointments = await seriesStorage.getSeriesAppointments(id);
  const counts = await seriesStorage.countSeriesAppointments(id);

  res.json({ series, appointments, counts });
}));

router.get("/", asyncHandler("Serien konnten nicht geladen werden", async (req, res) => {
  const user = req.user!;
  const customerId = req.query.customerId ? parseInt(req.query.customerId as string) : undefined;

  if (customerId) {
    if (!user.isAdmin) {
      const assignedIds = await storage.getCurrentlyAssignedCustomerIds(user.id);
      if (!assignedIds.includes(customerId)) {
        return sendForbidden(res, "NOT_ASSIGNED", "Sie sind diesem Kunden nicht zugeordnet.");
      }
    }
    const series = await seriesStorage.getActiveSeriesForCustomer(customerId);
    return res.json(series);
  }

  if (!user.isAdmin) {
    return sendForbidden(res, "ACCESS_DENIED", "Nur Admins können alle Serien einsehen.");
  }

  const series = await seriesStorage.getAllActiveSeries();
  res.json(series);
}));

router.patch("/:id", asyncHandler("Serie konnte nicht aktualisiert werden", async (req, res) => {
  const user = req.user!;
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const series = await seriesStorage.getSeries(id);
  if (!series) return sendNotFound(res, "Serie nicht gefunden.");

  if (!(await checkSeriesAccess(user, series))) {
    return sendForbidden(res, "ACCESS_DENIED", "Kein Zugriff auf diese Serie.");
  }

  const parsed = updateSeriesSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendBadRequest(res, "Validierungsfehler");
  }

  const updated = await seriesStorage.updateSeries(id, parsed.data);
  res.json(updated);
}));

router.delete("/:id", asyncHandler("Serie konnte nicht beendet werden", async (req, res) => {
  const user = req.user!;
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const series = await seriesStorage.getSeries(id);
  if (!series) return sendNotFound(res, "Serie nicht gefunden.");

  if (!(await checkSeriesAccess(user, series))) {
    return sendForbidden(res, "ACCESS_DENIED", "Kein Zugriff auf diese Serie.");
  }

  if (series.status === "ended") {
    return sendBadRequest(res, "Diese Serie ist bereits beendet.");
  }

  const today = todayISO();
  const eligibleIds = await collectEligibleFutureIds(id, today, { includeExceptions: true });

  await db.transaction(async (tx) => {
    await seriesStorage.bulkCancelSeriesAppointments(eligibleIds, tx);
    await seriesStorage.updateSeries(id, { status: "ended" });
  });

  res.json({ cancelled: eligibleIds.length, status: "ended" });
}));

const seriesAppointmentActionSchema = z.object({
  mode: z.enum(["single", "this_and_future", "all_future"]),
});

const seriesAppointmentUpdateSchema = seriesAppointmentActionSchema.extend({
  scheduledStart: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional(),
  assignedEmployeeId: z.number().optional(),
  notes: z.string().max(255).optional().nullable(),
});

router.post("/:seriesId/appointments/:appointmentId/update", asyncHandler("Serientermin konnte nicht geändert werden", async (req, res) => {
  const user = req.user!;
  const seriesId = requireIntParam(req.params.seriesId, res);
  if (seriesId === null) return;
  const appointmentId = requireIntParam(req.params.appointmentId, res);
  if (appointmentId === null) return;

  const series = await seriesStorage.getSeries(seriesId);
  if (!series) return sendNotFound(res, "Serie nicht gefunden.");

  if (!(await checkSeriesAccess(user, series))) {
    return sendForbidden(res, "ACCESS_DENIED", "Kein Zugriff.");
  }

  const parsed = seriesAppointmentUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendBadRequest(res, "Validierungsfehler");
  }

  const { mode, ...updateFields } = parsed.data;
  const appointment = await storage.getAppointment(appointmentId);
  if (!appointment || appointment.seriesId !== seriesId) {
    return sendNotFound(res, "Termin nicht in dieser Serie gefunden.");
  }

  if (appointment.status === "completed") {
    return sendBadRequest(res, "Abgeschlossene Termine können nicht geändert werden.");
  }

  const updateData: Record<string, unknown> = {};
  if (updateFields.scheduledStart !== undefined) {
    updateData.scheduledStart = updateFields.scheduledStart;
    updateData.scheduledEnd = addMinutesToTimeHHMMSS(updateFields.scheduledStart, series.durationMinutes);
  }
  if (updateFields.assignedEmployeeId !== undefined) updateData.assignedEmployeeId = updateFields.assignedEmployeeId;
  if (updateFields.notes !== undefined) updateData.notes = updateFields.notes;

  if (Object.keys(updateData).length === 0) {
    return sendBadRequest(res, "Keine Änderungen angegeben.");
  }

  if (mode === "single") {
    updateData.isSeriesException = true;
    await storage.updateAppointment(appointmentId, updateData);
    return res.json({ updated: 1 });
  }

  const today = todayISO();
  const fromDate = mode === "all_future" ? today : appointment.date;
  const eligibleIds = await collectEligibleFutureIds(seriesId, fromDate);

  const count = await seriesStorage.bulkUpdateSeriesAppointments(eligibleIds, updateData);

  const seriesRuleUpdate: Record<string, unknown> = {};
  if (updateFields.scheduledStart !== undefined) seriesRuleUpdate.scheduledStart = updateFields.scheduledStart;
  if (updateFields.assignedEmployeeId !== undefined) seriesRuleUpdate.assignedEmployeeId = updateFields.assignedEmployeeId;
  if (Object.keys(seriesRuleUpdate).length > 0) {
    await seriesStorage.updateSeries(seriesId, seriesRuleUpdate);
  }

  res.json({ updated: count });
}));

router.post("/:seriesId/appointments/:appointmentId/cancel", asyncHandler("Serientermin konnte nicht abgesagt werden", async (req, res) => {
  const user = req.user!;
  const seriesId = requireIntParam(req.params.seriesId, res);
  if (seriesId === null) return;
  const appointmentId = requireIntParam(req.params.appointmentId, res);
  if (appointmentId === null) return;

  const series = await seriesStorage.getSeries(seriesId);
  if (!series) return sendNotFound(res, "Serie nicht gefunden.");

  if (!(await checkSeriesAccess(user, series))) {
    return sendForbidden(res, "ACCESS_DENIED", "Kein Zugriff.");
  }

  const parsed = seriesAppointmentActionSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendBadRequest(res, "Validierungsfehler");
  }

  const { mode } = parsed.data;
  const appointment = await storage.getAppointment(appointmentId);
  if (!appointment || appointment.seriesId !== seriesId) {
    return sendNotFound(res, "Termin nicht in dieser Serie gefunden.");
  }

  if (mode === "single") {
    if (appointment.status === "completed") {
      return sendBadRequest(res, "Abgeschlossene Termine können nicht abgesagt werden.");
    }
    await storage.updateAppointment(appointmentId, { status: "cancelled" });
    return res.json({ cancelled: 1 });
  }

  const today = todayISO();
  const fromDate = mode === "all_future" ? today : appointment.date;
  const eligibleIds = await collectEligibleFutureIds(seriesId, fromDate, { includeExceptions: true });

  const count = await seriesStorage.bulkCancelSeriesAppointments(eligibleIds);

  if (mode === "all_future") {
    await seriesStorage.updateSeries(seriesId, { status: "ended" });
  }

  res.json({ cancelled: count });
}));

router.post("/:id/extend", asyncHandler("Serie konnte nicht verlängert werden", async (req, res) => {
  const user = req.user!;
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const series = await seriesStorage.getSeries(id);
  if (!series) return sendNotFound(res, "Serie nicht gefunden.");

  if (!(await checkSeriesAccess(user, series))) {
    return sendForbidden(res, "ACCESS_DENIED", "Kein Zugriff.");
  }

  if (series.status !== "active") {
    return sendBadRequest(res, "Nur aktive Serien können verlängert werden.");
  }

  const schema = z.object({
    newEndDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return sendBadRequest(res, "Ungültiges Enddatum.");

  const { newEndDate } = parsed.data;
  if (newEndDate <= series.endDate) {
    return sendBadRequest(res, "Das neue Enddatum muss nach dem aktuellen Enddatum liegen.");
  }

  const services = series.serviceIds.map((serviceId, i) => ({
    serviceId,
    durationMinutes: series.serviceDurations[i],
  }));

  const dayAfterCurrentEnd = new Date(series.endDate);
  dayAfterCurrentEnd.setDate(dayAfterCurrentEnd.getDate() + 1);
  const startDate = formatDateFromObj(dayAfterCurrentEnd);

  const input: z.infer<typeof createSeriesSchema> = {
    customerId: series.customerId,
    assignedEmployeeId: series.assignedEmployeeId,
    frequency: series.frequency as "weekly" | "biweekly",
    weekdays: series.weekdays as Weekday[],
    scheduledStart: series.scheduledStart,
    durationMinutes: series.durationMinutes,
    services,
    startDate,
    endDate: newEndDate,
    notes: series.notes || undefined,
  };

  const validation = await validateSeriesDates(input);
  if (!validation.valid) {
    return res.status(409).json({
      error: "SERIES_VALIDATION",
      message: validation.error || "Keine gültigen Termine im Verlängerungszeitraum.",
      conflicts: validation.conflicts,
    });
  }

  let createdCount: number;
  let _budgetWarning: string | undefined;

  await db.transaction(async (tx) => {
    createdCount = await createSeriesAppointments(
      series.id,
      input,
      validation.validDates,
      user.id,
      tx,
    );
    await seriesStorage.updateSeries(id, { endDate: newEndDate });
  });

  try {
    await budgetLedgerStorage.syncBudgetAllocations(series.customerId);
    const budgetSummary = await budgetLedgerStorage.getBudgetSummary(series.customerId);
    if (budgetSummary.availableAfterPlannedCents < 0) {
      _budgetWarning = "Achtung: Das Budget dieses Kunden reicht möglicherweise nicht für alle geplanten Termine.";
    }
  } catch {}

  res.json({
    createdAppointments: createdCount!,
    newEndDate,
    skippedDates: validation.dates.filter(d => d.skipped),
    conflicts: validation.conflicts,
    _budgetWarning,
  });
}));

router.post("/:id/shorten", asyncHandler("Serie konnte nicht verkürzt werden", async (req, res) => {
  const user = req.user!;
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const series = await seriesStorage.getSeries(id);
  if (!series) return sendNotFound(res, "Serie nicht gefunden.");

  if (!(await checkSeriesAccess(user, series))) {
    return sendForbidden(res, "ACCESS_DENIED", "Kein Zugriff.");
  }

  const schema = z.object({
    newEndDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return sendBadRequest(res, "Ungültiges Enddatum.");

  const { newEndDate } = parsed.data;
  if (newEndDate >= series.endDate) {
    return sendBadRequest(res, "Das neue Enddatum muss vor dem aktuellen Enddatum liegen.");
  }

  const dayAfterNewEnd = new Date(newEndDate);
  dayAfterNewEnd.setDate(dayAfterNewEnd.getDate() + 1);
  const cutoffDate = formatDateFromObj(dayAfterNewEnd);

  const futureAppointments = await seriesStorage.getFutureSeriesAppointments(
    id,
    cutoffDate,
    { includeExceptions: true },
  );

  const deletableIds: number[] = [];
  const skippedCount = { locked: 0, monthClosed: 0, completed: 0 };

  for (const apt of futureAppointments) {
    if (apt.status === "completed") {
      skippedCount.completed++;
      continue;
    }

    const employeeId = apt.assignedEmployeeId || apt.performedByEmployeeId;
    if (employeeId) {
      const monthClosed = await timeTrackingStorage.isMonthClosed(employeeId, apt.date);
      if (monthClosed) {
        skippedCount.monthClosed++;
        continue;
      }
    }

    const isLocked = await storage.isAppointmentLocked(apt.id);
    if (isLocked) {
      skippedCount.locked++;
      continue;
    }

    deletableIds.push(apt.id);
  }

  await db.transaction(async (tx) => {
    await seriesStorage.bulkDeleteSeriesAppointments(deletableIds, tx);
    await seriesStorage.updateSeries(id, { endDate: newEndDate });
  });

  res.json({
    deleted: deletableIds.length,
    newEndDate,
    skipped: skippedCount,
  });
}));

export default router;
