import { Router } from "express";
import { storage } from "../storage";
import { budgetLedgerStorage } from "../storage/budget-ledger";
import { 
  updateAppointmentSchema, 
  insertKundenterminSchema,
  insertErstberatungSchema,
  documentKundenterminSchema,
  services as servicesTable,
  appointmentServices,
} from "@shared/schema";
import { appointmentService } from "../services/appointments";
import { authService } from "../services/auth";
import { suggestTravelOrigin } from "@shared/domain/appointments";
import { isWeekend, currentTimeHHMMSS, todayISO } from "@shared/utils/datetime";
import { 
  ErrorMessages, 
  handleRouteError, 
  sendBadRequest, 
  sendConflict, 
  sendForbidden, 
  sendNotFound,
  sendServerError
} from "../lib/errors";
import { requireAuth } from "../middleware/auth";
import { db } from "../lib/db";
import { eq, inArray, and } from "drizzle-orm";
import type { Response } from "express";

const router = Router();

async function checkCustomerAccess(user: Express.User, customerId: number, res: Response): Promise<boolean> {
  if (user.isAdmin) return true;
  const assignedCustomerIds = await storage.getAssignedCustomerIds(user.id);
  if (!assignedCustomerIds.includes(customerId)) {
    sendForbidden(res, "ACCESS_DENIED", "Sie haben keinen Zugriff auf diesen Termin.");
    return false;
  }
  return true;
}

router.use(requireAuth);

router.get("/active-employees", async (_req, res) => {
  try {
    const employees = await authService.getActiveEmployees();
    const safeEmployees = employees.map(({ passwordHash, ...employee }) => ({
      id: employee.id,
      displayName: employee.displayName,
    }));
    res.json(safeEmployees);
  } catch (error) {
    handleRouteError(res, error, "Mitarbeiter konnten nicht geladen werden", "Failed to fetch active employees");
  }
});

router.get("/", async (req, res) => {
  try {
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
  } catch (error) {
    handleRouteError(res, error, ErrorMessages.fetchAppointmentsFailed, "Failed to fetch appointments");
  }
});

router.get("/counts", async (req, res) => {
  try {
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
  } catch (error) {
    handleRouteError(res, error, "Fehler beim Laden der Terminzähler", "Failed to fetch appointment counts");
  }
});

// Get undocumented past appointments (needs documentation)
router.get("/undocumented", async (req, res) => {
  try {
    const user = req.user!;
    const today = todayISO();
    
    const customerIds = user.isAdmin 
      ? undefined 
      : await storage.getAssignedCustomerIds(user.id);
    
    const appointments = await storage.getUndocumentedAppointments(today, customerIds);
    
    res.json(appointments);
  } catch (error) {
    handleRouteError(res, error, "Fehler beim Laden der offenen Dokumentationen", "Failed to fetch undocumented appointments");
  }
});

router.get("/:id/services", async (req, res) => {
  try {
    const user = req.user!;
    const id = parseInt(req.params.id);
    if (isNaN(id)) return sendBadRequest(res, "Ungültige Termin-ID");
    
    const appointment = await storage.getAppointment(id);
    if (!appointment) return sendNotFound(res, "Termin nicht gefunden");
    if (!(await checkCustomerAccess(user, appointment.customerId, res))) return;
    
    const result = await db.select({
      id: appointmentServices.id,
      serviceId: appointmentServices.serviceId,
      plannedDurationMinutes: appointmentServices.plannedDurationMinutes,
      actualDurationMinutes: appointmentServices.actualDurationMinutes,
      details: appointmentServices.details,
      serviceName: servicesTable.name,
      serviceCode: servicesTable.code,
      serviceUnitType: servicesTable.unitType,
    })
    .from(appointmentServices)
    .innerJoin(servicesTable, eq(appointmentServices.serviceId, servicesTable.id))
    .where(eq(appointmentServices.appointmentId, id));
    
    res.json(result);
  } catch (error) {
    handleRouteError(res, error, "Fehler beim Laden der Termin-Services", "Failed to fetch appointment services");
  }
});

router.get("/:id", async (req, res) => {
  try {
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
  } catch (error) {
    handleRouteError(res, error, ErrorMessages.fetchAppointmentFailed, "Failed to fetch appointment");
  }
});

router.post("/kundentermin", async (req, res) => {
  try {
    const validatedData = insertKundenterminSchema.parse(req.body);
    const user = req.user!;
    
    if (isWeekend(validatedData.date)) {
      return sendBadRequest(res, "Termine können nicht an Samstagen oder Sonntagen erstellt werden.");
    }
    
    // Determine assigned employee
    let assignedEmployeeId: number;
    if (user.isAdmin) {
      // Admin MUST explicitly select an employee
      if (!validatedData.assignedEmployeeId) {
        return sendBadRequest(res, "Bitte wählen Sie einen Mitarbeiter für diesen Termin aus.");
      }
      assignedEmployeeId = validatedData.assignedEmployeeId;
      
      // Validate that employee is assigned to this customer
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
    const serviceRecords = await db.select({ id: servicesTable.id, code: servicesTable.code }).from(servicesTable).where(inArray(servicesTable.id, serviceIds));
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
      await db.insert(appointmentServices).values(
        serviceEntries.map(entry => ({
          appointmentId: appointment.id,
          serviceId: entry.serviceId,
          plannedDurationMinutes: entry.plannedDurationMinutes,
        }))
      );
    }

    res.status(201).json(appointment);
  } catch (error) {
    handleRouteError(res, error, ErrorMessages.createAppointmentFailed, "Failed to create Kundentermin");
  }
});

