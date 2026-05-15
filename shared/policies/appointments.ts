/**
 * Zentrale Berechtigungs-Policy für Termine.
 *
 * Pure Functions — keine I/O, keine DB-Zugriffe, keine Imports aus `server/`.
 * Aufrufer reichen alle benötigten Felder explizit als Inputs hinein. Damit
 * können Frontend (Sichtbarkeit/Disabled-State) und Backend (Route-Enforcement)
 * exakt dieselben Entscheidungen treffen.
 *
 * Jede `can…`-Funktion liefert `{ allowed, reason }` zurück; der Reason-String
 * wird im Backend als 403-Message und im Frontend als Tooltip wiederverwendet.
 */

import type { AppointmentStatus } from "../domain/appointments";

// ============================================
// TYPEN
// ============================================

/** Rolle des handelnden Users — flach, frei von DB-Strukturen. */
export interface PolicyUser {
  id: number;
  isAdmin: boolean;
  isSuperAdmin: boolean;
  isTeamLead: boolean;
  isActive: boolean;
  /** Rollen-Kürzel für rollenspezifische Erstellung (z. B. "erstberatung"). */
  roles?: readonly string[];
}

/** Termin-Snapshot, wie er für Policy-Entscheidungen reicht. */
export interface PolicyAppointment {
  assignedEmployeeId: number | null;
  performedByEmployeeId: number | null;
  customerId: number | null;
  prospectId?: number | null;
  status: AppointmentStatus;
  date: string;
  appointmentType?: string | null;
  /** Bereits gestartet (actualStart oder Status != scheduled). */
  isStarted: boolean;
  /** Termin gehört zu einem unterschriebenen Leistungsnachweis. */
  isLocked: boolean;
  /** Monat des Termins ist für den durchführenden Mitarbeiter abgeschlossen. */
  isMonthClosed: boolean;
  /** Termin trägt eine Kundenunterschrift. */
  hasSignature: boolean;
}

/** Beziehung des Users zu Kunde/Termin (vom Caller vorberechnet). */
export interface PolicyRelation {
  /** User ist dem Kunden des Termins als Primary/Backup zugeordnet. */
  isAssignedToCustomer?: boolean;
}

/** Eingaben für `canCreateAppointment`. */
export interface CreateAppointmentInput {
  date: string;
  isWeekend: boolean;
  isHoliday: boolean;
  /** Liegt mehr als 3 Monate in der Vergangenheit. */
  isFarPast: boolean;
  /** Monat ist für den vorgesehenen Mitarbeiter bereits abgeschlossen. */
  isMonthClosed: boolean;
  appointmentType: "Kundentermin" | "Erstberatung";
  /** Optional: ist user dem Kunden zugeordnet (für Nicht-Admin/-TL-Pfad). */
  isAssignedToCustomer?: boolean;
  /** Soll der User für einen anderen Mitarbeiter anlegen? */
  forOtherEmployee?: boolean;
}

export type PolicyDecision =
  | { allowed: true; reason?: undefined }
  | { allowed: false; reason: string };

const ALLOW: PolicyDecision = { allowed: true };
const deny = (reason: string): PolicyDecision => ({ allowed: false, reason });

// ============================================
// HELPER
// ============================================

function isAdminLike(user: PolicyUser): boolean {
  return user.isAdmin || user.isSuperAdmin;
}

function hasFirmenweiteSicht(user: PolicyUser): boolean {
  return isAdminLike(user) || (user.isTeamLead && user.isActive);
}

function isAssignedEmployee(user: PolicyUser, appt: PolicyAppointment): boolean {
  return appt.assignedEmployeeId === user.id || appt.performedByEmployeeId === user.id;
}

// ============================================
// POLICIES — VIEW
// ============================================

/**
 * Sehen / Lesen eines einzelnen Termins.
 * - Admins und Teamleitungen: firmenweit
 * - Zugewiesener / durchführender Mitarbeiter: ja
 * - Mitarbeiter, der dem Kunden als Primary/Backup zugeordnet ist: ja
 * - Sonst: nein
 */
export function canViewAppointment(
  user: PolicyUser,
  appt: PolicyAppointment,
  relation: PolicyRelation = {},
): PolicyDecision {
  if (!user.isActive) return deny("Ihr Konto ist deaktiviert.");
  if (hasFirmenweiteSicht(user)) return ALLOW;
  if (isAssignedEmployee(user, appt)) return ALLOW;
  if (relation.isAssignedToCustomer) return ALLOW;
  return deny("Sie haben keinen Zugriff auf diesen Termin.");
}

