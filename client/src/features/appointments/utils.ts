import type { AppointmentWithCustomer } from "@shared/types";

export function sortAppointmentsByPriority(appointments: AppointmentWithCustomer[]): AppointmentWithCustomer[] {
  return [...appointments].sort((a, b) => {
    // In-progress first
    if (a.status === "in-progress" && b.status !== "in-progress") return -1;
    if (b.status === "in-progress" && a.status !== "in-progress") return 1;
    
    // Then documenting
    if (a.status === "documenting" && b.status !== "documenting") return -1;
    if (b.status === "documenting" && a.status !== "documenting") return 1;
    
    // Completed appointments go to bottom
    if (a.status === "completed" && b.status !== "completed") return 1;
    if (b.status === "completed" && a.status !== "completed") return -1;
    
    // Then by time
    return a.scheduledStart.localeCompare(b.scheduledStart);
  });
}

export function getStatusColor(status: string): string {
  const colors: Record<string, string> = {
    "scheduled": "bg-muted text-muted-foreground border-muted-foreground/20",
    "in-progress": "bg-blue-50 text-blue-700 border-blue-200 animate-pulse",
    "documenting": "bg-orange-50 text-orange-700 border-orange-200",
    "completed": "bg-green-50 text-green-700 border-green-200"
  };
  return colors[status] || colors.scheduled;
}

export function getAppointmentTypeColor(appointmentType: string): string {
  if (appointmentType === "Erstberatung") {
    return "bg-purple-100 text-purple-800 border-purple-200";
  }
  // Kundentermin
  return "bg-teal-100 text-teal-800 border-teal-200";
}

export function getServiceColor(serviceType: string | null): string {
  if (serviceType === "Hauswirtschaft") {
    return "bg-amber-50 text-amber-700 border-amber-200";
  }
  if (serviceType === "Alltagsbegleitung") {
    return "bg-sky-50 text-sky-700 border-sky-200";
  }
  return "bg-gray-100 text-gray-600 border-gray-200";
}

export function getStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    "scheduled": "Geplant",
    "in-progress": "Läuft",
    "documenting": "Dokumentation",
    "completed": "Abgeschlossen"
  };
  return labels[status] || status;
}

export function calculateDuration(startTime: Date | null, endTime: Date | null): number | null {
  if (!startTime || !endTime) return null;
  return Math.round((endTime.getTime() - startTime.getTime()) / 60000);
}

export function formatTime(date: Date | null): string {
  if (!date) return "--:--";
  return date.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
}

export function formatTimeSlot(time: string | null): string {
  if (!time) return "--:--";
  return time.slice(0, 5);
}

export function getEndTime(appointment: AppointmentWithCustomer): string {
  if (appointment.scheduledEnd) {
    return formatTimeSlot(appointment.scheduledEnd);
  }
  if (appointment.scheduledStart && appointment.durationPromised) {
    const [hours, mins] = appointment.scheduledStart.split(":").map(Number);
    const totalMins = hours * 60 + mins + appointment.durationPromised;
    const endHours = Math.floor(totalMins / 60) % 24;
    const endMins = totalMins % 60;
    return `${endHours.toString().padStart(2, "0")}:${endMins.toString().padStart(2, "0")}`;
  }
  return "--:--";
}
