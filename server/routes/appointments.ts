import { Router } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { 
  updateAppointmentSchema, 
  insertKundenterminSchema,
  insertProspectErstberatungSchema,
  appointments,
  prospects,
} from "@shared/schema";
import { prospectStorage } from "../storage/prospects";
import { appointmentService } from "../services/appointments";
import { authService } from "../services/auth";
import { auditService } from "../services/audit";
import { serviceCatalogStorage } from "../storage/service-catalog";
import { getCachedCompanySettings } from "../services/cache";
import { suggestTravelOrigin } from "@shared/domain/appointments";
import { calculateRoute } from "../services/routing";
import { geocodeCustomer } from "../services/geocoding";
import { isWeekend, currentTimeHHMMSS, todayISO, parseLocalDate, timeToMinutes } from "@shared/utils/datetime";
import { timeRangesOverlap } from "@shared/domain/time-entries";
import { 
  ErrorMessages, 
  asyncHandler,
  sendBadRequest, 
  sendConflict, 
  sendForbidden, 
  sendNotFound,
  sendServerError
} from "../lib/errors";
import { requireAuth } from "../middleware/auth";
import { requireIntParam } from "../lib/params";
import { notificationService } from "../services/notification-service";
import { timeTrackingStorage } from "../storage/time-tracking";
import { budgetLedgerStorage } from "../storage/budget-ledger";
import type { Response } from "express";
import appointmentDocumentationRouter from "./appointment-documentation";
import { db } from "../lib/db";
import { customerManagementStorage } from "../storage/customer-management";
import { checkAndRecalcDailyAutoBreak } from "../services/auto-breaks";
import { addMinutesToTimeHHMMSS } from "@shared/utils/datetime";
import { serviceRecordAppointments, monthlyServiceRecords } from "@shared/schema";
import { eq } from "drizzle-orm";

const router = Router();

async function checkEmployeeBlocker(
  employeeId: number,
  date: string,
  startTime: string,
  endTime: string
): Promise<string | null> {
  const blockerEntries = await timeTrackingStorage.getTimeEntriesForDate(employeeId, date);
  const blockers = blockerEntries.filter(e => e.entryType === "blocker" && !e.deletedAt);

  for (const blocker of blockers) {
    if (blocker.isFullDay) {
      return "Der Mitarbeiter hat an diesem Tag einen Blocker eingetragen und steht nicht zur Verfügung.";
    }
    if (blocker.startTime && blocker.endTime) {
      const blockerStart = timeToMinutes(blocker.startTime);
      const blockerEnd = timeToMinutes(blocker.endTime);
      const apptStart = timeToMinutes(startTime);
      const apptEnd = timeToMinutes(endTime);
      if (timeRangesOverlap(apptStart, apptEnd, blockerStart, blockerEnd)) {
        return `Der Mitarbeiter hat einen Blocker von ${blocker.startTime.slice(0, 5)} bis ${blocker.endTime.slice(0, 5)} Uhr eingetragen.`;
      }
    }
  }
  return null;
}

function isDateMoreThan3MonthsInPast(dateStr: string): boolean {
  const date = parseLocalDate(dateStr);
  const threeMonthsAgo = new Date();
  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
  threeMonthsAgo.setHours(0, 0, 0, 0);
  return date < threeMonthsAgo;
}

export async function checkCustomerAccess(user: { id: number; isAdmin: boolean }, customerId: number | null, res: Response): Promise<boolean> {
  if (user.isAdmin) return true;
  if (customerId === null) {
    sendForbidden(res, "ACCESS_DENIED", "Sie haben keinen Zugriff auf diesen Termin.");
    return false;
  }
  const assignedCustomerIds = await storage.getAssignedCustomerIds(user.id);
  if (!assignedCustomerIds.includes(customerId)) {
    sendForbidden(res, "ACCESS_DENIED", "Sie haben keinen Zugriff auf diesen Termin.");
    return false;
  }
  return true;
}

router.use(requireAuth);

router.get("/active-employees", asyncHandler("Mitarbeiter konnten nicht geladen werden", async (_req, res) => {
  const employees = await authService.getActiveEmployees();
  const safeEmployees = employees.map((e) => ({
    id: e.id,
    displayName: e.displayName,
  }));
  res.json(safeEmployees);
}));

