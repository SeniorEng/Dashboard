import { storage } from "../storage";
import type { Appointment, InsertAppointment, UpdateAppointment, InsertErstberatungCustomer } from "@shared/schema";
import { 
  doTimesOverlap, 
  addMinutesToTime, 
  calculateTotalDuration,
  isValidStatusTransition,
  canModifyAppointment,
  canEditNotes,
  timeToMinutes,
  getServiceTypeFromDurations,
  type AppointmentStatus
} from "@shared/types";

export interface OverlapCheckResult {
  hasOverlap: boolean;
  hasUnreliableData: boolean;
  unreliableAppointmentId?: number;
}

export interface ValidationResult {
  valid: boolean;
  error?: string;
  message?: string;
}

export interface KundenterminInput {
  customerId: number;
  date: string;
  scheduledStart: string;
  hauswirtschaftDauer: number | null;
  alltagsbegleitungDauer: number | null;
  notes?: string;
}

export interface ErstberatungInput {
  customer: InsertErstberatungCustomer;
  date: string;
  scheduledStart: string;
  erstberatungDauer: number;
  notes?: string;
}

export class AppointmentService {
  private formatTimeFromTimestamp(timestamp: Date): string {
    return timestamp.toTimeString().slice(0, 5);
  }

  async checkOverlap(
    date: string, 
    startTime: string, 
    endTime: string, 
    excludeId?: number
  ): Promise<OverlapCheckResult> {
    const existingAppointments = await storage.getAppointmentsByDate(date);
    
    for (const apt of existingAppointments) {
      if (excludeId && apt.id === excludeId) continue;
      
      if (apt.status === "completed") {
        if (apt.actualEnd) {
          const actualStart = apt.actualStart 
            ? this.formatTimeFromTimestamp(apt.actualStart) 
            : apt.scheduledStart;
          const actualEnd = this.formatTimeFromTimestamp(apt.actualEnd);
          
          if (doTimesOverlap(startTime, endTime, actualStart, actualEnd)) {
            return { hasOverlap: true, hasUnreliableData: false };
          }
        }
        continue;
      }
      
      const hasReliableEndTime = apt.scheduledEnd !== null;
      const hasReliableDuration = apt.durationPromised !== null && apt.durationPromised > 0;
      
      if (!hasReliableEndTime && !hasReliableDuration) {
        return { 
          hasOverlap: false, 
          hasUnreliableData: true,
          unreliableAppointmentId: apt.id
        };
      }
      
      const aptEndTime = apt.scheduledEnd || addMinutesToTime(apt.scheduledStart, apt.durationPromised!);
      
      if (doTimesOverlap(startTime, endTime, apt.scheduledStart, aptEndTime)) {
        return { hasOverlap: true, hasUnreliableData: false };
      }
    }
    
    return { hasOverlap: false, hasUnreliableData: false };
  }

  validateStatusTransition(
    currentStatus: string,
    targetStatus: string | undefined,
    updates: UpdateAppointment
  ): ValidationResult {
    const current = currentStatus as AppointmentStatus;
    const target = (targetStatus || currentStatus) as AppointmentStatus;
    
    if (!canModifyAppointment(current)) {
      return {
        valid: false,
        error: "Bearbeitung nicht möglich",
        message: "Abgeschlossene Termine können nicht mehr geändert werden."
      };
    }
    
    if (!isValidStatusTransition(current, target)) {
      return {
        valid: false,
        error: "Ungültiger Statuswechsel",
        message: "Der Status kann nur schrittweise vorwärts geändert werden."
      };
    }
    
    return { valid: true };
  }

  validateSchedulingChanges(
    currentStatus: string,
    targetStatus: string,
    updates: UpdateAppointment
  ): ValidationResult {
    const hasSchedulingChanges = 
      updates.date !== undefined || 
      updates.scheduledStart !== undefined || 
      updates.scheduledEnd !== undefined || 
      updates.hauswirtschaftDauer !== undefined || 
      updates.alltagsbegleitungDauer !== undefined || 
      updates.durationPromised !== undefined || 
      updates.serviceType !== undefined;
    
    if (hasSchedulingChanges) {
      if (currentStatus !== "scheduled" || targetStatus !== "scheduled") {
        return {
          valid: false,
          error: "Bearbeitung nicht möglich",
          message: "Zeit und Datum können nur bei geplanten Terminen geändert werden. Dieser Termin wurde bereits gestartet."
        };
      }
    }
    
    return { valid: true };
  }

  validateNotesChange(currentStatus: string, updates: UpdateAppointment): ValidationResult {
    if (updates.notes !== undefined) {
      if (!canEditNotes(currentStatus as AppointmentStatus)) {
        return {
          valid: false,
          error: "Bearbeitung nicht möglich",
          message: "Notizen können nur bei geplanten oder dokumentierten Terminen bearbeitet werden."
        };
      }
    }
    
    return { valid: true };
  }

