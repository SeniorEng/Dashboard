import type { AppointmentWithCustomer, AppointmentStatus } from "@shared/types";

export function sortAppointmentsByPriority(appointments: AppointmentWithCustomer[]): AppointmentWithCustomer[] {
  return [...appointments].sort((a, b) => {
    // In-progress first
    if (a.status === "in-progress" && b.status !== "in-progress") return -1;
    if (b.status === "in-progress" && a.status !== "in-progress") return 1;
    
    // Then documenting
    if (a.status === "documenting" && b.status !== "documenting") return -1;
    if (b.status === "documenting" && a.status !== "documenting") return 1;
    
    // Then by time
    return a.time.localeCompare(b.time);
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

export function getTypeColor(type: string): string {
  const colors: Record<string, string> = {
    "First Visit": "bg-purple-100 text-purple-800 border-purple-200",
    "Customer Appointment": "bg-teal-100 text-teal-800 border-teal-200",
    "Hauswirtschaft": "bg-amber-100 text-amber-800 border-amber-200",
    "Alltagsbegleitung": "bg-pink-100 text-pink-800 border-pink-200"
  };
  return colors[type] || "bg-gray-100 text-gray-800";
}

export function calculateDuration(startTime: Date | null, endTime: Date | null): number | null {
  if (!startTime || !endTime) return null;
  return Math.round((endTime.getTime() - startTime.getTime()) / 60000);
}

export function formatTime(date: Date | null): string {
  if (!date) return "--:--";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