router.get("/", asyncHandler(ErrorMessages.fetchAppointmentsFailed, async (req, res) => {
  const date = req.query.date as string | undefined;
  const customerId = req.query.customerId ? parseInt(req.query.customerId as string) : undefined;
  const viewAsEmployeeId = req.query.viewAsEmployeeId ? parseInt(req.query.viewAsEmployeeId as string) : undefined;
  const user = req.user!;
  
  let customerIds: number[] | undefined;
  let employeeId: number | undefined;
  
  if (user.isAdmin && viewAsEmployeeId) {
    customerIds = await storage.getAssignedCustomerIds(viewAsEmployeeId);
    if (customerIds.length === 0) {
      return res.json([]);
    }
    employeeId = viewAsEmployeeId;
  } else if (!user.isAdmin) {
    customerIds = await storage.getAssignedCustomerIds(user.id);
    if (customerIds.length === 0) {
      return res.json([]);
    }
    employeeId = user.id;
  }
  
  if (customerId) {
    if (customerIds) {
      if (!customerIds.includes(customerId)) {
        return res.json([]);
      }
      customerIds = [customerId];
    } else {
      customerIds = [customerId];
    }
  }
  
  const appointments = await storage.getAppointmentsWithCustomers(date, customerIds, employeeId);
  
  res.json(appointments);
}));

router.get("/counts", asyncHandler("Fehler beim Laden der Terminzähler", async (req, res) => {
  const user = req.user!;
  const datesParam = req.query.dates as string | undefined;
  const viewAsEmployeeId = req.query.viewAsEmployeeId ? parseInt(req.query.viewAsEmployeeId as string) : undefined;
  if (!datesParam) {
    return sendBadRequest(res, "Datumsangaben fehlen");
  }
  const dates = datesParam.split(",").filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
  if (dates.length === 0 || dates.length > 14) {
    return sendBadRequest(res, "Ungültige Datumsangaben (max. 14 Tage)");
  }

  let customerIds: number[] | undefined;
  let employeeId: number | undefined;

  if (user.isAdmin && viewAsEmployeeId) {
    customerIds = await storage.getAssignedCustomerIds(viewAsEmployeeId);
    if (customerIds.length === 0) {
      return res.json({});
    }
    employeeId = viewAsEmployeeId;
  } else if (!user.isAdmin) {
    customerIds = await storage.getAssignedCustomerIds(user.id);
    if (customerIds.length === 0) {
      return res.json({});
    }
    employeeId = user.id;
  }

  const counts = await storage.getAppointmentCountsByDates(dates, customerIds, employeeId);
  res.json(counts);
}));

router.get("/undocumented", asyncHandler("Fehler beim Laden der offenen Dokumentationen", async (req, res) => {
  const user = req.user!;
  const today = todayISO();
  const viewAsEmployeeId = req.query.viewAsEmployeeId ? parseInt(req.query.viewAsEmployeeId as string) : undefined;
  
  let customerIds: number[] | undefined;
  let employeeId: number | undefined;

  if (user.isAdmin && viewAsEmployeeId) {
    customerIds = await storage.getAssignedCustomerIds(viewAsEmployeeId);
    if (customerIds.length === 0) {
      return res.json([]);
    }
    employeeId = viewAsEmployeeId;
  } else if (!user.isAdmin) {
    customerIds = await storage.getAssignedCustomerIds(user.id);
    if (customerIds.length === 0) {
      return res.json([]);
    }
    employeeId = user.id;
  }

  const appointments = await storage.getUndocumentedAppointments(today, customerIds, employeeId);
  
  res.json(appointments);
}));

router.get("/batch-services", asyncHandler("Fehler beim Laden der Batch-Services", async (req, res) => {
  const user = req.user!;
  const idsParam = req.query.ids as string | undefined;
  if (!idsParam) return sendBadRequest(res, "Termin-IDs fehlen");

  const ids = idsParam.split(",").map(Number).filter(n => !isNaN(n) && n > 0);
  if (ids.length === 0 || ids.length > 100) {
    return sendBadRequest(res, "Ungültige Termin-IDs (max. 100)");
  }

  const grouped = await storage.getBatchAppointmentServices(ids);

  res.json(grouped);
}));

router.get("/:id/services", asyncHandler("Fehler beim Laden der Termin-Services", async (req, res) => {
  const user = req.user!;
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;
  
  const appointment = await storage.getAppointment(id);
  if (!appointment) return sendNotFound(res, "Termin nicht gefunden");
  if (!(await checkCustomerAccess(user, appointment.customerId, res))) return;
  
  const result = await storage.getAppointmentServices(id);
  
  res.json(result);
}));