  validateVisitTimeChanges(
    currentStatus: string,
    targetStatus: string,
    updates: UpdateAppointment
  ): ValidationResult {
    if (updates.actualStart !== undefined) {
      if (!(currentStatus === "scheduled" && targetStatus === "in-progress")) {
        return {
          valid: false,
          error: "Ungültige Aktion",
          message: "Der Besuch kann nur bei einem geplanten Termin gestartet werden."
        };
      }
    }
    
    if (updates.actualEnd !== undefined) {
      if (!(currentStatus === "in-progress" && targetStatus === "documenting")) {
        return {
          valid: false,
          error: "Ungültige Aktion",
          message: "Der Besuch kann nur bei einem laufenden Termin beendet werden."
        };
      }
    }
    
    return { valid: true };
  }

  validateDocumentationChanges(currentStatus: string, updates: UpdateAppointment): ValidationResult {
    const hasDocumentationChanges = 
      updates.kilometers !== undefined ||
      updates.servicesDone !== undefined || 
      updates.signatureData !== undefined;
    
    if (hasDocumentationChanges && currentStatus !== "documenting") {
      return {
        valid: false,
        error: "Bearbeitung nicht möglich",
        message: "Kilometer, erledigte Services und Unterschrift können erst nach dem Besuch dokumentiert werden."
      };
    }
    
    return { valid: true };
  }

  validateAllUpdateRules(
    existingAppointment: Appointment,
    updates: UpdateAppointment
  ): ValidationResult {
    const currentStatus = existingAppointment.status;
    const targetStatus = (updates.status || currentStatus) as string;
    
    const checks = [
      () => this.validateStatusTransition(currentStatus, updates.status, updates),
      () => this.validateSchedulingChanges(currentStatus, targetStatus, updates),
      () => this.validateNotesChange(currentStatus, updates),
      () => this.validateVisitTimeChanges(currentStatus, targetStatus, updates),
      () => this.validateDocumentationChanges(currentStatus, updates),
    ];
    
    for (const check of checks) {
      const result = check();
      if (!result.valid) return result;
    }
    
    return { valid: true };
  }

  prepareKundenterminData(input: KundenterminInput): {
    appointmentData: InsertAppointment;
    scheduledEnd: string;
    totalDuration: number;
  } {
    const totalDuration = calculateTotalDuration(
      input.hauswirtschaftDauer,
      input.alltagsbegleitungDauer
    );
    
    const scheduledEnd = addMinutesToTime(input.scheduledStart, totalDuration);
    
    const serviceType = getServiceTypeFromDurations(
      input.hauswirtschaftDauer,
      input.alltagsbegleitungDauer
    );
    
    const appointmentData: InsertAppointment = {
      customerId: input.customerId,
      appointmentType: "Kundentermin",
      serviceType,
      hauswirtschaftDauer: input.hauswirtschaftDauer,
      alltagsbegleitungDauer: input.alltagsbegleitungDauer,
      date: input.date,
      scheduledStart: input.scheduledStart,
      scheduledEnd,
      durationPromised: totalDuration,
      notes: input.notes || null,
      status: "scheduled",
    };
    
    return { appointmentData, scheduledEnd, totalDuration };
  }

  prepareErstberatungData(input: ErstberatungInput): {
    customerData: {
      name: string;
      vorname: string;
      nachname: string;
      telefon: string;
      address: string;
      strasse: string;
      nr: string;
      plz: string;
      stadt: string;
      pflegegrad: number;
      avatar: string;
      needs: string[];
    };
    appointmentData: Omit<InsertAppointment, 'customerId'>;
    scheduledEnd: string;
  } {
    const fullName = `${input.customer.vorname} ${input.customer.nachname}`;
    const fullAddress = `${input.customer.strasse} ${input.customer.nr}, ${input.customer.plz} ${input.customer.stadt}`;
    
    const scheduledEnd = addMinutesToTime(input.scheduledStart, input.erstberatungDauer);
    
    const customerData = {
      name: fullName,
      vorname: input.customer.vorname,
      nachname: input.customer.nachname,
      telefon: input.customer.telefon,
      address: fullAddress,
      strasse: input.customer.strasse,
      nr: input.customer.nr,
      plz: input.customer.plz,
      stadt: input.customer.stadt,
      pflegegrad: input.customer.pflegegrad,
      avatar: "person",
      needs: [],
    };
    
    const appointmentData: Omit<InsertAppointment, 'customerId'> = {
      appointmentType: "Erstberatung",
      serviceType: null,
      hauswirtschaftDauer: null,
      alltagsbegleitungDauer: null,
      erstberatungDauer: input.erstberatungDauer,
      date: input.date,
      scheduledStart: input.scheduledStart,
      scheduledEnd,
      durationPromised: input.erstberatungDauer,
      notes: input.notes || null,
      status: "scheduled",
    };
    
    return { customerData, appointmentData, scheduledEnd };
  }

  canDeleteAppointment(appointment: Appointment): ValidationResult {
    if (!canModifyAppointment(appointment.status as AppointmentStatus)) {
      return {
        valid: false,
        error: "Löschen nicht möglich",
        message: "Abgeschlossene Termine können nicht gelöscht werden."
      };
    }
    return { valid: true };
  }
}

export const appointmentService = new AppointmentService();