// ============================================
// POLICIES — CREATE
// ============================================

export function canCreateAppointment(
  user: PolicyUser,
  input: CreateAppointmentInput,
): PolicyDecision {
  if (!user.isActive) return deny("Ihr Konto ist deaktiviert.");

  if (input.isWeekend) {
    return deny("Termine können nicht an Samstagen oder Sonntagen erstellt werden.");
  }
  if (input.isHoliday) {
    return deny("Termine können nicht an Feiertagen erstellt werden.");
  }
  if (input.isFarPast && !isAdminLike(user)) {
    return deny("Termine können nicht mehr als 3 Monate in der Vergangenheit erstellt werden.");
  }
  if (input.isMonthClosed && !user.isSuperAdmin) {
    return deny("Der Monat ist bereits abgeschlossen. Neue Termine in diesem Zeitraum sind nur noch durch die Geschäftsführung möglich.");
  }

  if (input.appointmentType === "Erstberatung") {
    if (isAdminLike(user) || (user.isTeamLead && user.isActive)) return ALLOW;
    if (user.roles?.includes("erstberatung")) return ALLOW;
    return deny("Nur Erstberater dürfen Erstberatungen anlegen.");
  }

  // Kundentermin
  if (isAdminLike(user) || (user.isTeamLead && user.isActive)) return ALLOW;
  if (input.forOtherEmployee) {
    return deny("Nur Admins oder Teamleitungen dürfen Termine im Namen anderer Mitarbeiter anlegen.");
  }
  if (input.isAssignedToCustomer === false) {
    return deny("Sie sind diesem Kunden nicht zugeordnet und können keine Termine erstellen.");
  }
  if (
    !user.roles?.includes("hauswirtschaft")
    && !user.roles?.includes("alltagsbegleitung")
  ) {
    return deny("Sie haben keine Rolle, die Kundentermine anlegen darf.");
  }
  return ALLOW;
}

// ============================================
// POLICIES — EDIT (PATCH / Reassign)
// ============================================

/**
 * Termin bearbeiten (Datum, Zeit, Mitarbeiter-Reassign, Notizen, Services).
 * `notesOnly = true` ⇒ nur das Notizen-Feld wird geändert (lockerer).
 */
export function canEditAppointment(
  user: PolicyUser,
  appt: PolicyAppointment,
  options: { notesOnly?: boolean } = {},
): PolicyDecision {
  if (!user.isActive) return deny("Ihr Konto ist deaktiviert.");

  // Wer-Frage: Admin/TL firmenweit, sonst nur zugewiesen
  if (!hasFirmenweiteSicht(user) && !isAssignedEmployee(user, appt)) {
    return deny("Nur der zugewiesene Mitarbeiter darf diesen Termin bearbeiten.");
  }

  // Lock: gesperrter Termin → nur Notizen, sonst 409/Forbidden
  if (appt.isLocked && !options.notesOnly) {
    return deny("Dieser Termin ist Teil eines unterschriebenen Leistungsnachweises. Geschützte Felder können nicht mehr geändert werden — bitte stornieren Sie die zugehörige Rechnung.");
  }

  // Monatsabschluss: nur Superadmin darf darüber hinweg
  if (appt.isMonthClosed && !user.isSuperAdmin) {
    return deny("Der Monat ist bereits abgeschlossen. Termin-Änderungen sind nur noch durch die Geschäftsführung möglich.");
  }

  return ALLOW;
}

// ============================================
// POLICIES — DELETE
// ============================================

export function canDeleteAppointment(
  user: PolicyUser,
  appt: PolicyAppointment,
): PolicyDecision {
  if (!user.isActive) return deny("Ihr Konto ist deaktiviert.");

  const adminLike = isAdminLike(user);
  const lead = user.isTeamLead && user.isActive;

  if (!adminLike) {
    if (lead) {
      if (appt.isStarted) {
        return deny("Bereits gestartete oder abgeschlossene Termine können nicht mehr gelöscht werden.");
      }
    } else if (!isAssignedEmployee(user, appt)) {
      return deny("Nur der zugewiesene Mitarbeiter darf diesen Termin bearbeiten.");
    }
  }

  // Monatsabschluss
  if (appt.isMonthClosed && !user.isSuperAdmin) {
    return deny("Der Monat ist bereits abgeschlossen. Termin-Löschungen sind nur noch durch die Geschäftsführung möglich.");
  }

  // Lock: nur Admins dürfen gesperrte Termine löschen (mit Budget-Reverse)
  if (appt.isLocked && !adminLike) {
    return deny("Dieser Termin ist Teil eines unterschriebenen Leistungsnachweises und kann nicht gelöscht werden.");
  }

  // Mitarbeiter dürfen abgeschlossene Termine nicht löschen
  if (!adminLike && (appt.status === "completed" || appt.status === "cancelled")) {
    return deny("Abgeschlossene oder stornierte Termine können nicht mehr gelöscht werden.");
  }

  return ALLOW;
}