router.get("/:id", asyncHandler(ErrorMessages.fetchAppointmentFailed, async (req, res) => {
  const user = req.user!;
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;
  
  const appointment = await storage.getAppointmentWithCustomer(id);
  
  if (!appointment) {
    return sendNotFound(res, ErrorMessages.appointmentNotFound);
  }
  
  if (!user.isAdmin) {
    const assignedCustomerIds = await storage.getAssignedCustomerIds(user.id);
    if (!assignedCustomerIds.includes(appointment.customerId!)) {
      return sendForbidden(res, "Zugriff verweigert", "Sie haben keinen Zugriff auf diesen Termin.");
    }
  }

  const isLocked = await storage.isAppointmentLocked(id);

  let isMonthClosed = false;
  if (appointment.status === "completed" && appointment.date) {
    const employeeId = appointment.assignedEmployeeId || appointment.performedByEmployeeId;
    if (employeeId) {
      isMonthClosed = await timeTrackingStorage.isMonthClosed(employeeId, appointment.date);
    }
  }

  let lockedReason: string | undefined;
  if (isLocked) {
    lockedReason = "Verknüpft mit einem unterschriebenen Leistungsnachweis";
  } else if (isMonthClosed) {
    lockedReason = "Der Monat ist bereits abgeschlossen";
  }

  res.json({ ...appointment, isLocked, isMonthClosed, lockedReason });
}));

router.post("/kundentermin", asyncHandler(ErrorMessages.createAppointmentFailed, async (req, res) => {
  const validatedData = insertKundenterminSchema.parse(req.body);
  const user = req.user!;
  
  if (isWeekend(validatedData.date)) {
    return sendBadRequest(res, "Termine können nicht an Samstagen oder Sonntagen erstellt werden.");
  }

  const farPastDate = isDateMoreThan3MonthsInPast(validatedData.date);
  let _warning: string | undefined;
  if (farPastDate) {
    if (!user.isAdmin) {
      return sendBadRequest(res, "Termine können nicht mehr als 3 Monate in der Vergangenheit erstellt werden.");
    }
    _warning = "Achtung: Dieser Termin liegt mehr als 3 Monate in der Vergangenheit.";
  }
  
  const customer = await storage.getCustomer(validatedData.customerId);
  if (!customer) {
    return sendNotFound(res, "Kunde nicht gefunden.");
  }

  const currentContract = await customerManagementStorage.getCustomerCurrentContract(validatedData.customerId);
  if (currentContract?.contractEnd && validatedData.date > currentContract.contractEnd) {
    const endFormatted = currentContract.contractEnd.split("-").reverse().join(".");
    return sendBadRequest(res, `Der Vertrag endet am ${endFormatted}. Neue Termine können nicht nach dem Vertragsende erstellt werden.`);
  }

  let assignedEmployeeId: number;
  if (user.isAdmin) {
    if (!validatedData.assignedEmployeeId) {
      return sendBadRequest(res, "Bitte wählen Sie einen Mitarbeiter für diesen Termin aus.");
    }
    assignedEmployeeId = validatedData.assignedEmployeeId;
    
    const isAssignedEmployee = 
      customer.primaryEmployeeId === assignedEmployeeId || 
      customer.backupEmployeeId === assignedEmployeeId ||
      customer.backupEmployeeId2 === assignedEmployeeId;
    
    if (!isAssignedEmployee) {
      return sendBadRequest(
        res, 
        "Der ausgewählte Mitarbeiter ist diesem Kunden nicht zugeordnet. Bitte weisen Sie den Mitarbeiter zuerst dem Kunden zu."
      );
    }
  } else {
    assignedEmployeeId = user.id;
    
    const currentCustomerIds = await storage.getCurrentlyAssignedCustomerIds(user.id);
    if (!currentCustomerIds.includes(validatedData.customerId)) {
      return sendForbidden(res, "NOT_ASSIGNED", "Sie sind diesem Kunden nicht mehr zugeordnet und können keine neuen Termine erstellen.");
    }
  }
  
  const serviceIds = validatedData.services.map(s => s.serviceId);
  const serviceRecords = await storage.getServicesByIds(serviceIds);
  const serviceCodeMap = Object.fromEntries(serviceRecords.map(s => [s.id, s.code]));

  const servicesWithCodes = validatedData.services.map(s => ({
    serviceId: s.serviceId,
    durationMinutes: s.durationMinutes,
    serviceCode: serviceCodeMap[s.serviceId] || null,
  }));

  const { appointmentData, scheduledEnd, serviceEntries } = appointmentService.prepareKundenterminData({
    ...validatedData,
    services: servicesWithCodes,
    assignedEmployeeId,
  });
  
  const overlapResult = await appointmentService.checkOverlap(
    validatedData.date, 
    validatedData.scheduledStart, 
    scheduledEnd,
    assignedEmployeeId
  );
  
  if (overlapResult.hasUnreliableData) {
    return sendConflict(
      res, 
      "Datenprüfung erforderlich",
      ErrorMessages.unreliableData(overlapResult.unreliableAppointmentId!)
    );
  }
  
  if (overlapResult.hasOverlap) {
    return sendConflict(res, "Terminüberschneidung", ErrorMessages.timeOverlap);
  }

  const blockerConflict = await checkEmployeeBlocker(
    assignedEmployeeId, validatedData.date, validatedData.scheduledStart, scheduledEnd
  );
  if (blockerConflict) {
    return sendConflict(res, "Mitarbeiter blockiert", blockerConflict);
  }

  const customerOverlap = await appointmentService.checkCustomerOverlap(
    validatedData.date, validatedData.scheduledStart, scheduledEnd, validatedData.customerId
  );
  if (customerOverlap) {
    return sendConflict(res, "Kundenüberschneidung", "Dieser Kunde hat bereits einen Termin in diesem Zeitraum.");
  }
  
  const appointment = await storage.createAppointment(appointmentData);

  if (serviceEntries.length > 0) {
    await storage.createAppointmentServices(appointment.id, serviceEntries);
  }

  if (assignedEmployeeId !== user.id) {
    const customerName = `${customer.vorname} ${customer.nachname}`;
    notificationService.notifyAppointmentCreated(appointment.id, customerName, validatedData.date, assignedEmployeeId, user.id);
  }

  try {
    await budgetLedgerStorage.syncBudgetAllocations(validatedData.customerId);
    const budgetSummary = await budgetLedgerStorage.getBudgetSummary(validatedData.customerId);
    if (budgetSummary.availableAfterPlannedCents < 0) {
      _warning = "Achtung: Das Budget dieses Kunden reicht möglicherweise nicht für alle geplanten Termine.";
    }
  } catch {
  }

  res.status(201).json(_warning ? { ...appointment, _warning } : appointment);
}));

