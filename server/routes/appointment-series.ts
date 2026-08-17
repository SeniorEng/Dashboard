import { Router, Request, Response } from "express";
import { cancelAppointments, CancelDiscardsDocumentationError } from "../services/appointment-cancellation";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { asyncHandler, sendBadRequest, sendNotFound, sendForbidden } from "../lib/errors";
import { requireIntParam } from "../lib/params";
import { createSeriesSchema, updateSeriesSchema, type Weekday } from "@shared/schema";
import * as seriesStorage from "../storage/appointment-series-storage";
import { validateSeriesDates, createSeriesAppointments } from "../services/appointment-series";
import { storage } from "../storage";
import { timeTrackingStorage } from "../storage/time-tracking";
import { budgetStorage } from "../storage/budget-storage";
import { buildBudgetWarning } from "../lib/budget-warning";
import { notificationService } from "../services/notification-service";
import { todayISO, addMinutesToTimeHHMMSS, isWeekend, parseLocalDate } from "@shared/utils/datetime";
import { appointmentService } from "../services/appointments";
import { db } from "../lib/db";
import { rebookAppointmentConsumption, type RebookKmResult } from "../storage/budget/km-rebook";
import { auditService } from "../services/audit";
import {
  canCreateAppointment as policyCanCreateAppointment,
  canEditAppointment as policyCanEditAppointment,
  canDeleteAppointment as policyCanDeleteAppointment,
  canOverrideClosedMonth as policyCanOverrideClosedMonth,
  type PolicyAppointment,
  type PolicyUser,
} from "@shared/policies/appointments";
import { seriesBulkFloorDate } from "@shared/domain/appointments";
import { isTeamLead } from "../lib/team-lead";
import { isHoliday } from "@shared/utils/holidays";

const router = Router();
router.use(requireAuth);

function toSeriesPolicyUser(user: {
  id: number;
  isAdmin: boolean;
  isSuperAdmin?: boolean | null;
  isActive?: boolean | null;
  isTeamLead?: boolean | null;
  isAnonymized?: boolean | null;
  roles?: readonly string[];
}): PolicyUser {
  const adminLike = !!user.isAdmin || !!user.isSuperAdmin;
  return {
    id: user.id,
    isAdmin: !!user.isAdmin,
    isSuperAdmin: !!user.isSuperAdmin,
    isTeamLead: !adminLike && isTeamLead(user as Parameters<typeof isTeamLead>[0]),
    isActive: user.isActive !== false,
    roles: user.roles ?? [],
  };
}

/**
 * Snapshot eines hypothetischen Serien-Termins (offen, kein Lock, kein
 * Monatsabschluss) — wird an action-spezifische Policies übergeben.
 * Echte Lock/Monatsabschluss-Flags werden pro tatsächlichem Termin in
 * `collectEligibleFutureIds`/Schleifen geprüft.
 */
function seriesSnapshot(series: { assignedEmployeeId: number; customerId: number }): PolicyAppointment {
  return {
    assignedEmployeeId: series.assignedEmployeeId,
    performedByEmployeeId: series.assignedEmployeeId,
    customerId: series.customerId,
    status: "scheduled",
    date: "2099-01-01",
    appointmentType: "Kundentermin",
    isStarted: false,
    isLocked: false,
    isMonthClosed: false,
    hasSignature: false,
  };
}

function canEditSeries(user: PolicyUser, series: { assignedEmployeeId: number; customerId: number }): boolean {
  return policyCanEditAppointment(user, seriesSnapshot(series)).allowed;
}

function canDeleteSeries(user: PolicyUser, series: { assignedEmployeeId: number; customerId: number }): boolean {
  return policyCanDeleteAppointment(user, seriesSnapshot(series)).allowed;
}

function canBypassMonthClose(user: PolicyUser): boolean {
  return policyCanOverrideClosedMonth(user).allowed;
}

/**
 * Reiner SELEKTOR: WELCHE Termine der Serie sind ab `fromDate` gemeint?
 *
 * Die Frage „darf der weg?" beantwortet ausschliesslich `cancelAppointments`
 * (`server/services/appointment-cancellation.ts`). Vorher stand sie hier ein
 * zweites Mal — mit anderem Ergebnis als im `single`-Zweig, und ohne Schutz fuer
 * `documenting`. Genau aus dieser Doppelung entstand der Defekt.
 */