// ============================================
// POLICIES — DOCUMENT (start / end / document / sign)
// ============================================

/**
 * Termin starten, beenden, dokumentieren oder unterschreiben.
 * Nur der zugewiesene/durchführende Mitarbeiter (oder Admin im Notfall).
 * Teamleiter dokumentieren NICHT für andere — das wäre Beweis-Vortäuschung.
 */
export function canDocumentAppointment(
  user: PolicyUser,
  appt: PolicyAppointment,
): PolicyDecision {
  if (!user.isActive) return deny("Ihr Konto ist deaktiviert.");

  if (!isAdminLike(user) && !isAssignedEmployee(user, appt)) {
    return deny("Nur der zugewiesene Mitarbeiter darf diesen Termin dokumentieren.");
  }

  if (appt.isLocked) {
    return deny("Dieser Termin ist Teil eines unterschriebenen Leistungsnachweises und kann nicht mehr bearbeitet werden.");
  }

  if (appt.isMonthClosed && !user.isSuperAdmin) {
    return deny("Der Monat ist bereits abgeschlossen. Termin-Änderungen sind nur noch durch die Geschäftsführung möglich.");
  }

  if (appt.status === "completed") {
    return deny("Der Termin ist bereits abgeschlossen.");
  }
  if (appt.status === "customer_no_show") {
    return deny("Der Termin wurde als Kunden-No-Show dokumentiert und kann nicht mehr regulär dokumentiert werden.");
  }
  if (appt.status === "cancelled" || appt.status === "expired_unsigned") {
    return deny("Stornierte oder abgelaufene Termine können nicht dokumentiert werden.");
  }

  return ALLOW;
}

// ============================================
// POLICIES — REOPEN (Dokumentation korrigieren)
// ============================================

export function canReopenAppointment(
  user: PolicyUser,
  appt: PolicyAppointment,
): PolicyDecision {
  if (!user.isActive) return deny("Ihr Konto ist deaktiviert.");

  if (!isAdminLike(user) && !isAssignedEmployee(user, appt)) {
    return deny("Nur der zugewiesene Mitarbeiter darf diesen Termin wiedereröffnen.");
  }
  if (appt.status !== "completed") {
    return deny("Nur abgeschlossene Termine können zur Korrektur geöffnet werden.");
  }
  if (appt.isLocked) {
    return deny("Dieser Termin ist Teil eines unterschriebenen Leistungsnachweises und kann nicht mehr bearbeitet werden.");
  }
  if (appt.isMonthClosed && !user.isSuperAdmin) {
    return deny("Der Monat ist bereits abgeschlossen. Änderungen sind nur noch durch die Geschäftsführung möglich.");
  }
  return ALLOW;
}

// ============================================
// POLICIES — MONTH-CLOSE OVERRIDE
// ============================================

/**
 * Wer darf einen Termin in einem bereits geschlossenen Monat
 * anlegen / ändern / löschen / wiedereröffnen?
 * Antwort: ausschließlich Superadmin.
 */
export function canOverrideClosedMonth(user: PolicyUser): PolicyDecision {
  if (!user.isActive) return deny("Ihr Konto ist deaktiviert.");
  if (user.isSuperAdmin) return ALLOW;
  return deny("Nur die Geschäftsführung darf in einem geschlossenen Monat handeln.");
}

// ============================================
// AKTIONEN-ENUMERATION (für Matrix-Test und Doku-Generator)
// ============================================

export const APPOINTMENT_ACTIONS = [
  "view",
  "create",
  "edit",
  "delete",
  "document",
  "reopen",
  "overrideClosedMonth",
] as const;
export type AppointmentAction = typeof APPOINTMENT_ACTIONS[number];
