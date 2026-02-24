import { storage, type IStorage } from "../storage";
import type { Appointment, InsertAppointment, UpdateAppointment, InsertErstberatungCustomer } from "@shared/schema";
import { timeToMinutes, addMinutesToTime, addMinutesToTimeHHMMSS, formatTimeHHMMSS } from "@shared/utils/datetime";
import { validateServiceDocumentationFromServices } from "@shared/domain/appointments";
import { 
  doTimesOverlap, 
  isValidStatusTransition,
  canModifyAppointment,
  canEditNotes,
  type AppointmentStatus
} from "@shared/types";

/**
 * Minimal storage interface for AppointmentService
 * This allows for easier testing by injecting mock implementations
 */
export interface IAppointmentStorage {
  getAppointmentsByDate(date: string): Promise<Appointment[]>;
}

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

export interface DocumentationServiceEntry {
  serviceId: number;
  actualDurationMinutes: number;
  details?: string | null;
  serviceCode?: string | null;
}

export interface DocumentationInput {
  performedByEmployeeId?: number | null;
  actualStart: string;
  travelOriginType: "home" | "appointment";
  travelFromAppointmentId?: number | null;
  travelKilometers: number;
  travelMinutes?: number | null;
  customerKilometers?: number | null;
  notes?: string | null;
  services: DocumentationServiceEntry[];
}

export interface DocumentationResult {
  updateData: Record<string, unknown>;
  totalDurationMinutes: number;
  hauswirtschaftMinutes: number;
  alltagsbegleitungMinutes: number;
  travelKilometers: number;
  customerKilometers: number;
  hasUsage: boolean;
  serviceUpdates?: DocumentationServiceEntry[];
}

export interface KundenterminInput {
  customerId: number;
  date: string;
  scheduledStart: string;
  services: Array<{ serviceId: number; durationMinutes: number; serviceCode?: string | null }>;
  notes?: string;
  assignedEmployeeId?: number | null;
}

export interface ErstberatungInput {
  customer: InsertErstberatungCustomer;
  date: string;
  scheduledStart: string;
  erstberatungDauer: number;
  notes?: string;
  assignedEmployeeId?: number | null;
}

export class AppointmentService {
  private storage: IAppointmentStorage;

  /**
   * Create an AppointmentService instance
   * @param storageImpl - Storage implementation (defaults to global storage singleton for backward compatibility)
   */
  constructor(storageImpl: IAppointmentStorage = storage) {
    this.storage = storageImpl;
  }

  /**
   * Format time string to HH:MM format for display
   * Note: With harmonized time system, actualStart/actualEnd are now stored as time strings
   */
  private formatTimeForDisplay(timeStr: string): string {
    // Time is now stored as "HH:MM:SS" - extract "HH:MM"
    return timeStr.slice(0, 5);
  }

