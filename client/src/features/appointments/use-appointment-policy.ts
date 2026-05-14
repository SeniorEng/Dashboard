import { useMemo } from "react";
import type { AppointmentWithCustomer } from "@shared/types";
import type { AppointmentStatus } from "@shared/domain/appointments";
import {
  canDeleteAppointment,
  canDocumentAppointment,
  canEditAppointment,
  canReopenAppointment,
  canViewAppointment,
  type PolicyAppointment,
  type PolicyDecision,
  type PolicyUser,
} from "@shared/policies/appointments";

interface CurrentUser {
  id: number;
  isAdmin?: boolean;
  isSuperAdmin?: boolean;
  isTeamLead?: boolean;
  isActive?: boolean;
  roles?: readonly string[];
}

function toPolicyUser(user: CurrentUser | null | undefined): PolicyUser {
  if (!user) {
    return { id: 0, isAdmin: false, isSuperAdmin: false, isTeamLead: false, isActive: false, roles: [] };
  }
  const adminLike = !!user.isAdmin || !!user.isSuperAdmin;
  return {
    id: user.id,
    isAdmin: !!user.isAdmin,
    isSuperAdmin: !!user.isSuperAdmin,
    isTeamLead: !adminLike && !!user.isTeamLead,
    isActive: user.isActive !== false,
    roles: user.roles ?? [],
  };
}

function toPolicyAppointment(appt: AppointmentWithCustomer): PolicyAppointment {
  const status = appt.status as AppointmentStatus;
  return {
    assignedEmployeeId: appt.assignedEmployeeId ?? null,
    performedByEmployeeId: appt.performedByEmployeeId ?? null,
    customerId: appt.customerId ?? null,
    prospectId: (appt as { prospectId?: number | null }).prospectId ?? null,
    status,
    date: appt.date,
    appointmentType: appt.appointmentType ?? null,
    isStarted: !!appt.actualStart || !!appt.actualEnd || status !== "scheduled",
    isLocked: !!appt.isLocked,
    isMonthClosed: !!appt.isMonthClosed,
    hasSignature: !!appt.signatureData,
  };
}

export interface AppointmentPolicy {
  view: PolicyDecision;
  edit: PolicyDecision;
  delete: PolicyDecision;
  document: PolicyDecision;
  reopen: PolicyDecision;
}

/**
 * Berechnet alle Termin-Berechtigungen aus Sicht des aktuellen Users.
 * Quelle: `shared/policies/appointments.ts` — identisch zu Backend.
 */
export interface AppointmentPolicyOptions {
  /**
   * Ist der aktuelle User dem Kunden des Termins als Primary/Backup zugeordnet?
   * Wirkt nur auf die `view`-Entscheidung. Wird nicht angegeben, gilt `false`
   * (wir nehmen die strengere Annahme — die Liste/Detail-Sicht zeigt den
   * Termin sowieso nur, wenn das Backend ihn bereits ausgeliefert hat).
   */
  isAssignedToCustomer?: boolean;
}

export function useAppointmentPolicy(
  user: CurrentUser | null | undefined,
  appointment: AppointmentWithCustomer | null | undefined,
  options: AppointmentPolicyOptions = {},
): AppointmentPolicy | null {
  const isAssignedToCustomer = options.isAssignedToCustomer ?? false;
  return useMemo(() => {
    if (!appointment) return null;
    const policyUser = toPolicyUser(user);
    const policyAppt = toPolicyAppointment(appointment);
    return {
      view: canViewAppointment(policyUser, policyAppt, { isAssignedToCustomer }),
      edit: canEditAppointment(policyUser, policyAppt),
      delete: canDeleteAppointment(policyUser, policyAppt),
      document: canDocumentAppointment(policyUser, policyAppt),
      reopen: canReopenAppointment(policyUser, policyAppt),
    };
  }, [user, appointment, isAssignedToCustomer]);
}