router.post("/erstberatung", async (req, res) => {
  try {
    const validatedData = insertErstberatungSchema.parse(req.body);
    const user = req.user!;
    
    if (isWeekend(validatedData.date)) {
      return sendBadRequest(res, "Termine können nicht an Samstagen oder Sonntagen erstellt werden.");
    }
    
    // Determine assigned employee
    let assignedEmployeeId: number;
    if (user.isAdmin) {
      // Admin MUST explicitly select an employee
      if (!validatedData.assignedEmployeeId) {
        return sendBadRequest(res, "Bitte wählen Sie einen Mitarbeiter für diese Erstberatung aus.");
      }
      assignedEmployeeId = validatedData.assignedEmployeeId;
      // Note: For Erstberatung, we're creating a NEW customer, so we can't validate assignment yet.
      // The selected employee will become the primary employee for this new customer.
    } else {
      // Regular employee creates appointments for themselves
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
    
    // Set the assigned employee as primary employee for the new customer
    const customerDataWithEmployee = {
      ...customerData,
      primaryEmployeeId: assignedEmployeeId,
    };
    
    const { customer, appointment } = await storage.createErstberatungWithCustomer(
      customerDataWithEmployee,
      appointmentData
    );
    
    res.status(201).json({ appointment, customer });
  } catch (error) {
    handleRouteError(res, error, ErrorMessages.createErstberatungFailed, "Failed to create Erstberatung");
  }
});

router.patch("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      return sendBadRequest(res, ErrorMessages.invalidAppointmentId);
    }
    
    const existingAppointment = await storage.getAppointment(id);
    if (!existingAppointment) {
      return sendNotFound(res, ErrorMessages.appointmentNotFound);
    }
    
    if (!await checkCustomerAccess(req.user!, existingAppointment.customerId, res)) return;
    
    // Check if appointment is locked by a signed service record
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
    
    const appointment = await storage.updateAppointment(id, validatedData);
    
    if (!appointment) {
      return sendNotFound(res, ErrorMessages.appointmentNotFound);
    }
    
    res.json(appointment);
  } catch (error) {
    handleRouteError(res, error, ErrorMessages.updateAppointmentFailed, "Failed to update appointment");
  }
});

router.post("/:id/start", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      return sendBadRequest(res, ErrorMessages.invalidAppointmentId);
    }
    
    const appointment = await storage.getAppointment(id);
    if (!appointment) {
      return sendNotFound(res, ErrorMessages.appointmentNotFound);
    }
    
    if (!await checkCustomerAccess(req.user!, appointment.customerId, res)) return;
    
    // Check if appointment is locked by a signed service record
    const isLocked = await storage.isAppointmentLocked(id);
    if (isLocked) {
      return sendForbidden(res, "APPOINTMENT_LOCKED", "Dieser Termin ist Teil eines unterschriebenen Leistungsnachweises und kann nicht mehr bearbeitet werden.");
    }
    
    if (appointment.status !== "scheduled") {
      return sendForbidden(res, "INVALID_STATUS", "Nur geplante Termine können gestartet werden");
    }
    
    // Store actualStart as time string (HH:MM:SS) - harmonized time system
    const updatedAppointment = await storage.updateAppointment(id, {
      status: "in-progress",
      actualStart: currentTimeHHMMSS(),
    });
    
    res.json(updatedAppointment);
  } catch (error) {
    handleRouteError(res, error, "Fehler beim Starten des Besuchs", "Failed to start visit");
  }
});

router.post("/:id/end", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      return sendBadRequest(res, ErrorMessages.invalidAppointmentId);
    }
    
    const appointment = await storage.getAppointment(id);
    if (!appointment) {
      return sendNotFound(res, ErrorMessages.appointmentNotFound);
    }
    
    if (!await checkCustomerAccess(req.user!, appointment.customerId, res)) return;
    
    // Check if appointment is locked by a signed service record
    const isLocked = await storage.isAppointmentLocked(id);
    if (isLocked) {
      return sendForbidden(res, "APPOINTMENT_LOCKED", "Dieser Termin ist Teil eines unterschriebenen Leistungsnachweises und kann nicht mehr bearbeitet werden.");
    }
    
    if (appointment.status !== "in-progress") {
      return sendForbidden(res, "INVALID_STATUS", "Nur laufende Termine können beendet werden");
    }
    
    // Store actualEnd as time string (HH:MM:SS) - harmonized time system
    const updatedAppointment = await storage.updateAppointment(id, {
      status: "documenting",
      actualEnd: currentTimeHHMMSS(),
    });
    
    res.json(updatedAppointment);
  } catch (error) {
    handleRouteError(res, error, "Fehler beim Beenden des Besuchs", "Failed to end visit");
  }
});