router.post("/prospect-erstberatung", asyncHandler("Erstberatung konnte nicht erstellt werden", async (req, res) => {
  const validatedData = insertProspectErstberatungSchema.parse(req.body);
  const user = req.user!;

  if (isWeekend(validatedData.date)) {
    return sendBadRequest(res, "Termine können nicht an Samstagen oder Sonntagen erstellt werden.");
  }

  const farPastDate = isDateMoreThan3MonthsInPast(validatedData.date);
  let _warning: string | undefined;
  if (farPastDate) {
    if (!user.isAdmin) {
      return sendBadRequest(res, "Termine können nicht mehr als 3 Monate in der Vergangenheit erstellt werden.");
    }
    _warning = "Achtung: Dieser Termin liegt mehr als 3 Monate in der Vergangenheit.";
  }

  const prospect = await prospectStorage.getById(validatedData.prospectId);
  if (!prospect) {
    return sendNotFound(res, "Interessent nicht gefunden");
  }

  let assignedEmployeeId: number;
  if (user.isAdmin) {
    if (!validatedData.assignedEmployeeId) {
      return sendBadRequest(res, "Bitte wählen Sie einen Mitarbeiter für diese Erstberatung aus.");
    }
    assignedEmployeeId = validatedData.assignedEmployeeId;
  } else {
    assignedEmployeeId = user.id;
  }

  const scheduledEnd = addMinutesToTimeHHMMSS(validatedData.scheduledStart, validatedData.erstberatungDauer);

  const overlapResult = await appointmentService.checkOverlap(
    validatedData.date,
    validatedData.scheduledStart,
    scheduledEnd,
    assignedEmployeeId
  );

  if (overlapResult.hasUnreliableData) {
    return sendConflict(
      res,
      "Datenprüfung erforderlich",
      ErrorMessages.unreliableData(overlapResult.unreliableAppointmentId!)
    );
  }

  if (overlapResult.hasOverlap) {
    return sendConflict(res, "Terminüberschneidung", ErrorMessages.timeOverlap);
  }

  const erstberatungBlockerConflict = await checkEmployeeBlocker(
    assignedEmployeeId, validatedData.date, validatedData.scheduledStart, scheduledEnd
  );
  if (erstberatungBlockerConflict) {
    return sendConflict(res, "Mitarbeiter blockiert", erstberatungBlockerConflict);
  }

  const result = await db.transaction(async (tx) => {
    const [appointment] = await tx.insert(appointments).values({
      prospectId: validatedData.prospectId,
      appointmentType: "Erstberatung",
      date: validatedData.date,
      scheduledStart: validatedData.scheduledStart,
      scheduledEnd,
      durationPromised: validatedData.erstberatungDauer,
      notes: validatedData.notes || null,
      status: "scheduled",
      createdByUserId: user.id,
      assignedEmployeeId,
    }).returning();

    await tx.update(prospects)
      .set({ status: "erstberatung_vereinbart", updatedAt: new Date() })
      .where(eq(prospects.id, validatedData.prospectId));

    return appointment;
  });

  const erstberatungService = await serviceCatalogStorage.getServiceByCode("erstberatung");
  if (erstberatungService) {
    await storage.createAppointmentServices(result.id, [{
      serviceId: erstberatungService.id,
      plannedDurationMinutes: validatedData.erstberatungDauer,
    }]);
  }

  await prospectStorage.addNote({
    prospectId: validatedData.prospectId,
    userId: user.id,
    noteText: `Erstberatung am ${validatedData.date} um ${validatedData.scheduledStart} vereinbart`,
    noteType: "statuswechsel",
  });

  if (assignedEmployeeId !== user.id) {
    const customerName = `${prospect.vorname} ${prospect.nachname}`;
    notificationService.notifyAppointmentCreated(result.id, customerName, validatedData.date, assignedEmployeeId, user.id);
  }

  res.status(201).json(_warning ? { appointment: result, _warning } : { appointment: result });
}));

