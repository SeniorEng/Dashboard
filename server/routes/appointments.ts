import { Router } from "express";
import { storage } from "../storage";
import { 
  updateAppointmentSchema, 
  insertKundenterminSchema,
  insertErstberatungSchema 
} from "@shared/schema";
import { 
  doTimesOverlap, 
  addMinutesToTime, 
  calculateTotalDuration 
} from "@shared/types";
import { fromError } from "zod-validation-error";

const router = Router();

router.get("/", async (req, res) => {
  try {
    const appointments = await storage.getAppointmentsWithCustomers();
    res.json(appointments);
  } catch (error) {
    console.error("Failed to fetch appointments:", error);
    res.status(500).json({ error: "Failed to fetch appointments" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      return res.status(400).json({ error: "Invalid appointment ID" });
    }
    
    const appointment = await storage.getAppointmentWithCustomer(id);
    
    if (!appointment) {
      return res.status(404).json({ error: "Appointment not found" });
    }
    
    res.json(appointment);
  } catch (error) {
    console.error("Failed to fetch appointment:", error);
    res.status(500).json({ error: "Failed to fetch appointment" });
  }
});

// Result type for overlap checking
type OverlapCheckResult = {
  hasOverlap: boolean;
  hasUnreliableData: boolean;
  unreliableAppointmentId?: number;
};

// Helper to format timestamp to "HH:MM" time string
function formatTimeFromTimestamp(timestamp: Date): string {
  return timestamp.toTimeString().slice(0, 5);
}

// Check for overlapping appointments
// Returns detailed result including whether data is reliable for scheduling decisions
async function checkOverlap(date: string, startTime: string, endTime: string, excludeId?: number): Promise<OverlapCheckResult> {
  const existingAppointments = await storage.getAppointmentsByDate(date);
  
  for (const apt of existingAppointments) {
    // Skip the appointment being edited
    if (excludeId && apt.id === excludeId) continue;
    
    // COMPLETED APPOINTMENTS: Check against documented actual times
    // If no actualEnd recorded, skip - the appointment is done and no longer blocks time
    if (apt.status === "completed") {
      if (apt.actualEnd) {
        // Use the actual documented start/end times
        const actualStart = apt.actualStart ? formatTimeFromTimestamp(apt.actualStart) : apt.scheduledStart;
        const actualEnd = formatTimeFromTimestamp(apt.actualEnd);
        
        if (doTimesOverlap(startTime, endTime, actualStart, actualEnd)) {
          return { hasOverlap: true, hasUnreliableData: false };
        }
      }
      // No actualEnd = appointment is done, skip it
      continue;
    }
    
    // SCHEDULED/IN_PROGRESS APPOINTMENTS: Use planned end time
    // For these, scheduledEnd or durationPromised represents the booking intention
    const hasReliableEndTime = apt.scheduledEnd !== null;
    const hasReliableDuration = apt.durationPromised !== null && apt.durationPromised > 0;
    
    if (!hasReliableEndTime && !hasReliableDuration) {
      // Cannot determine when this appointment is scheduled to end
      return { 
        hasOverlap: false, 
        hasUnreliableData: true,
        unreliableAppointmentId: apt.id
      };
    }
    
    // Calculate end time using available data
    const aptEndTime = apt.scheduledEnd || addMinutesToTime(apt.scheduledStart, apt.durationPromised!);
    
    if (doTimesOverlap(startTime, endTime, apt.scheduledStart, aptEndTime)) {
      return { hasOverlap: true, hasUnreliableData: false };
    }
  }
  
  return { hasOverlap: false, hasUnreliableData: false };
}

// Create Kundentermin (existing customer)
router.post("/kundentermin", async (req, res) => {
  try {
    const validatedData = insertKundenterminSchema.parse(req.body);
    
    // Calculate total duration
    const totalDuration = calculateTotalDuration(
      validatedData.hauswirtschaftDauer,
      validatedData.alltagsbegleitungDauer
    );
    
    const scheduledEnd = addMinutesToTime(validatedData.scheduledStart, totalDuration);
    
    // Check for overlap
    const overlapResult = await checkOverlap(validatedData.date, validatedData.scheduledStart, scheduledEnd);
    if (overlapResult.hasUnreliableData) {
      return res.status(409).json({ 
        error: "Datenprüfung erforderlich",
        message: `Termin #${overlapResult.unreliableAppointmentId} hat unvollständige Zeitdaten. Bitte vervollständigen Sie die Termindaten bevor Sie neue Termine planen.`
      });
    }
    if (overlapResult.hasOverlap) {
      return res.status(409).json({ 
        error: "Terminüberschneidung",
        message: "Es gibt bereits einen Termin zu dieser Zeit"
      });
    }
    
    // Determine serviceType for display (legacy support)
    let serviceType = null;
    if (validatedData.hauswirtschaftDauer && validatedData.alltagsbegleitungDauer) {
      serviceType = "Hauswirtschaft"; // Both services
    } else if (validatedData.hauswirtschaftDauer) {
      serviceType = "Hauswirtschaft";
    } else if (validatedData.alltagsbegleitungDauer) {
      serviceType = "Alltagsbegleitung";
    }
    
    const appointment = await storage.createAppointment({
      customerId: validatedData.customerId,
      appointmentType: "Kundentermin",
      serviceType,
      hauswirtschaftDauer: validatedData.hauswirtschaftDauer || null,
      alltagsbegleitungDauer: validatedData.alltagsbegleitungDauer || null,
      date: validatedData.date,
      scheduledStart: validatedData.scheduledStart,
      scheduledEnd,
      durationPromised: totalDuration,
      notes: validatedData.notes || null,
      status: "scheduled",
    });
    
    res.status(201).json(appointment);
  } catch (error: any) {
    if (error.name === "ZodError") {
      return res.status(400).json({ error: fromError(error).toString() });
    }
    console.error("Failed to create Kundentermin:", error);
    res.status(500).json({ 
      error: "Serverfehler",
      message: "Der Termin konnte nicht erstellt werden. Bitte versuchen Sie es erneut."
    });
  }
});

// Create Erstberatung (new customer)
router.post("/erstberatung", async (req, res) => {
  try {
    const validatedData = insertErstberatungSchema.parse(req.body);
    
    // Check for overlap
    const overlapResult = await checkOverlap(validatedData.date, validatedData.scheduledStart, validatedData.scheduledEnd);
    if (overlapResult.hasUnreliableData) {
      return res.status(409).json({ 
        error: "Datenprüfung erforderlich",
        message: `Termin #${overlapResult.unreliableAppointmentId} hat unvollständige Zeitdaten. Bitte vervollständigen Sie die Termindaten bevor Sie neue Termine planen.`
      });
    }
    if (overlapResult.hasOverlap) {
      return res.status(409).json({ 
        error: "Terminüberschneidung",
        message: "Es gibt bereits einen Termin zu dieser Zeit"
      });
    }
    
    // Create the new customer first
    const fullName = `${validatedData.customer.vorname} ${validatedData.customer.nachname}`;
    const fullAddress = `${validatedData.customer.strasse} ${validatedData.customer.nr}, ${validatedData.customer.plz} ${validatedData.customer.stadt}`;
    
    const customer = await storage.createCustomer({
      name: fullName,
      vorname: validatedData.customer.vorname,
      nachname: validatedData.customer.nachname,
      telefon: validatedData.customer.telefon,
      address: fullAddress,
      strasse: validatedData.customer.strasse,
      nr: validatedData.customer.nr,
      plz: validatedData.customer.plz,
      stadt: validatedData.customer.stadt,
      pflegegrad: validatedData.customer.pflegegrad,
      avatar: "person",
      needs: [],
    });
    
    // Calculate duration from start to end time
    const startMinutes = parseInt(validatedData.scheduledStart.split(":")[0]) * 60 + parseInt(validatedData.scheduledStart.split(":")[1]);
    const endMinutes = parseInt(validatedData.scheduledEnd.split(":")[0]) * 60 + parseInt(validatedData.scheduledEnd.split(":")[1]);
    const duration = endMinutes - startMinutes;
    
    // Create the appointment
    const appointment = await storage.createAppointment({
      customerId: customer.id,
      appointmentType: "Erstberatung",
      serviceType: null,
      hauswirtschaftDauer: null,
      alltagsbegleitungDauer: null,
      date: validatedData.date,
      scheduledStart: validatedData.scheduledStart,
      scheduledEnd: validatedData.scheduledEnd,
      durationPromised: duration,
      notes: validatedData.notes || null,
      status: "scheduled",
    });
    
    res.status(201).json({ appointment, customer });
  } catch (error: any) {
    if (error.name === "ZodError") {
      return res.status(400).json({ error: fromError(error).toString() });
    }
    console.error("Failed to create Erstberatung:", error);
    res.status(500).json({ 
      error: "Serverfehler",
      message: "Die Erstberatung konnte nicht erstellt werden. Bitte versuchen Sie es erneut."
    });
  }
});

router.patch("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      return res.status(400).json({ error: "Invalid appointment ID" });
    }
    
    const validatedData = updateAppointmentSchema.parse(req.body);
    const appointment = await storage.updateAppointment(id, validatedData);
    
    if (!appointment) {
      return res.status(404).json({ error: "Appointment not found" });
    }
    
    res.json(appointment);
  } catch (error: any) {
    if (error.name === "ZodError") {
      return res.status(400).json({ error: fromError(error).toString() });
    }
    console.error("Failed to update appointment:", error);
    res.status(500).json({ error: "Failed to update appointment" });
  }
});

export default router;