router.get("/:id/travel-suggestion", async (req, res) => {
  try {
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
  } catch (error) {
    handleRouteError(res, error, "Fehler beim Laden der Fahrvorschläge", "Failed to get travel suggestion");
  }
});

router.post("/:id/document", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      return sendBadRequest(res, ErrorMessages.invalidAppointmentId);
    }
    
    const appointment = await storage.getAppointment(id);
    if (!appointment) {
      return sendNotFound(res, ErrorMessages.appointmentNotFound);
    }
    
    if (!await checkCustomerAccess(req.user!, appointment.customerId, res)) return;
    
    // Check if appointment is locked by a signed service record
    const isLocked = await storage.isAppointmentLocked(id);
    if (isLocked) {
      return sendForbidden(res, "APPOINTMENT_LOCKED", "Dieser Termin ist Teil eines unterschriebenen Leistungsnachweises und kann nicht mehr bearbeitet werden.");
    }
    
    const validatedData = documentKundenterminSchema.parse(req.body);

    const validation = appointmentService.validateDocumentationInput(appointment, validatedData);
    if (!validation.valid) {
      if (validation.error === "ALREADY_COMPLETED") {
        return sendForbidden(res, validation.error, validation.message!);
      }
      return sendBadRequest(res, validation.message!);
    }
    
    const docResult = appointmentService.buildDocumentationUpdate(appointment, validatedData, req.user?.id);
    const { updateData, hauswirtschaftMinutes, alltagsbegleitungMinutes, travelKilometers, customerKilometers, hasUsage } = docResult;
    
    let budgetTransaction = null;
    let budgetWarning: string | null = null;
    
    if (hasUsage) {
      try {
        budgetTransaction = await budgetLedgerStorage.createConsumptionTransaction({
          customerId: appointment.customerId,
          appointmentId: id,
          transactionDate: appointment.date,
          hauswirtschaftMinutes,
          alltagsbegleitungMinutes,
          travelKilometers,
          customerKilometers,
          userId: req.user?.id,
        });

        try {
          const summary = await budgetLedgerStorage.getBudgetSummary(appointment.customerId);
          if (summary.monthlyLimitCents !== null && summary.currentMonthUsedCents > summary.monthlyLimitCents) {
            const limitEuro = (summary.monthlyLimitCents / 100).toFixed(2);
            const usedEuro = (summary.currentMonthUsedCents / 100).toFixed(2);
            budgetWarning = `Hinweis: Das vereinbarte Monatslimit von ${limitEuro} € wurde überschritten (aktuell ${usedEuro} €).`;
          }
        } catch {
        }
      } catch (budgetError: any) {
        const errorMessage = budgetError?.message || "Budget-Abbuchung fehlgeschlagen";
        if (errorMessage.includes("Preisvereinbarung")) {
          return sendBadRequest(res, `${errorMessage}. Bitte hinterlegen Sie zuerst eine Preisvereinbarung für diesen Kunden.`);
        }
        budgetWarning = errorMessage;
        console.warn("Budget booking warning:", budgetError);
      }
    }
    
    const updatedAppointment = await storage.updateAppointment(id, updateData);
    
    if (!updatedAppointment) {
      return sendServerError(res, "Fehler beim Speichern der Dokumentation");
    }

    if (docResult.serviceUpdates && docResult.serviceUpdates.length > 0) {
      for (const serviceUpdate of docResult.serviceUpdates) {
        await db.update(appointmentServices)
          .set({
            actualDurationMinutes: serviceUpdate.actualDurationMinutes,
            details: serviceUpdate.details ?? null,
          })
          .where(
            and(
              eq(appointmentServices.appointmentId, id),
              eq(appointmentServices.serviceId, serviceUpdate.serviceId)
            )
          );
      }
    }
    
    res.json({
      ...updatedAppointment,
      budgetTransaction,
      budgetWarning,
    });
  } catch (error) {
    handleRouteError(res, error, "Fehler beim Speichern der Dokumentation", "Failed to document appointment");
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      return sendBadRequest(res, ErrorMessages.invalidAppointmentId);
    }
    
    const appointment = await storage.getAppointment(id);
    if (!appointment) {
      return sendNotFound(res, ErrorMessages.appointmentNotFound);
    }
    
    if (!await checkCustomerAccess(req.user!, appointment.customerId, res)) return;
    
    // Check if appointment is locked by a signed service record
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
  } catch (error) {
    handleRouteError(res, error, ErrorMessages.deleteAppointmentFailed, "Failed to delete appointment");
  }
});

export default router;