router.patch("/:id", asyncHandler(ErrorMessages.updateAppointmentFailed, async (req, res) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;
  
  const existingAppointment = await storage.getAppointment(id);
  if (!existingAppointment) {
    return sendNotFound(res, ErrorMessages.appointmentNotFound);
  }
  
  if (!await checkCustomerAccess(req.user!, existingAppointment.customerId, res)) return;
  
  const isLocked = await storage.isAppointmentLocked(id);
  if (isLocked) {
    return sendForbidden(res, "APPOINTMENT_LOCKED", "Dieser Termin ist Teil eines unterschriebenen Leistungsnachweises und kann nicht mehr bearbeitet werden.");
  }

  if (!req.user!.isAdmin && existingAppointment.date) {
    const employeeId = existingAppointment.assignedEmployeeId || existingAppointment.performedByEmployeeId;
    if (employeeId && await timeTrackingStorage.isMonthClosed(employeeId, existingAppointment.date)) {
      return sendForbidden(res, "MONTH_CLOSED", "Der Monat ist bereits abgeschlossen. Termin-Änderungen sind nur noch durch einen Admin möglich.");
    }
  }
  
  if (existingAppointment.signatureData) {
    const protectedFields = ['signatureData', 'signatureHash', 'signedAt', 'signedByUserId'];
    const bodyKeys = Object.keys(req.body);
    const touchesSignature = protectedFields.some(f => bodyKeys.includes(f));
    if (touchesSignature) {
      return sendForbidden(res, "SIGNATURE_LOCKED", "Die Unterschrift dieses Termins ist gesperrt. Bitte nutzen Sie die Stornierungsfunktion im Admin-Bereich.");
    }
  }

  const validatedData = updateAppointmentSchema.parse(req.body);
  
  if (validatedData.date && isWeekend(validatedData.date)) {
    return sendBadRequest(res, "Termine können nicht auf Samstage oder Sonntage verschoben werden.");
  }
  
  const validation = appointmentService.validateAllUpdateRules(existingAppointment, validatedData);
  if (!validation.valid) {
    return sendForbidden(res, validation.error!, validation.message!);
  }

  if (validatedData.date || validatedData.scheduledStart || validatedData.scheduledEnd || validatedData.durationPromised || validatedData.assignedEmployeeId) {
    const checkDate = validatedData.date || existingAppointment.date;
    const checkStart = validatedData.scheduledStart || existingAppointment.scheduledStart;
    const duration = validatedData.durationPromised ?? existingAppointment.durationPromised;
    const checkEnd = validatedData.scheduledEnd
      || (duration ? addMinutesToTimeHHMMSS(checkStart, duration) : null)
      || existingAppointment.scheduledEnd;
    const assignedEmpId = validatedData.assignedEmployeeId || existingAppointment.assignedEmployeeId;

    if (checkDate && checkStart && checkEnd) {
      if (assignedEmpId) {
        const empOverlap = await appointmentService.checkOverlap(checkDate, checkStart, checkEnd, assignedEmpId, id);
        if (empOverlap.hasOverlap) {
          return sendConflict(res, "Terminüberschneidung", ErrorMessages.timeOverlap);
        }

        const updateBlockerConflict = await checkEmployeeBlocker(assignedEmpId, checkDate, checkStart, checkEnd);
        if (updateBlockerConflict) {
          return sendConflict(res, "Mitarbeiter blockiert", updateBlockerConflict);
        }
      }

      const customerOverlap = await appointmentService.checkCustomerOverlap(
        checkDate, checkStart, checkEnd, existingAppointment.customerId!, id
      );
      if (customerOverlap) {
        return sendConflict(res, "Kundenüberschneidung", "Dieser Kunde hat bereits einen Termin in diesem Zeitraum.");
      }
    }
  }
  
  const updated = await storage.updateAppointment(id, validatedData);
  if (!updated) {
    return sendNotFound(res, ErrorMessages.appointmentNotFound);
  }
  
  if (req.body.services && Array.isArray(req.body.services)) {
    const serviceSchema = z.array(z.object({
      serviceId: z.number().int().positive(),
      plannedDurationMinutes: z.number().int().positive(),
    }));
    const services = serviceSchema.safeParse(req.body.services);
    if (services.success) {
      await storage.replaceAppointmentServices(id, services.data);
    }
  }

  const changedFields = Object.keys(validatedData).filter(k => (validatedData as Record<string, unknown>)[k] !== undefined);
  if (changedFields.length > 0) {
    const ip = req.ip || req.socket.remoteAddress;
    await auditService.appointmentUpdated(
      req.user!.id,
      id,
      { customerId: existingAppointment.customerId!, changedFields },
      ip
    );
  }

  if (updated) {
    const newEmployeeId = updated.assignedEmployeeId || updated.performedByEmployeeId;
    if (newEmployeeId && updated.customerId) {
      const customer = await storage.getCustomer(updated.customerId);
      const customerName = customer ? `${customer.vorname} ${customer.nachname}` : "Unbekannt";
      notificationService.notifyAppointmentUpdated(id, customerName, updated.date || "", newEmployeeId, req.user!.id);
    }
  }

  if (updated && updated.date) {
    const newEmployeeId = updated.assignedEmployeeId || updated.performedByEmployeeId;
    const oldEmployeeId = existingAppointment.assignedEmployeeId || existingAppointment.performedByEmployeeId;
    const employeesToRecalc = new Map<number, Set<string>>();

    const addRecalc = (empId: number, date: string) => {
      if (!employeesToRecalc.has(empId)) employeesToRecalc.set(empId, new Set());
      employeesToRecalc.get(empId)!.add(date);
    };

    if (newEmployeeId) addRecalc(newEmployeeId, updated.date);
    if (oldEmployeeId && existingAppointment.date) {
      addRecalc(oldEmployeeId, existingAppointment.date);
    }

    for (const [empId, dates] of employeesToRecalc) {
      for (const d of dates) {
        checkAndRecalcDailyAutoBreak(empId, d);
      }
    }
  }

  res.json(updated);
}));

