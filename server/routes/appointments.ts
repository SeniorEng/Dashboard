import { Router } from "express";
import { storage } from "../storage";
import { 
  updateAppointmentSchema, 
  insertKundenterminSchema,
  insertErstberatungSchema 
} from "@shared/schema";
import { appointmentService } from "../services/appointments";
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
