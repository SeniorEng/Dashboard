/**
 * Task #838 — Single source of truth für die "welchem Mitarbeiter gehört dieser
 * Termin?"-Regel.
 *
 * Hintergrund: Die Mitarbeiter-Eigensicht ("Meine Zeiten",
 * `getEmployeeAppointments`) und die Admin-Zeitübersicht
 * (`getAdminTimeTrackingOverview`) leiteten die Termin-zu-Mitarbeiter-Zuordnung
 * historisch unterschiedlich ab:
 *  - Eigensicht (SQL): abgeschlossene Termine über `performedByEmployeeId`,
 *    offene Termine über `assignedEmployeeId` bzw. — wenn nicht zugewiesen —
 *    über die Vertretungs-Kette des Kunden (Primär/Backup/Backup2).
 *  - Admin-Sicht: gruppierte stumpf nach `assignedEmployeeId` und warf NULL-
 *    Zuweisungen weg. Dadurch sah ein Admin für denselben Mitarbeiter andere
 *    (weniger) Termine/Stunden als der Mitarbeiter selbst — der lange offene
 *    #481-Verdacht.
 *
 * Diese Funktion kodiert die Eigensicht-Regel als reine Logik, damit beide
 * Pfade exakt dieselbe Zuordnung verwenden. Das SQL-Pendant
 * (`employeeVisibleAppointmentsFilter` + die `performedByEmployeeId`-Bedingung
 * in `getEmployeeAppointments`) wird per Equality-Test
 * (`tests/equality/admin-vs-employee-hours.test.ts`) gegen diese Funktion
 * abgesichert.
 */

export interface AppointmentAttributionInput {
  status: string;
  assignedEmployeeId: number | null;
  performedByEmployeeId: number | null;
}

export interface CustomerCoverage {
  primaryEmployeeId: number | null;
  backupEmployeeId: number | null;
  backupEmployeeId2: number | null;
}

/**
 * Liefert die Menge der Mitarbeiter-IDs, denen ein Termin zugerechnet wird —
 * deckungsgleich mit dem SQL-Filter der Mitarbeiter-Eigensicht
 * (`getEmployeeAppointments`):
 *
 *  - `status === 'completed'`: dem tatsächlich durchführenden Mitarbeiter
 *    (`performedByEmployeeId`). Fehlt dieser, wird der Termin niemandem
 *    zugerechnet (so wie er auch in keiner Eigensicht auftaucht).
 *  - sonst (offen/dokumentierend/no-show/...): dem zugewiesenen Mitarbeiter
 *    (`assignedEmployeeId`). Ist keiner zugewiesen, der Vertretungs-Kette des
 *    Kunden (Primär-, Backup- und Backup2-Mitarbeiter). Ohne Kunde/Coverage
 *    (z.B. Erstberatung mit Prospect) wird der Termin niemandem zugerechnet.
 *
 * Ein offener, nicht zugewiesener Termin kann mehreren Vertretern gleichzeitig
 * zugerechnet werden — exakt wie er in der Eigensicht jedem dieser Vertreter
 * angezeigt wird.
 */
export function attributeAppointmentToEmployees(
  appt: AppointmentAttributionInput,
  coverage: CustomerCoverage | null,
): number[] {
  if (appt.status === "completed") {
    return appt.performedByEmployeeId != null ? [appt.performedByEmployeeId] : [];
  }

  if (appt.assignedEmployeeId != null) {
    return [appt.assignedEmployeeId];
  }

  if (!coverage) return [];

  const ids: number[] = [];
  for (const id of [
    coverage.primaryEmployeeId,
    coverage.backupEmployeeId,
    coverage.backupEmployeeId2,
  ]) {
    if (id != null && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * Prädikat-Form derselben Regel: Gehört der Termin dem angegebenen
 * Mitarbeiter? Wird von Parity-Tests verwendet, um den SQL-Pfad
 * (`getEmployeeAppointments`) gegen die zentrale Logik zu spiegeln.
 */
export function appointmentBelongsToEmployee(
  appt: AppointmentAttributionInput,
  coverage: CustomerCoverage | null,
  userId: number,
): boolean {
  return attributeAppointmentToEmployees(appt, coverage).includes(userId);
}