  async checkOverlap(
    date: string, 
    startTime: string, 
    endTime: string, 
    excludeId?: number
  ): Promise<OverlapCheckResult> {
    const existingAppointments = await this.storage.getAppointmentsByDate(date);
    
    for (const apt of existingAppointments) {
      if (excludeId && apt.id === excludeId) continue;
      
      if (apt.status === "completed") {
        if (apt.actualEnd) {
          // actualStart and actualEnd are now time strings (HH:MM:SS)
          const actualStart = apt.actualStart 
            ? this.formatTimeForDisplay(apt.actualStart) 
            : apt.scheduledStart;
          const actualEnd = this.formatTimeForDisplay(apt.actualEnd);
          
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
    serviceEntries: Array<{ serviceId: number; plannedDurationMinutes: number }>;
  } {
    const totalDuration = input.services.reduce((sum, s) => sum + s.durationMinutes, 0);
    
    const scheduledEnd = addMinutesToTimeHHMMSS(input.scheduledStart, totalDuration);
    
    const appointmentData: InsertAppointment = {
      customerId: input.customerId,
      appointmentType: "Kundentermin",
      date: input.date,
      scheduledStart: input.scheduledStart,
      scheduledEnd,
      durationPromised: totalDuration,
      notes: input.notes || null,
      status: "scheduled",
      assignedEmployeeId: input.assignedEmployeeId ?? null,
    };
    
    const serviceEntries = input.services.map(s => ({
      serviceId: s.serviceId,
      plannedDurationMinutes: s.durationMinutes,
    }));
    
    return { appointmentData, scheduledEnd, totalDuration, serviceEntries };
  }

  prepareErstberatungData(input: ErstberatungInput): {
    customerData: {
      name: string;
      vorname: string;
      nachname: string;
      telefon: string;
      email?: string | null;
      address: string;
      strasse: string;
      nr: string;
      plz: string;
      stadt: string;
      pflegegrad: number;
    };
    appointmentData: Omit<InsertAppointment, 'customerId'>;
    scheduledEnd: string;
  } {
    const fullName = `${input.customer.vorname} ${input.customer.nachname}`;
    const fullAddress = `${input.customer.strasse} ${input.customer.nr}, ${input.customer.plz} ${input.customer.stadt}`;
    
    const scheduledEnd = addMinutesToTimeHHMMSS(input.scheduledStart, input.erstberatungDauer);
    
    const customerData = {
      name: fullName,
      vorname: input.customer.vorname,
      nachname: input.customer.nachname,
      telefon: input.customer.telefon,
      email: input.customer.email || null,
      status: "erstberatung" as const,
      address: fullAddress,
      strasse: input.customer.strasse,
      nr: input.customer.nr,
      plz: input.customer.plz,
      stadt: input.customer.stadt,
      pflegegrad: input.customer.pflegegrad ?? 0,
    };
    
    const appointmentData: Omit<InsertAppointment, 'customerId'> = {
      appointmentType: "Erstberatung",
      date: input.date,
      scheduledStart: input.scheduledStart,
      scheduledEnd,
      durationPromised: input.erstberatungDauer,
      notes: input.notes || null,
      status: "scheduled",
      assignedEmployeeId: input.assignedEmployeeId ?? null,
    };
    
    return { customerData, appointmentData, scheduledEnd };
  }

  validateDocumentationInput(
    appointment: Appointment,
    input: DocumentationInput
  ): ValidationResult {
    if (appointment.status === "completed") {
      return { valid: false, error: "ALREADY_COMPLETED", message: "Dieser Termin wurde bereits dokumentiert" };
    }

    const serviceValidation = validateServiceDocumentationFromServices(
      input.services.map(s => ({
        actualDurationMinutes: s.actualDurationMinutes,
        details: s.details,
      }))
    );
    if (!serviceValidation.valid) {
      return { valid: false, error: "VALIDATION_ERROR", message: serviceValidation.errors.join(", ") };
    }

    return { valid: true };
  }

  buildDocumentationUpdate(
    appointment: Appointment,
    input: DocumentationInput,
    userId?: number
  ): DocumentationResult {
    const performedBy = input.performedByEmployeeId ?? appointment.assignedEmployeeId ?? userId ?? null;
    const actualStartTime = formatTimeHHMMSS(input.actualStart);
    const totalDurationMinutes = input.services.reduce((sum, s) => sum + (s.actualDurationMinutes || 0), 0);
    const actualEndTime = addMinutesToTimeHHMMSS(actualStartTime, totalDurationMinutes);

    const travelKm = input.travelKilometers || 0;
    const customerKm = input.customerKilometers || 0;

    const updateData: Record<string, unknown> = {
      performedByEmployeeId: performedBy,
      actualStart: actualStartTime,
      actualEnd: actualEndTime,
      travelOriginType: input.travelOriginType,
      travelFromAppointmentId: input.travelFromAppointmentId ?? null,
      travelKilometers: input.travelKilometers,
      travelMinutes: input.travelMinutes ?? null,
      customerKilometers: input.customerKilometers ?? null,
      notes: input.notes ?? appointment.notes,
      status: "completed" as const,
    };

    const hauswirtschaftMinutes = input.services
      .filter(s => s.serviceCode === 'hauswirtschaft')
      .reduce((sum, s) => sum + (s.actualDurationMinutes || 0), 0);
    const alltagsbegleitungMinutes = input.services
      .filter(s => s.serviceCode === 'alltagsbegleitung')
      .reduce((sum, s) => sum + (s.actualDurationMinutes || 0), 0);

    return {
      updateData,
      totalDurationMinutes,
      hauswirtschaftMinutes,
      alltagsbegleitungMinutes,
      travelKilometers: travelKm,
      customerKilometers: customerKm,
      hasUsage: hauswirtschaftMinutes > 0 || alltagsbegleitungMinutes > 0 || travelKm > 0 || customerKm > 0,
      serviceUpdates: input.services,
    };
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
