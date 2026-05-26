import { addMinutesToTime } from "@shared/utils/datetime";

// Drift-sicherer Diff-Helper für den Erstberatungs-Editor.
// Wir vergleichen `time`/`duration` bewusst gegen die Werte, mit denen das
// Formular initial befüllt wurde — NICHT gegen `appointment.durationPromised`
// aus der DB. Bei bereits gestarteten Terminen kann `scheduledEnd - scheduledStart`
// von `durationPromised` abweichen (z. B. weil nur eine Seite aktualisiert wurde).
// Würden wir die Mount-Dauer (`scheduledEnd - scheduledStart`) gegen
// `durationPromised` vergleichen, wäre `durationChanged` ohne Nutzereingriff
// `true`, und ein reiner Notes-Save würde `scheduledEnd` + `durationPromised`
// mitsenden. Der Server-Guard `validateSchedulingChanges` lehnt das auf
// nicht-`scheduled` Terminen mit 403 ab — genau der Bug aus Task #595.
export interface ErstberatungDiffInput {
  originalDate: string;
  originalNotes: string | null;
  originalAssignedEmployeeId: number | null;
  // Snapshots der initialen Form-Werte (gesetzt beim Mount des Formulars).
  // Diese definieren die "unverändert"-Baseline für time und duration.
  initialTime: string; // HH:MM
  initialDuration: number; // Minuten
  // Aktuelle Form-Werte.
  date: string;
  time: string;
  duration: number;
  notes: string;
  assignedEmployeeId: string;
}

export function computeErstberatungUpdateFields(
  input: ErstberatungDiffInput,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};

  if (input.date !== input.originalDate) fields.date = input.date;

  const timeChanged = input.time !== input.initialTime;
  const durationChanged = input.duration !== input.initialDuration;

  if (timeChanged) fields.scheduledStart = input.time;
  if (timeChanged || durationChanged) {
    fields.scheduledEnd = addMinutesToTime(input.time, input.duration);
  }
  if (durationChanged) fields.durationPromised = input.duration;

  if ((input.notes || null) !== (input.originalNotes || null)) {
    fields.notes = input.notes || null;
  }

  if (input.assignedEmployeeId) {
    const newEmpId = parseInt(input.assignedEmployeeId);
    if (!Number.isNaN(newEmpId) && newEmpId !== input.originalAssignedEmployeeId) {
      fields.assignedEmployeeId = newEmpId;
    }
  }

  return fields;
}