router.post("/:id/start", asyncHandler("Fehler beim Starten des Besuchs", async (req, res) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;
  
  const appointment = await storage.getAppointment(id);
  if (!appointment) {
    return sendNotFound(res, ErrorMessages.appointmentNotFound);
  }
  
  if (!await checkCustomerAccess(req.user!, appointment.customerId, res)) return;
  
  const isLocked = await storage.isAppointmentLocked(id);
  if (isLocked) {
    return sendForbidden(res, "APPOINTMENT_LOCKED", "Dieser Termin ist Teil eines unterschriebenen Leistungsnachweises und kann nicht mehr bearbeitet werden.");
  }

  if (!req.user!.isAdmin && appointment.date) {
    const employeeId = appointment.assignedEmployeeId || appointment.performedByEmployeeId;
    if (employeeId && await timeTrackingStorage.isMonthClosed(employeeId, appointment.date)) {
      return sendForbidden(res, "MONTH_CLOSED", "Der Monat ist bereits abgeschlossen. Termin-Änderungen sind nur noch durch einen Admin möglich.");
    }
  }
  
  if (appointment.status !== "scheduled") {
    return sendForbidden(res, "INVALID_STATUS", "Nur geplante Termine können gestartet werden");
  }
  
  const updatedAppointment = await storage.updateAppointment(id, {
    status: "in-progress",
    actualStart: currentTimeHHMMSS(),
  });
  
  res.json(updatedAppointment);
}));

router.post("/:id/end", asyncHandler("Fehler beim Beenden des Besuchs", async (req, res) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;
  
  const appointment = await storage.getAppointment(id);
  if (!appointment) {
    return sendNotFound(res, ErrorMessages.appointmentNotFound);
  }
  
  if (!await checkCustomerAccess(req.user!, appointment.customerId, res)) return;
  
  const isLocked = await storage.isAppointmentLocked(id);
  if (isLocked) {
    return sendForbidden(res, "APPOINTMENT_LOCKED", "Dieser Termin ist Teil eines unterschriebenen Leistungsnachweises und kann nicht mehr bearbeitet werden.");
  }

  if (!req.user!.isAdmin && appointment.date) {
    const employeeId = appointment.assignedEmployeeId || appointment.performedByEmployeeId;
    if (employeeId && await timeTrackingStorage.isMonthClosed(employeeId, appointment.date)) {
      return sendForbidden(res, "MONTH_CLOSED", "Der Monat ist bereits abgeschlossen. Termin-Änderungen sind nur noch durch einen Admin möglich.");
    }
  }
  
  if (appointment.status !== "in-progress") {
    return sendForbidden(res, "INVALID_STATUS", "Nur laufende Termine können beendet werden");
  }
  
  const updatedAppointment = await storage.updateAppointment(id, {
    status: "documenting",
    actualEnd: currentTimeHHMMSS(),
  });

  if (appointment.date) {
    const employeeId = appointment.assignedEmployeeId || appointment.performedByEmployeeId;
    if (employeeId) {
      checkAndRecalcDailyAutoBreak(employeeId, appointment.date);
    }
  }
  
  res.json(updatedAppointment);
}));

