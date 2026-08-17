/**
 * Adapter DB → Policy-Eingaben, SSoT.
 *
 * Lag bis hierher lokal in `server/routes/appointments.ts`. Der Gate-2-Review
 * zu PR #100 fand die erste Kopie: `appointment-cancellation.ts` hatte den
 * Adapter nachgebaut und dabei `isStarted` ABWEICHEND definiert
 * (`status !== "scheduled"` statt `status === "documenting"`). Konkrete Folge:
 * ein `customer_no_show`-Termin ohne `actualStart` galt für den Löschpfad als
 * nicht gestartet, für den Absagepfad als gestartet — und der
 * Teamleitungs-Zweig in `canDeleteAppointment`/`canCancelAppointment` gab für
 * denselben Termin verschiedene Antworten.
 *
 * Zwei Adapter für dieselbe Übersetzung sind derselbe Fehler wie zwei
 * Guard-Sets für dieselbe Frage — genau das, was dieser PR beseitigt. Deshalb
 * hier, mit beiden Aufrufern.
 */
import { and, eq, isNull } from "drizzle-orm";
import { appointments } from "@shared/schema";
import { storage } from "../storage";
import { timeTrackingStorage } from "../storage/time-tracking";
import { appointmentsRepo } from "../repos";
import type { Tx } from "./db";
import type { PolicyUser, PolicyAppointment } from "@shared/policies/appointments";
import type { AppointmentStatus } from "@shared/domain/appointments";

/**
 * Adapter: Express-User → PolicyUser.
 * Admin/SuperAdmin sind absichtlich KEINE Teamleitungen (vgl. server/lib/team-lead.ts).
 */
export function toPolicyUser(user: {
  id: number;
  isAdmin: boolean;
  isSuperAdmin?: boolean | null;
  isTeamLead?: boolean | null;
  isActive?: boolean | null;
  isAnonymized?: boolean | null;
  roles?: readonly string[];
}): PolicyUser {
  const adminLike = !!user.isAdmin || !!user.isSuperAdmin;
  return {
    id: user.id,
    isAdmin: !!user.isAdmin,
    isSuperAdmin: !!user.isSuperAdmin,
    isTeamLead: !adminLike && !user.isAnonymized && !!user.isTeamLead,
    isActive: user.isActive !== false,
    roles: user.roles ?? [],
  };
}

/** Adapter: DB-Termin → PolicyAppointment. */
export function toPolicyAppointment(
  appt: {
    assignedEmployeeId: number | null;
    performedByEmployeeId: number | null;
    customerId: number | null;
    prospectId?: number | null;
    status: string;
    date: string;
    appointmentType?: string | null;
    actualStart?: string | null;
    actualEnd?: string | null;
    signatureData?: string | null;
  },
  flags: { isLocked: boolean; isMonthClosed: boolean },
): PolicyAppointment {
  const status = appt.status as AppointmentStatus;
  const isStarted = !!appt.actualStart || !!appt.actualEnd || status === "documenting";
  return {
    assignedEmployeeId: appt.assignedEmployeeId,
    performedByEmployeeId: appt.performedByEmployeeId,
    customerId: appt.customerId,
    prospectId: appt.prospectId ?? null,
    status,
    date: appt.date,
    appointmentType: appt.appointmentType ?? null,
    isStarted,
    isLocked: flags.isLocked,
    isMonthClosed: flags.isMonthClosed,
    hasSignature: !!appt.signatureData,
  };
}

export async function loadPolicyFlags(appointmentId: number, appt: { date: string; assignedEmployeeId: number | null; performedByEmployeeId: number | null }): Promise<{ isLocked: boolean; isMonthClosed: boolean }> {
  const isLocked = await storage.isAppointmentLocked(appointmentId);
  let isMonthClosed = false;
  const employeeId = appt.assignedEmployeeId || appt.performedByEmployeeId;
  if (employeeId && appt.date) {
    isMonthClosed = await timeTrackingStorage.isMonthClosed(employeeId, appt.date);
  }
  return { isLocked, isMonthClosed };
}

/**
 * Lädt Termin + Policy-Eingaben in einem Zug — die Entscheidungsgrundlage für
 * jeden Pfad, der eine Appointment-Policy fragt.
 *
 * `tx` gesetzt = Lesen UNTER dem FOR-UPDATE der laufenden Transaktion. Genau
 * dafür gibt es den Parameter: Absage und Zurückholen werten die Policy nach
 * dem Row-Lock ERNEUT aus, weil sie sie vorher außerhalb der Transaktion
 * ausgewertet haben.
 *
 * Lag bis hierher privat in `appointment-cancellation.ts`. Beim Bau des
 * Undo-Pfads wäre die zweite Kopie entstanden — dieselbe Verdopplung, die der
 * Gate-2-Review an diesem Adapter schon einmal gefunden hat.
 */
export async function ladeEntscheidungsdaten(id: number, tx?: Tx) {
  // Ueber die Repo-Schicht, nicht per direktem `select` — der Soft-Delete-Filter
  // ist dort verankert und ein Architektur-Waechter erzwingt das
  // (`tests/architecture/soft-delete-coverage.test.ts`).
  const [appt] = tx
    ? await appointmentsRepo.selectFrom(tx).where(and(eq(appointments.id, id), isNull(appointments.deletedAt)))
    : [await storage.getAppointment(id)];
  if (!appt) return null;

  const flags = await loadPolicyFlags(id, appt);
  return { appt, policyAppt: toPolicyAppointment(appt, flags) };
}
