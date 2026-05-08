import { storage, type IStorage } from "../storage";
import type { Appointment, InsertAppointment, UpdateAppointment } from "@shared/schema";
import { timeToMinutes, addMinutesToTime, addMinutesToTimeHHMMSS, formatTimeHHMMSS } from "@shared/utils/datetime";
import { validateServiceDocumentationFromServices } from "@shared/domain/appointments";
import { 
  doTimesOverlap, 
  isValidStatusTransition,
  canModifyAppointment,
  canEditNotes,
  type AppointmentStatus
} from "@shared/types";
import { db, type DbOrTx } from "../lib/db";
import { badRequest } from "../lib/errors";
import { eq } from "drizzle-orm";

export interface ServiceLineDuration {
  serviceId: number;
  plannedDurationMinutes: number;
}

/**
 * Pure: Skaliert die Service-Zeilen so, dass deren Summe exakt `newTotal`
 * ergibt. Garantien:
 *
 * - `newTotal < 0` wird wie `0` behandelt.
 * - Summe der Rückgabe == `newTotal` (modulo Integer-Arithmetik).
 * - Keine Zeile bekommt einen negativen Wert.
 * - Falls `newTotal >= services.length`, bekommt jede Zeile mind. 1 Minute.
 * - Falls `newTotal < services.length`, dürfen einzelne Zeilen 0 Minuten
 *   werden (sonst wäre die Summen-Invariante nicht haltbar).
 *
 * Bei einer einzigen Zeile 1:1, bei mehreren proportional verteilt;
 * Restminuten landen auf der größten Zeile.
 */
export function scaleServiceDurations(
  services: ReadonlyArray<ServiceLineDuration>,
  newTotal: number,
): ServiceLineDuration[] {
  if (services.length === 0) return [];
  const target = Math.max(0, Math.floor(newTotal));
  if (services.length === 1) {
    return [{ serviceId: services[0].serviceId, plannedDurationMinutes: target }];
  }
  if (target === 0) {
    return services.map(s => ({ serviceId: s.serviceId, plannedDurationMinutes: 0 }));
  }

  const minPerLine = target >= services.length ? 1 : 0;
  const oldTotal = services.reduce((sum, s) => sum + Math.max(0, s.plannedDurationMinutes), 0);

  const scaled: ServiceLineDuration[] = oldTotal === 0
    ? services.map((s) => ({ serviceId: s.serviceId, plannedDurationMinutes: Math.floor(target / services.length) }))
    : services.map((s) => ({
        serviceId: s.serviceId,
        plannedDurationMinutes: Math.max(
          minPerLine,
          Math.round((Math.max(0, s.plannedDurationMinutes) / oldTotal) * target),
        ),
      }));

  // Differenz zwischen Soll-Summe und Ist-Summe auf die größte Zeile buchen.
  let largestIdx = 0;
  for (let i = 1; i < scaled.length; i++) {
    if (scaled[i].plannedDurationMinutes > scaled[largestIdx].plannedDurationMinutes) largestIdx = i;
  }
  const currentSum = scaled.reduce((sum, s) => sum + s.plannedDurationMinutes, 0);
  scaled[largestIdx].plannedDurationMinutes += target - currentSum;

  // Sollte die größte Zeile dadurch unter den Mindestwert fallen, gleichen
  // wir iterativ aus den größten anderen Zeilen aus, ohne einen negativen
  // Wert entstehen zu lassen.
  while (scaled[largestIdx].plannedDurationMinutes < minPerLine) {
    const deficit = minPerLine - scaled[largestIdx].plannedDurationMinutes;
    let donorIdx = -1;
    for (let i = 0; i < scaled.length; i++) {
      if (i === largestIdx) continue;
      if (scaled[i].plannedDurationMinutes > minPerLine) {
        if (donorIdx === -1 || scaled[i].plannedDurationMinutes > scaled[donorIdx].plannedDurationMinutes) {
          donorIdx = i;
        }
      }
    }
    if (donorIdx === -1) break;
    const take = Math.min(deficit, scaled[donorIdx].plannedDurationMinutes - minPerLine);
    if (take <= 0) break;
    scaled[donorIdx].plannedDurationMinutes -= take;
    scaled[largestIdx].plannedDurationMinutes += take;
  }
  if (scaled[largestIdx].plannedDurationMinutes < 0) scaled[largestIdx].plannedDurationMinutes = 0;
  return scaled;
}