router.get("/:id/travel-suggestion", asyncHandler("Fehler beim Laden der Fahrvorschläge", async (req, res) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;
  
  const appointment = await storage.getAppointmentWithCustomer(id);
  if (!appointment) {
    return sendNotFound(res, ErrorMessages.appointmentNotFound);
  }
  
  const user = req.user!;
  const employeeId = user.isAdmin ? undefined : user.id;
  const sameDayAppointments = await storage.getAppointmentsWithCustomers(appointment.date, undefined, employeeId);
  
  const appointmentsWithNames = sameDayAppointments.map(apt => ({
    ...apt,
    customerName: apt.customer?.name
  }));
  
  const suggestion = suggestTravelOrigin(appointment, appointmentsWithNames);

  let suggestedKilometers: number | null = null;
  let suggestedMinutes: number | null = null;

  const destCustomer = appointment.customer;
  if (destCustomer?.latitude && destCustomer?.longitude) {
    if (suggestion.suggestedOrigin === "home") {
      const company = await getCachedCompanySettings();
      if (company?.latitude && company?.longitude) {
        const route = await calculateRoute(company.latitude, company.longitude, destCustomer.latitude, destCustomer.longitude);
        if (route) {
          suggestedKilometers = route.distanceKm;
          suggestedMinutes = route.durationMinutes;
        }
      }
    } else if (suggestion.previousAppointment) {
      const prevAppointment = await storage.getAppointmentWithCustomer(suggestion.previousAppointment.id);
      const prevCustomer = prevAppointment?.customer;
      if (prevCustomer?.latitude && prevCustomer?.longitude) {
        const route = await calculateRoute(prevCustomer.latitude, prevCustomer.longitude, destCustomer.latitude, destCustomer.longitude);
        if (route) {
          suggestedKilometers = route.distanceKm;
          suggestedMinutes = route.durationMinutes;
        }
      }
    }
  }
  
  res.json({
    suggestedOrigin: suggestion.suggestedOrigin,
    previousAppointmentId: suggestion.previousAppointment?.id ?? null,
    previousCustomerName: suggestion.previousCustomerName ?? null,
    suggestedKilometers,
    suggestedMinutes,
  });
}));

router.get("/:id/route-calculation", asyncHandler("Fehler bei der Routenberechnung", async (req, res) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const originType = req.query.originType as string;
  const fromAppointmentId = req.query.fromAppointmentId ? parseInt(req.query.fromAppointmentId as string) : null;

  if (!originType || !["home", "appointment"].includes(originType)) {
    return sendBadRequest(res, "Ungültiger Origin-Typ");
  }

  const appointment = await storage.getAppointmentWithCustomer(id);
  if (!appointment) {
    return sendNotFound(res, ErrorMessages.appointmentNotFound);
  }

  const destCustomer = appointment.customer;
  if (!destCustomer?.latitude || !destCustomer?.longitude) {
    return res.json({ suggestedKilometers: null, suggestedMinutes: null });
  }

  let suggestedKilometers: number | null = null;
  let suggestedMinutes: number | null = null;

  if (originType === "home") {
    const company = await getCachedCompanySettings();
    if (company?.latitude && company?.longitude) {
      const route = await calculateRoute(company.latitude, company.longitude, destCustomer.latitude, destCustomer.longitude);
      if (route) {
        suggestedKilometers = route.distanceKm;
        suggestedMinutes = route.durationMinutes;
      }
    }
  } else if (originType === "appointment" && fromAppointmentId) {
    const prevAppointment = await storage.getAppointmentWithCustomer(fromAppointmentId);
    const prevCustomer = prevAppointment?.customer;
    if (prevCustomer?.latitude && prevCustomer?.longitude) {
      const route = await calculateRoute(prevCustomer.latitude, prevCustomer.longitude, destCustomer.latitude, destCustomer.longitude);
      if (route) {
        suggestedKilometers = route.distanceKm;
        suggestedMinutes = route.durationMinutes;
      }
    }
  }

  res.json({ suggestedKilometers, suggestedMinutes });
}));