async function collectSeriesAppointmentIds(
  seriesId: number,
  fromDate: string,
  options?: { includeExceptions?: boolean },
): Promise<number[]> {
  const futureAppointments = await seriesStorage.getFutureSeriesAppointments(seriesId, fromDate, options);
  return futureAppointments.map(a => a.id);
}

/**
 * Muster Task #1883: den Bestaetigungs-Bedarf als 409 MIT Ausweis der
 * betroffenen Termine ausliefern, statt ihn zu einem nackten 500/400 zu
 * verschlucken. Die Nutzlast liegt unter `details`, weil der Client-Parser
 * (`client/src/lib/api/client.ts#parseErrorResponse`) genau von dort in
 * `ApiError.details` uebernimmt — ein Top-Level-Feld kaeme nicht an.
 */
function sendCancelConfirmationRequired(res: Response, err: CancelDiscardsDocumentationError): void {
  res.status(409).json({
    code: err.code,
    message: err.message,
    details: { appointments: err.betroffene },
  });
}

function formatDateFromObj(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function parseAndValidateSeriesInput(req: Request, res: Response) {
  const user = req.user!;
  const parsed = createSeriesSchema.safeParse(req.body);
  if (!parsed.success) {
    sendBadRequest(res, "Validierungsfehler: " + parsed.error.issues.map(i => i.message).join(", "));
    return null;
  }
  const input = parsed.data;

  const customer = await storage.getCustomer(input.customerId);
  if (!customer) { sendNotFound(res, "Kunde nicht gefunden."); return null; }

  const policyUser = toSeriesPolicyUser(user);
  let isAssignedToCustomer = false;
  if (!policyUser.isAdmin && !policyUser.isSuperAdmin && !policyUser.isTeamLead) {
    input.assignedEmployeeId = user.id;
    const assignedIds = await storage.getCurrentlyAssignedCustomerIds(user.id);
    isAssignedToCustomer = assignedIds.includes(input.customerId);
  }

  // Wer-Frage über zentrale Create-Policy. Datums-/Monatsabschluss-Checks pro
  // tatsächlichem Termin in `validateSeriesDates`/`createSeriesAppointments`.
  const createDecision = policyCanCreateAppointment(policyUser, {
    date: input.startDate,
    isWeekend: false,
    isHoliday: false,
    isFarPast: false,
    isMonthClosed: false,
    appointmentType: "Kundentermin",
    isAssignedToCustomer,
    forOtherEmployee: input.assignedEmployeeId !== user.id,
  });
  if (!createDecision.allowed) {
    sendForbidden(res, "ACCESS_DENIED", createDecision.reason);
    return null;
  }

  return { input, customer };
}

router.post("/preview", asyncHandler("Vorschau konnte nicht erstellt werden", async (req, res) => {
  const result = await parseAndValidateSeriesInput(req, res);
  if (!result) return;
  const { input } = result;

  if (input.startDate >= input.endDate) {
    return sendBadRequest(res, "Das Enddatum muss nach dem Startdatum liegen.");
  }

  const validation = await validateSeriesDates(input);

  res.json({
    valid: validation.valid,
    totalDates: validation.dates.length,
    validDates: validation.validDates.length,
    skippedDates: validation.dates.filter(d => d.skipped),
    conflicts: validation.conflicts,
    error: validation.error || null,
  });
}));

router.post("/", asyncHandler("Serie konnte nicht erstellt werden", async (req, res) => {
  const validated = await parseAndValidateSeriesInput(req, res);
  if (!validated) return;
  const { input, customer } = validated;
  const user = req.user!;

  if (user.isAdmin) {
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

  const startD = parseLocalDate(input.startDate);
  const maxEndD = new Date(startD);
  maxEndD.setMonth(maxEndD.getMonth() + 12);
  const maxEndStr = formatDateFromObj(maxEndD);
  if (input.endDate > maxEndStr) {
    return sendBadRequest(res, "Der Zeitraum darf maximal 12 Monate betragen.");
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

    const createResult = await createSeriesAppointments(
      series.id,
      input,
      validation.validDates,
      user.id,
      tx,
    );

    return { series, createResult };
  });

  if (
    result.createResult.count > 0
    && result.createResult.firstAppointmentId !== null
    && result.createResult.firstDate !== null
  ) {
    const customerName = `${customer.vorname} ${customer.nachname}`;
    notificationService.notifySeriesAppointmentsCreated(
      input.assignedEmployeeId,
      customerName,
      result.createResult.count,
      result.createResult.firstDate,
      result.createResult.firstAppointmentId,
      user.id,
    );
  }

  let _budgetWarning: string | undefined;
  try {
    await budgetStorage.syncCarryoverAndExpiry(input.customerId);
    // Task #874 — Serving-Pfad: Budget-Warnung nutzt unified Verfügbarkeit.
    const budgetSummary = await budgetStorage.getBudgetSummaryServed(input.customerId);
    _budgetWarning = buildBudgetWarning(budgetSummary, {
      appointmentDates: validation.validDates,
    }) ?? undefined;
  } catch (err) {
    console.warn("[appointment-series] Budget-Warnung fehlgeschlagen:", err);
  }

  res.status(201).json({
    series: result.series,
    createdAppointments: result.createResult.count,
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

  if (!canEditSeries(toSeriesPolicyUser(user), series)) {
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

  if (!canEditSeries(toSeriesPolicyUser(user), series)) {
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

  if (!canDeleteSeries(toSeriesPolicyUser(user), series)) {
    return sendForbidden(res, "ACCESS_DENIED", "Kein Zugriff auf diese Serie.");
  }

  if (series.status === "ended") {
    return sendBadRequest(res, "Diese Serie ist bereits beendet.");
  }

  // Task-Grenze (Gate-2-Funde B1/B2): „Serie beenden" bekommt den
  // Bestaetigungs-Gate NICHT, solange sein Client (`useEndSeries`) keine
  // 409→Dialog→Flag-Kette hat. Ein Gate ohne UI machte den Vorgang
  // unausfuehrbar, sobald irgendein Termin ab heute `documenting` ist — also im
  // Normalfall. Das ist schlechter als der Zustand vorher. Die Uebernahme
  // kommt als eigener PR MIT UI.
  //
  // `confirmDiscardDocumentation: true` heisst hier deshalb: Verhalten wie
  // bisher, kein neuer 409. Die Rueckabwicklung und das Audit der SSoT-Routine
  // greifen trotzdem — das ist die Verbesserung, die ohne UI-Aenderung sicher
  // ist.
  const confirmDiscardDocumentation = true;

  const today = todayISO();
  const kandidaten = await collectSeriesAppointmentIds(id, today, { includeExceptions: true });

  // Absage-SSoT statt nacktem Status-Update: Policy, Lock-Re-Check,
  // Budget-Rueckabwicklung und Audit kommen von dort.
  let ergebnis: Awaited<ReturnType<typeof cancelAppointments>>;
  try {
    await db.transaction(async (tx) => {
      ergebnis = await cancelAppointments(
        kandidaten,
        toSeriesPolicyUser(user),
        { userId: user.id, confirmDiscardDocumentation, ipAddress: req.ip || req.socket.remoteAddress },
        tx,
      );
      await seriesStorage.updateSeries(id, { status: "ended" }, tx);
    });
  } catch (err) {
    if (err instanceof CancelDiscardsDocumentationError) return sendCancelConfirmationRequired(res, err);
    throw err;
  }

  res.json({ cancelled: ergebnis!.cancelled.length, uebersprungen: ergebnis!.uebersprungen, status: "ended" });
}));

const seriesAppointmentActionSchema = z.object({
  mode: z.enum(["single", "this_and_future", "all_future"]),
});

const seriesAppointmentUpdateSchema = seriesAppointmentActionSchema.extend({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  scheduledStart: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional(),
  assignedEmployeeId: z.number().optional(),
  notes: z.string().max(255).optional().nullable(),
  includeExceptions: z.boolean().optional().default(false),
});

router.post("/:seriesId/appointments/:appointmentId/update", asyncHandler("Serientermin konnte nicht geändert werden", async (req, res) => {
  const user = req.user!;
  const seriesId = requireIntParam(req.params.seriesId, res);
  if (seriesId === null) return;
  const appointmentId = requireIntParam(req.params.appointmentId, res);
  if (appointmentId === null) return;

  const series = await seriesStorage.getSeries(seriesId);
  if (!series) return sendNotFound(res, "Serie nicht gefunden.");

  if (!canEditSeries(toSeriesPolicyUser(user), series)) {
    return sendForbidden(res, "ACCESS_DENIED", "Kein Zugriff.");
  }

  const parsed = seriesAppointmentUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendBadRequest(res, "Validierungsfehler");
  }

  const { mode, includeExceptions, ...updateFields } = parsed.data;
  const appointment = await storage.getAppointment(appointmentId);
  if (!appointment || appointment.seriesId !== seriesId) {
    return sendNotFound(res, "Termin nicht in dieser Serie gefunden.");
  }

  if (appointment.status === "completed" && mode === "single") {
    return sendBadRequest(res, "Abgeschlossene Termine können nicht einzeln geändert werden.");
  }

  if (updateFields.date) {
    if (isWeekend(updateFields.date)) {
      return sendBadRequest(res, "Termine können nicht auf Samstage oder Sonntage verschoben werden.");
    }
    const { isHoliday } = await import("@shared/utils/holidays");
    const holidayName = isHoliday(updateFields.date);
    if (holidayName) {
      return sendBadRequest(res, `Termine können nicht auf Feiertage verschoben werden (${holidayName}).`);
    }
  }

  const updateData: Record<string, unknown> = {};
  if (updateFields.scheduledStart !== undefined) {
    updateData.scheduledStart = updateFields.scheduledStart;
    updateData.scheduledEnd = addMinutesToTimeHHMMSS(updateFields.scheduledStart, series.durationMinutes);
  }
  if (updateFields.date !== undefined) updateData.date = updateFields.date;
  if (updateFields.assignedEmployeeId !== undefined) {
    const customer = await storage.getCustomer(series.customerId);
    if (customer) {
      const isAssigned =
        customer.primaryEmployeeId === updateFields.assignedEmployeeId ||
        customer.backupEmployeeId === updateFields.assignedEmployeeId ||
        customer.backupEmployeeId2 === updateFields.assignedEmployeeId;
      if (!isAssigned) {
        return sendBadRequest(res, "Der Mitarbeiter ist diesem Kunden nicht zugeordnet.");
      }
    }
    updateData.assignedEmployeeId = updateFields.assignedEmployeeId;
  }
  if (updateFields.notes !== undefined) updateData.notes = updateFields.notes;

  if (Object.keys(updateData).length === 0) {
    return sendBadRequest(res, "Keine Änderungen angegeben.");
  }

  const hasSchedulingChange = updateFields.scheduledStart !== undefined
    || updateFields.date !== undefined
    || updateFields.assignedEmployeeId !== undefined;

  if (mode === "single") {
    if (hasSchedulingChange) {
      const checkDate = updateFields.date || appointment.date;
      const checkStart = updateFields.scheduledStart || appointment.scheduledStart;
      const checkEnd = (updateData.scheduledEnd as string | undefined) || appointment.scheduledEnd || addMinutesToTimeHHMMSS(checkStart, series.durationMinutes);
      const checkEmployee = updateFields.assignedEmployeeId || appointment.assignedEmployeeId;

      if (checkEmployee) {
        const empOverlap = await appointmentService.checkOverlap(checkDate, checkStart, checkEnd, checkEmployee, appointmentId);
        if (empOverlap.hasOverlap) {
          return sendBadRequest(res, "Terminüberschneidung: Der Mitarbeiter hat bereits einen Termin zu dieser Zeit.");
        }
      }

      if (appointment.customerId) {
        const customerOverlap = await appointmentService.checkCustomerOverlap(
          checkDate, checkStart, checkEnd, appointment.customerId, appointmentId,
        );
        if (customerOverlap) {
          return sendBadRequest(res, "Terminüberschneidung: Der Kunde hat bereits einen Termin zu dieser Zeit.");
        }
      }

      updateData.isSeriesException = true;
    }

    // Task #630: budget-relevante Felder lösen Auto-Rebook + Audit aus,
    // analog Haupt-PATCH-Route (siehe server/routes/appointments.ts).
    const dateChanged = updateFields.date !== undefined && updateFields.date !== appointment.date;
    const shouldRebook = dateChanged;
    const rebookTrigger = dateChanged ? "date_change" : "unknown";

    const rebookHolder: { value: RebookKmResult | null } = { value: null };
    const updatedAppt = await db.transaction(async (tx) => {
      const result = await storage.updateAppointment(appointmentId, updateData, tx);
      if (shouldRebook && result && result.customerId) {
        rebookHolder.value = await rebookAppointmentConsumption({
          appointmentId,
          userId: user.id,
        }, tx);
      }
      return result;
    });

    const rebookInfo = rebookHolder.value;
    if (rebookInfo && rebookInfo.rebooked && updatedAppt && updatedAppt.customerId != null) {
      const ip = req.ip || req.socket.remoteAddress;
      await auditService.log(
        user.id,
        "appointment_km_rebooked",
        "appointment",
        appointmentId,
        {
          customerId: updatedAppt.customerId,
          trigger: rebookTrigger,
          previousTransactionDate: rebookInfo.previousTransactionDate,
          transactionDate: rebookInfo.transactionDate,
          previousTravelKm: rebookInfo.previousTravelKm,
          newTravelKm: updatedAppt.travelKilometers ?? 0,
          previousCustomerKm: rebookInfo.previousCustomerKm,
          newCustomerKm: updatedAppt.customerKilometers ?? 0,
          previousHauswirtschaftMinutes: rebookInfo.previousHauswirtschaftMinutes,
          previousAlltagsbegleitungMinutes: rebookInfo.previousAlltagsbegleitungMinutes,
          reversedTransactionIds: rebookInfo.reversedTransactionIds,
          hauswirtschaftMinutes: rebookInfo.hauswirtschaftMinutes,
          alltagsbegleitungMinutes: rebookInfo.alltagsbegleitungMinutes,
        },
        ip,
      );
    }

    return res.json({ updated: 1 });
  }

  if (updateFields.date !== undefined) {
    return sendBadRequest(res, "Datumsänderungen sind nur für einzelne Termine möglich (mode: single).");
  }

  const today = todayISO();
  // Datums-Boden (Replit-#1913): `appointment.date` kann in der Vergangenheit
  // liegen — dann zöge diese Massen-Änderung geleistete Termine mit.
  const fromDate = seriesBulkFloorDate(mode === "all_future" ? today : appointment.date, today);
  const futureAppointments = await seriesStorage.getFutureSeriesAppointments(
    seriesId, fromDate, { includeExceptions },
  );

  const eligibleIds: number[] = [];
  const conflicts: Array<{ appointmentId: number; date: string; reason: string }> = [];

  for (const apt of futureAppointments) {
    if (apt.status === "completed") continue;

    const employeeId = apt.assignedEmployeeId || apt.performedByEmployeeId;
    if (employeeId && !canBypassMonthClose(toSeriesPolicyUser(user))) {
      const monthClosed = await timeTrackingStorage.isMonthClosed(employeeId, apt.date);
      if (monthClosed) continue;
    }

    const isLocked = await storage.isAppointmentLocked(apt.id);
    if (isLocked) continue;

    if (hasSchedulingChange) {
      const checkStart = updateFields.scheduledStart || apt.scheduledStart;
      const checkEnd = (updateData.scheduledEnd as string | undefined) || apt.scheduledEnd || addMinutesToTimeHHMMSS(checkStart, series.durationMinutes);
      const checkEmployee = updateFields.assignedEmployeeId || apt.assignedEmployeeId;

      if (checkEmployee) {
        const empOverlap = await appointmentService.checkOverlap(apt.date, checkStart, checkEnd, checkEmployee, apt.id);
        if (empOverlap.hasOverlap) {
          conflicts.push({ appointmentId: apt.id, date: apt.date, reason: "Mitarbeiter-Terminüberschneidung" });
          continue;
        }
      }

      if (apt.customerId) {
        const customerOverlap = await appointmentService.checkCustomerOverlap(
          apt.date, checkStart, checkEnd, apt.customerId, apt.id,
        );
        if (customerOverlap) {
          conflicts.push({ appointmentId: apt.id, date: apt.date, reason: "Kunden-Terminüberschneidung" });
          continue;
        }
      }
    }

    eligibleIds.push(apt.id);
  }

  // Task #630: bulk-Edit muss denselben Auto-Rebook + Audit-Trail auslösen
  // wie die Haupt-PATCH-Route. Aktuell sind im Bulk-Pfad nur scheduledStart
  // und assignedEmployeeId änderbar (Datum ist oben blockiert); diese Felder
  // verändern das Budget nicht und der Rebook ist für sie ein No-Op. Wir
  // wiren den Pfad trotzdem in einer Transaktion, damit zukünftig erweiterte
  // Bulk-Felder (z.B. Datum) automatisch korrekt gebucht werden.
  const rebookResults = new Map<number, RebookKmResult>();
  let processedIds: number[] = eligibleIds;
  const updatedRows = await db.transaction(async (tx) => {
    // Task #1544 — Race-sichere Lock-Prüfung INNERHALB der Tx. Die
    // `eligibleIds` wurden außerhalb der Tx via `isAppointmentLocked` gefiltert
    // (check-then-write). Eine gleichzeitig committende Unterschrift könnte einen
    // dieser Termine zwischenzeitlich auf einem versiegelten Sammel-LN versiegeln.
    // Wir prüfen jeden Kandidaten mit FOR UPDATE erneut und lassen inzwischen
    // versiegelte Termine fallen — analog zur bestehenden „locked ⇒ skip"-Semantik
    // des Bulk-Pfads (kein Hard-Error für die restlichen Termine).
    const safeIds: number[] = [];
    for (const aptId of eligibleIds) {
      if (!(await storage.lockAndCheckAppointmentLocked(aptId, tx))) {
        safeIds.push(aptId);
      }
    }
    processedIds = safeIds;
    const _count = await seriesStorage.bulkUpdateSeriesAppointments(safeIds, updateData, tx);
    void _count;
    const rows = await Promise.all(
      safeIds.map(id => storage.getAppointment(id)),
    );
    for (const apt of rows) {
      if (!apt || apt.customerId == null) continue;
      const r = await rebookAppointmentConsumption({ appointmentId: apt.id, userId: user.id }, tx);
      if (r.rebooked) rebookResults.set(apt.id, r);
    }
    return rows;
  });

  const ip = req.ip || req.socket.remoteAddress;
  for (const apt of updatedRows) {
    if (!apt || apt.customerId == null) continue;
    const r = rebookResults.get(apt.id);
    if (!r || !r.rebooked) continue;
    const trigger = r.previousTransactionDate !== r.transactionDate ? "date_change" : "unknown";
    await auditService.log(
      user.id,
      "appointment_km_rebooked",
      "appointment",
      apt.id,
      {
        customerId: apt.customerId,
        trigger,
        previousTransactionDate: r.previousTransactionDate,
        transactionDate: r.transactionDate,
        previousTravelKm: r.previousTravelKm,
        newTravelKm: apt.travelKilometers ?? 0,
        previousCustomerKm: r.previousCustomerKm,
        newCustomerKm: apt.customerKilometers ?? 0,
        previousHauswirtschaftMinutes: r.previousHauswirtschaftMinutes,
        previousAlltagsbegleitungMinutes: r.previousAlltagsbegleitungMinutes,
        reversedTransactionIds: r.reversedTransactionIds,
        hauswirtschaftMinutes: r.hauswirtschaftMinutes,
        alltagsbegleitungMinutes: r.alltagsbegleitungMinutes,
      },
      ip,
    );
  }
  const count = processedIds.length;

  const seriesRuleUpdate: Record<string, unknown> = {};
  if (updateFields.scheduledStart !== undefined) seriesRuleUpdate.scheduledStart = updateFields.scheduledStart;
  if (updateFields.assignedEmployeeId !== undefined) seriesRuleUpdate.assignedEmployeeId = updateFields.assignedEmployeeId;
  if (Object.keys(seriesRuleUpdate).length > 0) {
    await seriesStorage.updateSeries(seriesId, seriesRuleUpdate);
  }

  res.json({ updated: count, conflicts });
}));

router.post("/:seriesId/appointments/:appointmentId/cancel", asyncHandler("Serientermin konnte nicht abgesagt werden", async (req, res) => {
  const user = req.user!;
  const seriesId = requireIntParam(req.params.seriesId, res);
  if (seriesId === null) return;
  const appointmentId = requireIntParam(req.params.appointmentId, res);
  if (appointmentId === null) return;

  const series = await seriesStorage.getSeries(seriesId);
  if (!series) return sendNotFound(res, "Serie nicht gefunden.");

  if (!canEditSeries(toSeriesPolicyUser(user), series)) {
    return sendForbidden(res, "ACCESS_DENIED", "Kein Zugriff.");
  }

  const cancelSchema = seriesAppointmentActionSchema.extend({
    includeExceptions: z.boolean().optional().default(false),
    // Muster #1883: ohne dieses Flag verweigert die Absage-SSoT mit 409, wenn
    // sie eine begonnene Dokumentation verwerfen wuerde.
    confirmDiscardDocumentation: z.boolean().optional().default(false),
  });
  const parsed = cancelSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendBadRequest(res, "Validierungsfehler");
  }

  const { mode, includeExceptions, confirmDiscardDocumentation } = parsed.data;
  const appointment = await storage.getAppointment(appointmentId);
  if (!appointment || appointment.seriesId !== seriesId) {
    return sendNotFound(res, "Termin nicht in dieser Serie gefunden.");
  }

  // EIN Weg fuer single und bulk — vorher hatte `single` ein eigenes,
  // schwaecheres Guard-Set (nur `completed`) und keinerlei Rueckabwicklung.
  //
  // Der Datums-Boden (Replit-#1913) gilt nur fuer die BULK-Zweige. `single`
  // bleibt ungefiltert: das ist eine bewusste Handlung an genau dem Termin, den
  // der Nutzer vor sich hat, kein Sog aus einer Serien-Entscheidung. Wer einen
  // vergangenen Einzeltermin absagt, meint ihn auch.
  const kandidaten = mode === "single"
    ? [appointmentId]
    : await collectSeriesAppointmentIds(
        seriesId,
        seriesBulkFloorDate(mode === "all_future" ? todayISO() : appointment.date, todayISO()),
        { includeExceptions },
      );

  let ergebnis: Awaited<ReturnType<typeof cancelAppointments>>;
  try {
    ergebnis = await cancelAppointments(
      kandidaten,
      toSeriesPolicyUser(user),
      { userId: user.id, confirmDiscardDocumentation, ipAddress: req.ip || req.socket.remoteAddress },
    );
  } catch (err) {
    if (err instanceof CancelDiscardsDocumentationError) return sendCancelConfirmationRequired(res, err);
    throw err;
  }

  // Vertrag bewahren: bei `single` geht es um GENAU EINEN Termin. Wird der
  // abgelehnt, ist das ein Fehler und kein Teilergebnis — sonst meldete die
  // Route 200 „Erfolg", waehrend nichts passiert ist. Genau die Klasse stiller
  // Meldung, die dieser PR beseitigt. Bulk behaelt die Uebersprungen-Liste,
  // dort ist Teilerfolg der Normalfall.
  if (mode === "single" && ergebnis.cancelled.length === 0) {
    const grund = ergebnis.uebersprungen[0]?.grund ?? "Termin konnte nicht abgesagt werden.";
    // Gate-2-Fund S3: Fuer „liegt auf einem unterschriebenen Leistungsnachweis"
    // ist der etablierte Vertrag im Repo 409 + APPOINTMENT_LOCKED
    // (appointments.ts:2266, :1327, appointment-documentation.ts:123). Clients
    // verzweigen auf diesen Code (`handleDelete`, `handleDecouple`); ein 400
    // INVALID_REQUEST haette den Fall unkenntlich gemacht.
    if (/Leistungsnachweis/.test(grund)) {
      return res.status(409).json({ code: "APPOINTMENT_LOCKED", message: grund });
    }
    return sendBadRequest(res, grund);
  }

  if (mode === "all_future") {
    await seriesStorage.updateSeries(seriesId, { status: "ended" });
  }

  res.json({ cancelled: ergebnis.cancelled.length, uebersprungen: ergebnis.uebersprungen });
}));

router.post("/:id/extend", asyncHandler("Serie konnte nicht verlängert werden", async (req, res) => {
  const user = req.user!;
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const series = await seriesStorage.getSeries(id);
  if (!series) return sendNotFound(res, "Serie nicht gefunden.");

  if (!canEditSeries(toSeriesPolicyUser(user), series)) {
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

  const extendMaxEnd = parseLocalDate(series.startDate);
  extendMaxEnd.setMonth(extendMaxEnd.getMonth() + 12);
  const extendMaxEndStr = formatDateFromObj(extendMaxEnd);
  if (newEndDate > extendMaxEndStr) {
    return sendBadRequest(res, "Die Gesamtdauer der Serie darf maximal 12 Monate betragen.");
  }

  const services = series.serviceIds.map((serviceId, i) => ({
    serviceId,
    durationMinutes: series.serviceDurations[i],
  }));

  const dayAfterCurrentEnd = parseLocalDate(series.endDate);
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

  let createResult: { count: number; firstAppointmentId: number | null; firstDate: string | null };
  let _budgetWarning: string | undefined;

  await db.transaction(async (tx) => {
    createResult = await createSeriesAppointments(
      series.id,
      input,
      validation.validDates,
      user.id,
      tx,
    );
    await seriesStorage.updateSeries(id, { endDate: newEndDate }, tx);
  });

  if (
    createResult!.count > 0
    && createResult!.firstAppointmentId !== null
    && createResult!.firstDate !== null
  ) {
    const customer = await storage.getCustomer(series.customerId);
    if (customer) {
      const customerName = `${customer.vorname} ${customer.nachname}`;
      notificationService.notifySeriesAppointmentsCreated(
        series.assignedEmployeeId,
        customerName,
        createResult!.count,
        createResult!.firstDate,
        createResult!.firstAppointmentId,
        user.id,
      );
    }
  }

  try {
    await budgetStorage.syncCarryoverAndExpiry(series.customerId);
    // Task #876 — Serving-Pfad nutzt die unified Verfügbarkeit (wie der
    // Create-Series-Pfad), damit die Budget-Warnung beim Verlängern dieselbe
    // Zahl zeigt wie Übersicht und Anlage.
    const budgetSummary = await budgetStorage.getBudgetSummaryServed(series.customerId);
    _budgetWarning = buildBudgetWarning(budgetSummary, {
      appointmentDates: validation.validDates,
    }) ?? undefined;
  } catch (err) {
    console.warn("[appointment-series] Budget-Warnung fehlgeschlagen:", err);
  }

  res.json({
    createdAppointments: createResult!.count,
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

  if (!canEditSeries(toSeriesPolicyUser(user), series)) {
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

  const dayAfterNewEnd = parseLocalDate(newEndDate);
  dayAfterNewEnd.setDate(dayAfterNewEnd.getDate() + 1);
  // Datums-Boden (Replit-#1913): `newEndDate` kommt vom Nutzer und darf in der
  // Vergangenheit liegen. Ohne Boden löscht das Verkürzen bereits geleistete
  // Termine — dieselbe Ursache wie bei Absage/Änderung, nur mit härterer Folge:
  // hier wird nicht abgesagt, sondern gelöscht.
  const cutoffDate = seriesBulkFloorDate(formatDateFromObj(dayAfterNewEnd), todayISO());

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
    if (employeeId && !canBypassMonthClose(toSeriesPolicyUser(user))) {
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

  let deletedCount = deletableIds.length;
  await db.transaction(async (tx) => {
    // Task #1544 — Race-sichere Lock-Prüfung INNERHALB der Tx. `deletableIds`
    // wurde außerhalb via `isAppointmentLocked` gefiltert (check-then-write). Die
    // junction `service_record_appointments` ist ON DELETE CASCADE; eine
    // gleichzeitig committende Unterschrift könnte einen dieser Termine
    // zwischenzeitlich auf einem versiegelten Sammel-LN versiegeln. Wir prüfen
    // jeden Kandidaten mit FOR UPDATE erneut und lassen inzwischen versiegelte
    // Termine fallen (analog „locked ⇒ skip"), damit der Cascade-Delete keinen
    // versiegelten Nachweis mutiert.
    const safeIds: number[] = [];
    for (const aptId of deletableIds) {
      if (await storage.lockAndCheckAppointmentLocked(aptId, tx)) {
        skippedCount.locked++;
      } else {
        safeIds.push(aptId);
      }
    }
    deletedCount = safeIds.length;
    await seriesStorage.bulkDeleteSeriesAppointments(safeIds, tx);
    await seriesStorage.updateSeries(id, { endDate: newEndDate }, tx);
  });

  res.json({
    deleted: deletedCount,
    newEndDate,
    skipped: skippedCount,
  });
}));

export default router;
