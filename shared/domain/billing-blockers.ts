/**
 * Task #1462 — „Was hängt"-Blocker (Phase 4, Teil A), reine Domänenlogik.
 *
 * Komponiert AUSSCHLIESSLICH bestehende SSoTs (Lohn-/Doku-Readiness und den
 * Budget-Konservierungs-Check) zu genau ZWEI Blocker-Gruppen für die
 * Abrechnungsseite:
 *   1) Termine ohne/überfällige Doku
 *   2) Budget/§45b-Probleme
 *
 * Hier liegt nur die pure Auswahl-/Zähl-/Sortier-Logik (keine eigene
 * fachliche Berechnung, keine Mutation). Der Server-Reader füttert die rohen
 * SSoT-Ergebnisse hinein. Beträge sind durchgehend Integer-Cents.
 */
import { daysOverdue } from "./appointments";

/** Ein Termin gilt als >48 h überfällig dokumentiert (datums-basiert). */
export const OVERDUE_DOCUMENTATION_DAYS = 2;

/**
 * Übernimmt die bisherige Cockpit-SSoT (`isDocumentationOverdue48h`): ein Termin
 * gilt als >48 h überfällig, sobald sein Datum mindestens zwei Tage zurückliegt.
 */
export function isDocumentationOverdue48h(
  appointment: { date: string },
  now: Date = new Date(),
): boolean {
  return daysOverdue(appointment, now) >= OVERDUE_DOCUMENTATION_DAYS;
}

/** Ein offener/überfälliger Doku-Termin (Anzeige-Form). */
export interface DocumentationBlockerItem {
  appointmentId: number;
  customerName: string;
  employeeName: string;
  date: string;
  scheduledStart: string | null;
  status: string;
  daysOverdue: number;
  overdue: boolean;
}

/** Ein überzogener Budget-Topf eines im Zeitraum aktiven Kunden (Anzeige-Form). */
export interface BudgetBlockerItem {
  customerId: number;
  customerName: string;
  budgetType: string;
  allocatedCents: number;
  netConsumedCents: number;
  shortfallCents: number;
}

interface ReadinessAppointmentInput {
  id: number;
  date: string;
  scheduledStart: string | null;
  status: string;
  customerName: string;
}

interface ReadinessEmployeeInput {
  displayName: string | null;
  openAppointments: ReadinessAppointmentInput[];
  unsignedAppointments: ReadinessAppointmentInput[];
}

/**
 * Baut Gruppe 1 aus dem Readiness-SSoT: alle offenen UND fertiggestellt-aber-
 * unsignierten Termine des Monats, je Termin mit Mitarbeiter, Alter und
 * Überfälligkeits-Flag. Sortiert nach Alter (älteste zuerst), dann Datum/ID.
 */
export function buildDocumentationBlockers(
  employees: ReadinessEmployeeInput[],
  now: Date = new Date(),
): DocumentationBlockerItem[] {
  const items: DocumentationBlockerItem[] = [];
  for (const emp of employees) {
    const employeeName = emp.displayName ?? "Unbekannt";
    for (const appt of [...emp.openAppointments, ...emp.unsignedAppointments]) {
      const days = daysOverdue(appt, now);
      items.push({
        appointmentId: appt.id,
        customerName: appt.customerName,
        employeeName,
        date: appt.date,
        scheduledStart: appt.scheduledStart,
        status: appt.status,
        daysOverdue: days,
        overdue: days >= OVERDUE_DOCUMENTATION_DAYS,
      });
    }
  }
  return items.sort(
    (a, b) =>
      b.daysOverdue - a.daysOverdue ||
      a.date.localeCompare(b.date) ||
      a.appointmentId - b.appointmentId,
  );
}

interface PotConservationRowInput {
  customerId: number;
  budgetType: string;
  allocatedCents: number;
  netConsumedCents: number;
  overdrawn: boolean;
}

/**
 * Baut Gruppe 2 aus dem Konservierungs-SSoT: alle überzogenen Töpfe, deren
 * Kunde im gewählten Zeitraum mindestens einen Termin hat (Schnittmenge über
 * `customerNameById`). Sortiert nach Fehlbetrag (größter zuerst).
 */
export function selectBudgetBlockers(
  potRows: PotConservationRowInput[],
  customerNameById: Map<number, string>,
): BudgetBlockerItem[] {
  const items: BudgetBlockerItem[] = [];
  for (const row of potRows) {
    if (!row.overdrawn) continue;
    const customerName = customerNameById.get(row.customerId);
    if (customerName === undefined) continue;
    items.push({
      customerId: row.customerId,
      customerName,
      budgetType: row.budgetType,
      allocatedCents: row.allocatedCents,
      netConsumedCents: row.netConsumedCents,
      shortfallCents: row.netConsumedCents - row.allocatedCents,
    });
  }
  return items.sort(
    (a, b) =>
      b.shortfallCents - a.shortfallCents ||
      a.customerId - b.customerId ||
      a.budgetType.localeCompare(b.budgetType),
  );
}