router.post("/:id/reopen", asyncHandler("Fehler beim Wiedereröffnen des Termins", async (req, res) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const appointment = await storage.getAppointment(id);
  if (!appointment) {
    return sendNotFound(res, ErrorMessages.appointmentNotFound);
  }

  if (!await checkCustomerAccess(req.user!, appointment.customerId, res)) return;

  if (appointment.status !== "completed") {
    return sendForbidden(res, "INVALID_STATUS", "Nur abgeschlossene Termine können zur Korrektur geöffnet werden.");
  }

  const isLocked = await storage.isAppointmentLocked(id);
  if (isLocked) {
    return sendForbidden(res, "APPOINTMENT_LOCKED", "Dieser Termin ist Teil eines unterschriebenen Leistungsnachweises und kann nicht mehr bearbeitet werden.");
  }

  if (!req.user!.isAdmin && appointment.date) {
    const employeeId = appointment.assignedEmployeeId || appointment.performedByEmployeeId;
    if (employeeId && await timeTrackingStorage.isMonthClosed(employeeId, appointment.date)) {
      return sendForbidden(res, "MONTH_CLOSED", "Der Monat ist bereits abgeschlossen. Änderungen sind nur noch durch einen Admin möglich.");
    }
  }

  const transactions = await budgetLedgerStorage.getTransactionsByAppointmentId(id);

  const updatedAppointment = await db.transaction(async (txClient) => {
    for (const tx of transactions) {
      await budgetLedgerStorage.reverseBudgetTransaction(tx.id, req.user!.id, txClient);
    }

    const result = await storage.updateAppointment(id, {
      status: "documenting",
      signatureData: null,
      signatureHash: null,
      signedAt: null,
      signedByUserId: null,
    }, txClient);

    if (!result) {
      throw new Error("Termin konnte nicht zurückgesetzt werden");
    }

    return result;
  });

  const ip = req.ip || req.socket.remoteAddress;
  await auditService.log(
    req.user!.id,
    "appointment_reopened",
    "appointment",
    id,
    {
      customerId: appointment.customerId,
      reversedTransactions: transactions.length,
      hadSignature: !!appointment.signatureData,
    },
    ip
  );

  if (appointment.date) {
    const employeeId = appointment.assignedEmployeeId || appointment.performedByEmployeeId;
    if (employeeId) {
      checkAndRecalcDailyAutoBreak(employeeId, appointment.date);
    }
  }

  res.json(updatedAppointment);
}));

router.use(appointmentDocumentationRouter);

router.delete("/:id", asyncHandler(ErrorMessages.deleteAppointmentFailed, async (req, res) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;
  
  const appointment = await storage.getAppointment(id);
  if (!appointment) {
    return sendNotFound(res, ErrorMessages.appointmentNotFound);
  }
  
  if (!await checkCustomerAccess(req.user!, appointment.customerId, res)) return;

  const isAdmin = req.user!.isAdmin;
  const isCompleted = appointment.status === "completed";
  
  const isLocked = await storage.isAppointmentLocked(id);
  if (isLocked && !isAdmin) {
    return sendForbidden(res, "APPOINTMENT_LOCKED", "Dieser Termin ist Teil eines unterschriebenen Leistungsnachweises und kann nicht gelöscht werden.");
  }
  
  if (!isAdmin) {
    const canDelete = appointmentService.canDeleteAppointment(appointment);
    if (!canDelete.valid) {
      return sendForbidden(res, canDelete.error!, canDelete.message!);
    }
  }
  
  const ip = req.ip || req.socket.remoteAddress;

  let reversedTransactions = 0;
  if (isAdmin && isCompleted) {
    const transactions = await budgetLedgerStorage.getTransactionsByAppointmentId(id);
    await db.transaction(async (txClient) => {
      for (const tx of transactions) {
        await budgetLedgerStorage.reverseBudgetTransaction(tx.id, req.user!.id, txClient);
      }
      const deleted = await storage.deleteAppointment(id, txClient);
      if (!deleted) {
        throw new Error("Termin konnte nicht gelöscht werden");
      }
    });
    reversedTransactions = transactions.length;
  } else {
    const deleted = await storage.deleteAppointment(id);
    if (!deleted) {
      return sendServerError(res, ErrorMessages.deleteAppointmentFailed);
    }
  }

  await auditService.log(
    req.user!.id,
    "appointment_deleted",
    "appointment",
    id,
    {
      customerId: appointment.customerId,
      date: appointment.date,
      status: appointment.status,
      adminForceDelete: isAdmin && isCompleted,
      reversedTransactions,
      wasLocked: isLocked,
    },
    ip
  );

  if (appointment.appointmentType === "Erstberatung" && appointment.prospectId) {
    const prospectData = await prospectStorage.getAppointmentData(appointment.prospectId);
    if (prospectData && prospectData.prospect.status === "erstberatung_vereinbart") {
      const hasOtherActiveAppointments = prospectData.appointments.length > 0;
      if (!hasOtherActiveAppointments) {
        await db.update(prospects)
          .set({ status: "qualifiziert", updatedAt: new Date() })
          .where(eq(prospects.id, appointment.prospectId));
      }
    }
  }

  if (appointment.date) {
    const employeeId = appointment.assignedEmployeeId || appointment.performedByEmployeeId;
    if (employeeId) {
      checkAndRecalcDailyAutoBreak(employeeId, appointment.date);
    }
  }
  
  res.json({ success: true, message: "Termin erfolgreich gelöscht" });
}));

export default router;
