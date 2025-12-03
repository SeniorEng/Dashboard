import { Router } from "express";
import { storage } from "../storage";
import { 
  updateAppointmentSchema, 
  insertKundenterminSchema,
  insertErstberatungSchema,
  documentKundenterminSchema
} from "@shared/schema";
import { appointmentService } from "../services/appointments";
import { suggestTravelOrigin, validateServiceDocumentation } from "@shared/domain/appointments";
import { 
  ErrorMessages, 
  handleRouteError, 
  sendBadRequest, 
  sendConflict, 
  sendForbidden, 
  sendNotFound,
  sendServerError
} from "../lib/errors";

const router = Router();

router.get("/", async (req, res) => {
  try {
    const date = req.query.date as string | undefined;
    const appointments = await storage.getAppointmentsWithCustomers(date);
    res.json(appointments);
  } catch (error) {
    handleRouteError(res, error, ErrorMessages.fetchAppointmentsFailed, "Failed to fetch appointments");
  }
});

router.get("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      return sendBadRequest(res, ErrorMessages.invalidAppointmentId);
    }
    
    const appointment = await storage.getAppointmentWithCustomer(id);
    
    if (!appointment) {
      return sendNotFound(res, ErrorMessages.appointmentNotFound);
    }
    
    res.json(appointment);
  } catch (error) {
    handleRouteError(res, error, ErrorMessages.fetchAppointmentFailed, "Failed to fetch appointment");
  }
});

router.post("/kundentermin", async (req, res) => {
  try {
    const validatedData = insertKundenterminSchema.parse(req.body);
    
    const { appointmentData, scheduledEnd } = appointmentService.prepareKundenterminData({
      customerId: validatedData.customerId,
      date: validatedData.date,
      scheduledStart: validatedData.scheduledStart,
      hauswirtschaftDauer: validatedData.hauswirtschaftDauer ?? null,
      alltagsbegleitungDauer: validatedData.alltagsbegleitungDauer ?? null,
      notes: validatedData.notes,
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
    res.status(201).json(appointment);
  } catch (error) {
    handleRouteError(res, error, ErrorMessages.createAppointmentFailed, "Failed to create Kundentermin");
  }
});

router.post("/erstberatung", async (req, res) => {
  try {
    const validatedData = insertErstberatungSchema.parse(req.body);
    
    const overlapResult = await appointmentService.checkOverlap(
      validatedData.date, 
      validatedData.scheduledStart, 
      validatedData.scheduledEnd
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
    
    const { customerData, appointmentData } = appointmentService.prepareErstberatungData({
      customer: validatedData.customer,
      date: validatedData.date,
      scheduledStart: validatedData.scheduledStart,
      scheduledEnd: validatedData.scheduledEnd,
      notes: validatedData.notes,
    });
    
    const { customer, appointment } = await storage.createErstberatungWithCustomer(
      customerData,
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
    
    const validatedData = updateAppointmentSchema.parse(req.body);
    
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
    
    if (appointment.status !== "scheduled") {
      return sendForbidden(res, "INVALID_STATUS", "Nur geplante Termine können gestartet werden");
    }
    
    const updatedAppointment = await storage.updateAppointment(id, {
      status: "in-progress",
      actualStart: new Date(),
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
    
    if (appointment.status !== "in-progress") {
      return sendForbidden(res, "INVALID_STATUS", "Nur laufende Termine können beendet werden");
    }
    
    const updatedAppointment = await storage.updateAppointment(id, {
      status: "documenting",
      actualEnd: new Date(),
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
    
    if (appointment.appointmentType !== "Kundentermin") {
      return sendForbidden(res, "INVALID_TYPE", "Nur Kundentermine können dokumentiert werden");
    }
    
    if (appointment.status !== "documenting") {
      return sendForbidden(res, "INVALID_STATUS", "Der Termin muss im Status 'Dokumentation' sein");
    }
    
    const validatedData = documentKundenterminSchema.parse(req.body);
    
    const serviceValidation = validateServiceDocumentation(
      appointment,
      validatedData.hauswirtschaftActualDauer,
      validatedData.hauswirtschaftDetails,
      validatedData.alltagsbegleitungActualDauer,
      validatedData.alltagsbegleitungDetails
    );
    
    if (!serviceValidation.valid) {
      return sendBadRequest(res, serviceValidation.errors.join(", "));
    }
    
    const updateData = {
      hauswirtschaftActualDauer: validatedData.hauswirtschaftActualDauer ?? null,
      hauswirtschaftDetails: validatedData.hauswirtschaftDetails ?? null,
      alltagsbegleitungActualDauer: validatedData.alltagsbegleitungActualDauer ?? null,
      alltagsbegleitungDetails: validatedData.alltagsbegleitungDetails ?? null,
      travelOriginType: validatedData.travelOriginType,
      travelFromAppointmentId: validatedData.travelFromAppointmentId ?? null,
      travelKilometers: validatedData.travelKilometers,
      travelMinutes: validatedData.travelMinutes ?? null,
      notes: validatedData.notes ?? appointment.notes,
      status: "completed" as const,
    };
    
    const updatedAppointment = await storage.updateAppointment(id, updateData);
    
    if (!updatedAppointment) {
      return sendServerError(res, "Fehler beim Speichern der Dokumentation");
    }
    
    res.json(updatedAppointment);
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