/**
 * Hält `appointments.duration_promised` und die Summe der
 * `appointment_services.planned_duration_minutes` konsistent. Aufrufkontext:
 *
 * - Wird ein neues `services`-Array übergeben → Zeilen werden ersetzt und
 *   `durationPromised` ergibt sich aus deren Summe.
 * - Wird nur eine neue `durationPromised` übergeben → bestehende Service-Zeilen
 *   werden auf die neue Gesamtdauer skaliert.
 * - Werden beide übergeben und passen die Summen nicht zusammen → 400.
 *
 * Gibt die effektive `durationPromised` zurück (oder `null`, wenn weder
 * Dauer noch Services geändert wurden — Caller muss dann nichts updaten).
 */
export async function syncAppointmentServicesAndDuration(
  appointmentId: number,
  input: { durationPromised?: number | null; services?: ServiceLineDuration[] },
  tx: DbOrTx = db,
): Promise<{ effectiveDurationPromised: number | null }> {
  const { appointmentServices } = await import("@shared/schema");

  const hasServices = Array.isArray(input.services);
  const hasDuration = input.durationPromised != null;

  if (hasServices && hasDuration) {
    const sum = input.services!.reduce((s, sv) => s + sv.plannedDurationMinutes, 0);
    if (sum !== input.durationPromised) {
      throw badRequest(
        `Die geplante Termin-Dauer (${input.durationPromised} Min) weicht von der Summe der Service-Minuten (${sum} Min) ab. Bitte beide Werte konsistent setzen oder nur einen Wert ändern.`,
      );
    }
  }

  if (hasServices) {
    const services = input.services!;
    await tx.delete(appointmentServices).where(eq(appointmentServices.appointmentId, appointmentId));
    if (services.length > 0) {
      await tx.insert(appointmentServices).values(services.map((s) => ({
        appointmentId,
        serviceId: s.serviceId,
        plannedDurationMinutes: s.plannedDurationMinutes,
      })));
    }
    const total = services.reduce((s, sv) => s + sv.plannedDurationMinutes, 0);
    return { effectiveDurationPromised: total };
  }

  if (hasDuration) {
    const existing = await tx
      .select({
        serviceId: appointmentServices.serviceId,
        plannedDurationMinutes: appointmentServices.plannedDurationMinutes,
      })
      .from(appointmentServices)
      .where(eq(appointmentServices.appointmentId, appointmentId));

    if (existing.length > 0) {
      const currentSum = existing.reduce((s, sv) => s + sv.plannedDurationMinutes, 0);
      if (currentSum !== input.durationPromised) {
        const scaled = scaleServiceDurations(existing, input.durationPromised!);
        await tx.delete(appointmentServices).where(eq(appointmentServices.appointmentId, appointmentId));
        await tx.insert(appointmentServices).values(scaled.map((s) => ({
          appointmentId,
          serviceId: s.serviceId,
          plannedDurationMinutes: s.plannedDurationMinutes,
        })));
      }
    }
    return { effectiveDurationPromised: input.durationPromised! };
  }

  return { effectiveDurationPromised: null };
}

/**
 * Minimal storage interface for AppointmentService
 * This allows for easier testing by injecting mock implementations
 */
export interface IAppointmentStorage {
  getAppointmentsByDate(date: string): Promise<Appointment[]>;
}

interface OverlapCheckResult {
  hasOverlap: boolean;
  hasUnreliableData: boolean;
  unreliableAppointmentId?: number;
}

interface ValidationResult {
  valid: boolean;
  error?: string;
  message?: string;
}

