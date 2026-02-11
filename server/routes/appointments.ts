import { Router } from "express";
import { storage } from "../storage";
import { 
  updateAppointmentSchema, 
  insertKundenterminSchema,
  insertErstberatungSchema,
} from "@shared/schema";
import { appointmentService } from "../services/appointments";
import { authService } from "../services/auth";
import { suggestTravelOrigin } from "@shared/domain/appointments";
import { isWeekend, currentTimeHHMMSS, todayISO } from "@shared/utils/datetime";
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
import type { Response } from "express";
import appointmentDocumentationRouter from "./appointment-documentation";

const router = Router();

export async function checkCustomerAccess(user: { id: number; isAdmin: boolean }, customerId: number, res: Response): Promise<boolean> {
  if (user.isAdmin) return true;
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
  const safeEmployees = employees.map(({ passwordHash, ...employee }) => ({
    id: employee.id,
    displayName: employee.displayName,
  }));
  res.json(safeEmployees);
}));

router.get("/", asyncHandler(ErrorMessages.fetchAppointmentsFailed, async (req, res) => {
  const date = req.query.date as string | undefined;
  const customerId = req.query.customerId ? parseInt(req.query.customerId as string) : undefined;
  const user = req.user!;
  
  let customerIds: number[] | undefined;
  
  if (!user.isAdmin) {
    customerIds = await storage.getAssignedCustomerIds(user.id);
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
  
  const appointments = await storage.getAppointmentsWithCustomers(date, customerIds);
  
  res.json(appointments);
}));

router.get("/counts", asyncHandler("Fehler beim Laden der Terminzähler", async (req, res) => {
  const user = req.user!;
  const datesParam = req.query.dates as string | undefined;
  if (!datesParam) {
    return sendBadRequest(res, "Datumsangaben fehlen");
  }
  const dates = datesParam.split(",").filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
  if (dates.length === 0 || dates.length > 14) {
    return sendBadRequest(res, "Ungültige Datumsangaben (max. 14 Tage)");
  }

  const customerIds = user.isAdmin
    ? undefined
    : await storage.getAssignedCustomerIds(user.id);

  const counts = await storage.getAppointmentCountsByDates(dates, customerIds);
  res.json(counts);
}));

router.get("/undocumented", asyncHandler("Fehler beim Laden der offenen Dokumentationen", async (req, res) => {
  const user = req.user!;
  const today = todayISO();
  
  const customerIds = user.isAdmin 
    ? undefined 
    : await storage.getAssignedCustomerIds(user.id);
  
  const appointments = await storage.getUndocumentedAppointments(today, customerIds);
  
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
  const id = parseInt(req.params.id);
  if (isNaN(id)) return sendBadRequest(res, "Ungültige Termin-ID");
  
  const appointment = await storage.getAppointment(id);
  if (!appointment) return sendNotFound(res, "Termin nicht gefunden");
  if (!(await checkCustomerAccess(user, appointment.customerId, res))) return;
  
  const result = await storage.getAppointmentServices(id);
  
  res.json(result);
}));

router.get("/:id", asyncHandler(ErrorMessages.fetchAppointmentFailed, async (req, res) => {
  const user = req.user!;
  const id = parseInt(req.params.id);
  if (isNaN(id)) {
    return sendBadRequest(res, ErrorMessages.invalidAppointmentId);
  }
  
  const appointment = await storage.getAppointmentWithCustomer(id);
  
  if (!appointment) {
    return sendNotFound(res, ErrorMessages.appointmentNotFound);
  }
  
  if (!user.isAdmin) {
    const assignedCustomerIds = await storage.getAssignedCustomerIds(user.id);
    if (!assignedCustomerIds.includes(appointment.customerId)) {
      return sendForbidden(res, "Zugriff verweigert", "Access denied");
    }
  }
  
  res.json(appointment);
}));

router.post("/kundentermin", asyncHandler(ErrorMessages.createAppointmentFailed, async (req, res) => {
  const validatedData = insertKundenterminSchema.parse(req.body);
  const user = req.user!;
  
  if (isWeekend(validatedData.date)) {
    return sendBadRequest(res, "Termine können nicht an Samstagen oder Sonntagen erstellt werden.");
  }
  
  let assignedEmployeeId: number;
  if (user.isAdmin) {
    if (!validatedData.assignedEmployeeId) {
      return sendBadRequest(res, "Bitte wählen Sie einen Mitarbeiter für diesen Termin aus.");
    }
    assignedEmployeeId = validatedData.assignedEmployeeId;
    
    const customer = await storage.getCustomer(validatedData.customerId);
    if (!customer) {
      return sendNotFound(res, "Kunde nicht gefunden.");
    }
    
    const isAssignedEmployee = 
      customer.primaryEmployeeId === assignedEmployeeId || 
      customer.backupEmployeeId === assignedEmployeeId;
    
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
    scheduledEnd
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
  
  const appointment = await storage.createAppointment(appointmentData);

  if (serviceEntries.length > 0) {
    await storage.createAppointmentServices(appointment.id, serviceEntries);
  }

  res.status(201).json(appointment);
}));

router.post("/erstberatung", asyncHandler(ErrorMessages.createErstberatungFailed, async (req, res) => {
  const validatedData = insertErstberatungSchema.parse(req.body);
  const user = req.user!;
  
  if (isWeekend(validatedData.date)) {
    return sendBadRequest(res, "Termine können nicht an Samstagen oder Sonntagen erstellt werden.");
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
  
  const { customerData, appointmentData, scheduledEnd } = appointmentService.prepareErstberatungData({
    customer: validatedData.customer,
    date: validatedData.date,
    scheduledStart: validatedData.scheduledStart,
    erstberatungDauer: validatedData.erstberatungDauer,
    notes: validatedData.notes,
    assignedEmployeeId,
  });
  
  const overlapResult = await appointmentService.checkOverlap(
    validatedData.date, 
    validatedData.scheduledStart, 
    scheduledEnd
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
  
  const customerDataWithEmployee = {
    ...customerData,
    primaryEmployeeId: assignedEmployeeId,
  };
  
  const { customer, appointment } = await storage.createErstberatungWithCustomer(
    customerDataWithEmployee,
    appointmentData
  );
  
  res.status(201).json({ appointment, customer });
}));

router.patch("/:id", asyncHandler(ErrorMessages.updateAppointmentFailed, async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) {
    return sendBadRequest(res, ErrorMessages.invalidAppointmentId);
  }
  
  const existingAppointment = await storage.getAppointment(id);
  if (!existingAppointment) {
    return sendNotFound(res, ErrorMessages.appointmentNotFound);
  }
  
  if (!await checkCustomerAccess(req.user!, existingAppointment.customerId, res)) return;
  
  const isLocked = await storage.isAppointmentLocked(id);
  if (isLocked) {
    return sendForbidden(res, "APPOINTMENT_LOCKED", "Dieser Termin ist Teil eines unterschriebenen Leistungsnachweises und kann nicht mehr bearbeitet werden.");
  }
  
  const validatedData = updateAppointmentSchema.parse(req.body);
  
  if (validatedData.date && isWeekend(validatedData.date)) {
    return sendBadRequest(res, "Termine können nicht auf Samstage oder Sonntage verschoben werden.");
  }
  
  const validation = appointmentService.validateAllUpdateRules(existingAppointment, validatedData);
  if (!validation.valid) {
    return sendForbidden(res, validation.error!, validation.message!);
  }
  
  const updated = await storage.updateAppointment(id, validatedData);
  if (!updated) {
    return sendNotFound(res, ErrorMessages.appointmentNotFound);
  }
  
  if (req.body.services && Array.isArray(req.body.services)) {
    await storage.replaceAppointmentServices(id, req.body.services);
  }
  
  res.json(updated);
}));

router.post("/:id/start", asyncHandler("Fehler beim Starten des Besuchs", async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) {
    return sendBadRequest(res, ErrorMessages.invalidAppointmentId);
  }
  
  const appointment = await storage.getAppointment(id);
  if (!appointment) {
    return sendNotFound(res, ErrorMessages.appointmentNotFound);
  }
  
  if (!await checkCustomerAccess(req.user!, appointment.customerId, res)) return;
  
  const isLocked = await storage.isAppointmentLocked(id);
  if (isLocked) {
    return sendForbidden(res, "APPOINTMENT_LOCKED", "Dieser Termin ist Teil eines unterschriebenen Leistungsnachweises und kann nicht mehr bearbeitet werden.");
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
  const id = parseInt(req.params.id);
  if (isNaN(id)) {
    return sendBadRequest(res, ErrorMessages.invalidAppointmentId);
  }
  
  const appointment = await storage.getAppointment(id);
  if (!appointment) {
    return sendNotFound(res, ErrorMessages.appointmentNotFound);
  }
  
  if (!await checkCustomerAccess(req.user!, appointment.customerId, res)) return;
  
  const isLocked = await storage.isAppointmentLocked(id);
  if (isLocked) {
    return sendForbidden(res, "APPOINTMENT_LOCKED", "Dieser Termin ist Teil eines unterschriebenen Leistungsnachweises und kann nicht mehr bearbeitet werden.");
  }
  
  if (appointment.status !== "in-progress") {
    return sendForbidden(res, "INVALID_STATUS", "Nur laufende Termine können beendet werden");
  }
  
  const updatedAppointment = await storage.updateAppointment(id, {
    status: "documenting",
    actualEnd: currentTimeHHMMSS(),
  });
  
  res.json(updatedAppointment);
}));

router.get("/:id/travel-suggestion", asyncHandler("Fehler beim Laden der Fahrvorschläge", async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) {
    return sendBadRequest(res, ErrorMessages.invalidAppointmentId);
  }
  
  const appointment = await storage.getAppointmentWithCustomer(id);
  if (!appointment) {
    return sendNotFound(res, ErrorMessages.appointmentNotFound);
  }
  
  const sameDayAppointments = await storage.getAppointmentsWithCustomers(appointment.date);
  
  const appointmentsWithNames = sameDayAppointments.map(apt => ({
    ...apt,
    customerName: apt.customer?.name
  }));
  
  const suggestion = suggestTravelOrigin(appointment, appointmentsWithNames);
  
  res.json({
    suggestedOrigin: suggestion.suggestedOrigin,
    previousAppointmentId: suggestion.previousAppointment?.id ?? null,
    previousCustomerName: suggestion.previousCustomerName ?? null,
  });
}));

router.use(appointmentDocumentationRouter);

router.delete("/:id", asyncHandler(ErrorMessages.deleteAppointmentFailed, async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) {
    return sendBadRequest(res, ErrorMessages.invalidAppointmentId);
  }
  
  const appointment = await storage.getAppointment(id);
  if (!appointment) {
    return sendNotFound(res, ErrorMessages.appointmentNotFound);
  }
  
  if (!await checkCustomerAccess(req.user!, appointment.customerId, res)) return;
  
  const isLocked = await storage.isAppointmentLocked(id);
  if (isLocked) {
    return sendForbidden(res, "APPOINTMENT_LOCKED", "Dieser Termin ist Teil eines unterschriebenen Leistungsnachweises und kann nicht gelöscht werden.");
  }
  
  const canDelete = appointmentService.canDeleteAppointment(appointment);
  if (!canDelete.valid) {
    return sendForbidden(res, canDelete.error!, canDelete.message!);
  }
  
  const deleted = await storage.deleteAppointment(id);
  if (!deleted) {
    return sendServerError(res, ErrorMessages.deleteAppointmentFailed);
  }
  
  res.json({ success: true, message: "Termin erfolgreich gelöscht" });
}));

export default router;
