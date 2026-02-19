import type { AppointmentWithCustomer } from "@shared/types";
import {
  STATUS_PRIORITY,
  getEndTime as sharedGetEndTime,
} from "@shared/types";

export {
  getStatusColor,
  getAppointmentTypeColor,
  getServiceColor,
  getStatusLabel,
  formatTimeSlot,
} from "@shared/types";

export function sortAppointmentsByPriority(appointments: AppointmentWithCustomer[]): AppointmentWithCustomer[] {
  return [...appointments].sort((a, b) => {
    const priorityA = STATUS_PRIORITY[a.status as keyof typeof STATUS_PRIORITY] ?? 2;
    const priorityB = STATUS_PRIORITY[b.status as keyof typeof STATUS_PRIORITY] ?? 2;
    
    if (priorityA !== priorityB) {
      return priorityA - priorityB;
    }
    
    return a.scheduledStart.localeCompare(b.scheduledStart);
  });
}

export function calculateDuration(startTime: Date | null, endTime: Date | null): number | null {
  if (!startTime || !endTime) return null;
  return Math.round((endTime.getTime() - startTime.getTime()) / 60000);
}

export function getEndTime(appointment: AppointmentWithCustomer): string {
  return sharedGetEndTime(
    appointment.scheduledStart,
    appointment.scheduledEnd,
    appointment.durationPromised
  );
}