interface DocumentationServiceEntry {
  serviceId: number;
  actualDurationMinutes: number;
  details?: string | null;
  serviceCode?: string | null;
}

interface DocumentationInput {
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

interface DocumentationResult {
  updateData: Record<string, unknown>;
  totalDurationMinutes: number;
  hauswirtschaftMinutes: number;
  alltagsbegleitungMinutes: number;
  travelKilometers: number;
  customerKilometers: number;
  hasUsage: boolean;
  serviceUpdates?: DocumentationServiceEntry[];
}

interface KundenterminInput {
  customerId: number;
  date: string;
  scheduledStart: string;
  services: Array<{ serviceId: number; durationMinutes: number; serviceCode?: string | null }>;
  notes?: string;
  assignedEmployeeId?: number | null;
  isFahrtdienst?: boolean;
  doctorName?: string;
  doctorAppointmentTime?: string;
  doctorStrasse?: string;
  doctorNr?: string;
  doctorPlz?: string;
  doctorStadt?: string;
  doctorLatitude?: number;
  doctorLongitude?: number;
  estimatedTravelMinutes?: number;
  travelBufferMinutes?: number;
}

class AppointmentService {
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
    employeeId: number,
    excludeId?: number
  ): Promise<OverlapCheckResult> {
    const existingAppointments = await this.storage.getAppointmentsByDate(date);
    
    for (const apt of existingAppointments) {
      if (excludeId && apt.id === excludeId) continue;
      if (apt.assignedEmployeeId !== employeeId) continue;
      
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

  async checkCustomerOverlap(
    date: string,
    startTime: string,
    endTime: string,
    customerId: number | null,
    excludeId?: number
  ): Promise<boolean> {
    // Defensive Schicht: Erstberatungen haben customerId = null (sie hängen an
    // prospectId). Würde der Aufrufer hier null durchreichen, würde die Skip-
    // Bedingung `apt.customerId !== customerId` zu `null !== null` = false
    // werden und alle anderen prospect-basierten Termine fälschlich als
    // "selber Kunde" werten. Daher hier hart abbrechen.
    if (customerId == null) return false;

    const existingAppointments = await this.storage.getAppointmentsByDate(date);

    for (const apt of existingAppointments) {
      if (excludeId && apt.id === excludeId) continue;
      if (apt.customerId !== customerId) continue;
      if (apt.status === "cancelled") continue;

      if (apt.status === "completed") {
        if (apt.actualEnd) {
          const actualStart = apt.actualStart
            ? this.formatTimeForDisplay(apt.actualStart)
            : apt.scheduledStart;
          const actualEnd = this.formatTimeForDisplay(apt.actualEnd);
          if (doTimesOverlap(startTime, endTime, actualStart, actualEnd)) {
            return true;
          }
        }
        continue;
      }

      const aptEndTime = apt.scheduledEnd || (apt.durationPromised ? addMinutesToTime(apt.scheduledStart, apt.durationPromised) : null);
      if (aptEndTime && doTimesOverlap(startTime, endTime, apt.scheduledStart, aptEndTime)) {
        return true;
      }
    }

    return false;
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
      updates.durationPromised !== undefined;
    
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
      isFahrtdienst: input.isFahrtdienst ?? false,
      doctorName: input.doctorName ?? null,
      doctorAppointmentTime: input.doctorAppointmentTime ?? null,
      doctorStrasse: input.doctorStrasse ?? null,
      doctorNr: input.doctorNr ?? null,
      doctorPlz: input.doctorPlz ?? null,
      doctorStadt: input.doctorStadt ?? null,
      doctorLatitude: input.doctorLatitude ?? null,
      doctorLongitude: input.doctorLongitude ?? null,
      estimatedTravelMinutes: input.estimatedTravelMinutes ?? null,
      travelBufferMinutes: input.travelBufferMinutes ?? null,
    };
    
    const serviceEntries = input.services.map(s => ({
      serviceId: s.serviceId,
      plannedDurationMinutes: s.durationMinutes,
    }));
    
    return { appointmentData, scheduledEnd, totalDuration, serviceEntries };
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
