import type { AppointmentWithCustomer } from "@shared/types";
import {
  STATUS_PRIORITY,
  getEndTime as sharedGetEndTime,
} from "@shared/types";

export { formatTimeSlot } from "@shared/types";

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

export function getEndTime(appointment: AppointmentWithCustomer): string {
  return sharedGetEndTime(
    appointment.scheduledStart,
    appointment.scheduledEnd,
    appointment.durationPromised
  );
}

export interface ShouldResetFahrtdienstInput {
  /**
   * `true`, sobald der Servicekatalog (`/api/services`) erfolgreich geladen
   * wurde. Solange er noch nicht da ist, kann nicht zuverlässig erkannt
   * werden, ob ein Service zur Kategorie "alltagsbegleitung" gehört – und
   * der Reset darf NICHT greifen, weil er sonst einen gespeicherten
   * Fahrtdienst-Block fälschlich verwirft.
   */
  catalogLoaded: boolean;
  hasAlltagsbegleitung: boolean;
  fahrtdienstEnabled: boolean;
  /**
   * Im Bearbeiten-Flow wird der Fahrtdienst-Zustand nachträglich aus dem
   * geladenen Termin übernommen. Erst danach darf der Reset zuschlagen.
   * Im Neu-Flow ist der Anfangszustand bekannt (immer disabled), daher der
   * Default `true`.
   */
  fahrtdienstInitialized?: boolean;
}

/**
 * Entscheidet, ob der Fahrtdienst-State auf "disabled" zurückgesetzt werden
 * soll. Schützt insbesondere beim Edit-Flow vor einer Race Condition, bei der
 * der Servicekatalog erst nach den Termin-Services eintrifft und dadurch
 * `hasAlltagsbegleitung` kurzzeitig fälschlich `false` wäre.
 */
export function shouldResetFahrtdienst({
  catalogLoaded,
  hasAlltagsbegleitung,
  fahrtdienstEnabled,
  fahrtdienstInitialized = true,
}: ShouldResetFahrtdienstInput): boolean {
  if (!catalogLoaded) return false;
  if (!fahrtdienstInitialized) return false;
  return !hasAlltagsbegleitung && fahrtdienstEnabled;
}
