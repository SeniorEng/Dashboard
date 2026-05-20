import { Router } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { withDbRetry } from "../lib/db";
import { 
  updateAppointmentSchema, 
  insertKundenterminSchema,
  insertProspectErstberatungSchema,
  appointments,
  prospects,
} from "@shared/schema";
import { prospectStorage } from "../storage/prospects";
import { appointmentService, syncAppointmentServicesAndDuration } from "../services/appointments";
import { authService } from "../services/auth";
import { auditService } from "../services/audit";
import { serviceCatalogStorage } from "../storage/service-catalog";
import { getCachedCompanySettings } from "../services/cache";
import { suggestTravelOrigin } from "@shared/domain/appointments";
import { calculateRoute } from "../services/routing";
import { geocodeCustomer } from "../services/geocoding";
import { isWeekend, currentTimeHHMMSS, todayISO, parseLocalDate, timeToMinutes } from "@shared/utils/datetime";
import { timeRangesOverlap } from "@shared/domain/time-entries";
import { 
  ErrorMessages, 
  asyncHandler,
  sendBadRequest, 
  sendConflict, 
  sendForbidden, 
  sendNotFound,
  sendServerError
} from "../lib/errors";
import { requireAuth } from "../middleware/auth";
import { requireIntParam } from "../lib/params";
import { notificationService } from "../services/notification-service";
import { timeTrackingStorage } from "../storage/time-tracking";
import { budgetLedgerStorage } from "../storage/budget-ledger";
import { buildBudgetWarning } from "../lib/budget-warning";
import type { Response } from "express";
import type { CoverageCheckResponse } from "@shared/api";
import appointmentDocumentationRouter from "./appointment-documentation";
import { db } from "../lib/db";
import { customerManagementStorage } from "../storage/customer-management";
import { isTeamLead, actorRole } from "../lib/team-lead";
import { checkAndRecalcDailyAutoBreak } from "../services/auto-breaks";
import { addMinutesToTimeHHMMSS } from "@shared/utils/datetime";
import { customers, users, userRoles } from "@shared/schema";
import { customerContracts } from "@shared/schema/contracts";
import { customersRepo, appointmentsRepo } from "../repos";
import { eq, and, or, inArray, gte, lte, ne, isNull, sql } from "drizzle-orm";
import {
  canViewAppointment,
  canCreateAppointment as policyCanCreate,
  canEditAppointment as policyCanEdit,
  canDeleteAppointment as policyCanDelete,
  canDocumentAppointment as policyCanDocument,
  canReopenAppointment as policyCanReopen,
  type PolicyUser,
  type PolicyAppointment,
} from "@shared/policies/appointments";
import type { AppointmentStatus } from "@shared/domain/appointments";

const router = Router();

/**
 * Adapter: Express-User → PolicyUser.
 * Admin/SuperAdmin sind absichtlich KEINE Teamleitungen (vgl. server/lib/team-lead.ts).
 */
function toPolicyUser(user: {
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
function toPolicyAppointment(
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
  const isStarted = !!appt.actualStart || !!appt.actualEnd || status !== "scheduled";
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

export { toPolicyUser, toPolicyAppointment };

async function checkEmployeeBlocker(
  employeeId: number,
  date: string,
  startTime: string,
  endTime: string
): Promise<string | null> {
  const blockerEntries = await timeTrackingStorage.getTimeEntries(employeeId, { date });
  const blockers = blockerEntries.filter(e => e.entryType === "blocker" && !e.deletedAt);

  for (const blocker of blockers) {
    if (blocker.isFullDay) {
      return "Der Mitarbeiter hat an diesem Tag einen Blocker eingetragen und steht nicht zur Verfügung.";
    }
    if (blocker.startTime && blocker.endTime) {
      const blockerStart = timeToMinutes(blocker.startTime);
      const blockerEnd = timeToMinutes(blocker.endTime);
      const apptStart = timeToMinutes(startTime);
      const apptEnd = timeToMinutes(endTime);
      if (timeRangesOverlap(apptStart, apptEnd, blockerStart, blockerEnd)) {
        return `Der Mitarbeiter hat einen Blocker von ${blocker.startTime.slice(0, 5)} bis ${blocker.endTime.slice(0, 5)} Uhr eingetragen.`;
      }
    }
  }
  return null;
}

function isDateMoreThan3MonthsInPast(dateStr: string): boolean {
  const date = parseLocalDate(dateStr);
  const threeMonthsAgo = new Date();
  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
  threeMonthsAgo.setHours(0, 0, 0, 0);
  return date < threeMonthsAgo;
}

async function checkCustomerAccess(
  user: { id: number; isAdmin: boolean; isActive?: boolean; isTeamLead?: boolean; isSuperAdmin?: boolean; isAnonymized?: boolean; roles?: readonly string[] },
  customerId: number | null,
  res: Response,
  appointmentEmployeeIds?: { assignedEmployeeId?: number | null; performedByEmployeeId?: number | null }
): Promise<boolean> {
  // Sicht-Policy: shared/policies/appointments.canViewAppointment.
  // Hier zusätzlich der DB-Lookup für Kundenzuordnung (Policy bleibt pur).
  const policyUser = toPolicyUser(user);
  let isAssignedToCustomer = false;
  if (customerId !== null && !policyUser.isAdmin && !policyUser.isSuperAdmin && !policyUser.isTeamLead) {
    const assignedCustomerIds = await storage.getAssignedCustomerIds(user.id);
    isAssignedToCustomer = assignedCustomerIds.includes(customerId);
  }
  const decision = canViewAppointment(
    policyUser,
    {
      assignedEmployeeId: appointmentEmployeeIds?.assignedEmployeeId ?? null,
      performedByEmployeeId: appointmentEmployeeIds?.performedByEmployeeId ?? null,
      customerId,
      status: "scheduled",
      date: "1970-01-01",
      isStarted: false,
      isLocked: false,
      isMonthClosed: false,
      hasSignature: false,
    },
    { isAssignedToCustomer },
  );
  if (decision.allowed) return true;
  sendForbidden(res, "ACCESS_DENIED", decision.reason);
  return false;
}

/**
 * Schreibrecht für Termin-Mutationen, die nur dem durchführenden
 * Mitarbeiter (oder Admin) erlaubt sind: start/end/reopen/document.
 * Delegiert an `canDocumentAppointment` ohne Lock/Monatsabschluss-Flags
 * (die werden weiterhin in den Routen separat geprüft mit den frischen DB-Werten).
 */
export async function checkAppointmentWriteAccess(
  user: { id: number; isAdmin: boolean; isSuperAdmin?: boolean | null; isTeamLead?: boolean | null; isActive?: boolean | null; isAnonymized?: boolean | null; roles?: readonly string[] },
  appointment: { assignedEmployeeId: number | null; performedByEmployeeId?: number | null; customerId: number | null },
  res: Response,
): Promise<boolean> {
  const policyUser = toPolicyUser(user);
  // Wer-Frage: Admin oder zugewiesener Mitarbeiter (Teamleiter NICHT —
  // dokumentieren ist eine persönliche Tätigkeit und darf nicht im Namen
  // anderer durchgeführt werden).
  const adminLike = policyUser.isAdmin || policyUser.isSuperAdmin;
  const isAssigned = appointment.assignedEmployeeId === user.id
    || appointment.performedByEmployeeId === user.id;
  if (!adminLike && !isAssigned) {
    sendForbidden(res, "ACCESS_DENIED", "Nur der zugewiesene Mitarbeiter darf diesen Termin bearbeiten.");
    return false;
  }
  return true;
}

/**
 * Schreibrecht für PATCH /api/appointments/:id (Reassign / Bearbeiten).
 * Teamleiter besitzen firmenweite Admin-Sicht (flacher Marker) und dürfen
 * jeden Termin bearbeiten/zuordnen/umplanen. Start/end/reopen/delete bleiben
 * an die jeweiligen Sperren (gestartet, locked, Monat geschlossen) gebunden.
 */
async function checkAppointmentReassignAccess(
  user: { id: number; isAdmin: boolean; isActive?: boolean; isTeamLead?: boolean; isSuperAdmin?: boolean; isAnonymized?: boolean; roles?: readonly string[] },
  appointment: { assignedEmployeeId: number | null; performedByEmployeeId?: number | null; customerId: number | null },
  res: Response,
): Promise<boolean> {
  const policyUser = toPolicyUser(user);
  const adminLike = policyUser.isAdmin || policyUser.isSuperAdmin;
  const lead = policyUser.isTeamLead;
  const isAssigned = appointment.assignedEmployeeId === user.id
    || appointment.performedByEmployeeId === user.id;
  if (adminLike || lead || isAssigned) return true;
  sendForbidden(res, "ACCESS_DENIED", "Nur der zugewiesene Mitarbeiter darf diesen Termin bearbeiten.");
  return false;
}

router.use(requireAuth);

router.get("/active-employees", asyncHandler("Mitarbeiter konnten nicht geladen werden", async (_req, res) => {
  const employees = await authService.getActiveEmployees();
  const safeEmployees = employees.map((e) => ({
    id: e.id,
    displayName: e.displayName,
    isTeamLead: Boolean(e.isTeamLead),
    // Rollen werden im Frontend benötigt, damit Teamleitungen
    // (ohne Zugriff auf /admin/employees) Erstberatungs-Mitarbeiter filtern
    // können. Es werden ausschließlich die nicht-sensiblen Rollen-Kürzel
    // ausgeliefert.
    roles: e.roles ?? [],
  }));
  res.json(safeEmployees);
}));

router.get("/coverage-check", asyncHandler("Fehler beim Laden der Terminabdeckung", async (req, res) => {
  const user = req.user!;
  const employeeIdParam = req.query.employeeId ? parseInt(req.query.employeeId as string, 10) : null;
  if (employeeIdParam !== null && isNaN(employeeIdParam)) {
    return res.status(400).json({ code: "BAD_REQUEST", message: "Ungültige Mitarbeiter-ID" });
  }
  const effectiveEmployeeId = (user.isAdmin && employeeIdParam) ? employeeIdParam : user.id;

  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;
  const nextMonth = currentMonth === 12 ? 1 : currentMonth + 1;
  const nextMonthYear = currentMonth === 12 ? currentYear + 1 : currentYear;

  const monthNames = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];

  const assignedCustomers = await customersRepo.selectColumnsFrom({
    id: customers.id,
    name: customers.name,
    primaryEmployeeId: customers.primaryEmployeeId,
    backupEmployeeId: customers.backupEmployeeId,
    backupEmployeeId2: customers.backupEmployeeId2,
  })
  .where(
    and(
      eq(customers.status, "aktiv"),
      customersRepo.activeOnly(),
      or(
        eq(customers.primaryEmployeeId, effectiveEmployeeId),
        eq(customers.backupEmployeeId, effectiveEmployeeId),
        eq(customers.backupEmployeeId2, effectiveEmployeeId),
      )
    )
  );

  if (assignedCustomers.length === 0) {
    return res.json({
      currentMonth: { label: `${monthNames[currentMonth - 1]} ${currentYear}`, year: currentYear, month: currentMonth, uncoveredCustomers: [] },
      nextMonth: { label: `${monthNames[nextMonth - 1]} ${nextMonthYear}`, year: nextMonthYear, month: nextMonth, uncoveredCustomers: [] },
    });
  }

  const primaryEmployeeIds = [...new Set(assignedCustomers.map(c => c.primaryEmployeeId).filter((id): id is number => id !== null && id !== effectiveEmployeeId))];
  const primaryEmployeeNames = new Map<number, string>();
  if (primaryEmployeeIds.length > 0) {
    const empRows = await db.select({ id: users.id, displayName: users.displayName }).from(users).where(inArray(users.id, primaryEmployeeIds));
    for (const e of empRows) primaryEmployeeNames.set(e.id, e.displayName);
  }

  const customerIds = assignedCustomers.map(c => c.id);

  const currentMonthStart = `${currentYear}-${String(currentMonth).padStart(2, "0")}-01`;
  const currentMonthEnd = `${currentYear}-${String(currentMonth).padStart(2, "0")}-${new Date(currentYear, currentMonth, 0).getDate()}`;
  const nextMonthStart = `${nextMonthYear}-${String(nextMonth).padStart(2, "0")}-01`;
  const nextMonthEnd = `${nextMonthYear}-${String(nextMonth).padStart(2, "0")}-${new Date(nextMonthYear, nextMonth, 0).getDate()}`;

  const contractEndRows = await db.select({
    customerId: customerContracts.customerId,
    maxEnd: sql<string | null>`MAX(${customerContracts.contractEnd})`.as("max_end"),
    hasOpenEnded: sql<boolean>`bool_or(${customerContracts.contractEnd} IS NULL AND ${customerContracts.status} = 'active')`.as("has_open_ended"),
  })
  .from(customerContracts)
  .where(inArray(customerContracts.customerId, customerIds))
  .groupBy(customerContracts.customerId);

  const contractInfo = new Map(contractEndRows.map(r => [r.customerId, r]));

  function hasActiveContractForMonth(customerId: number, monthStart: string): boolean {
    const info = contractInfo.get(customerId);
    if (!info) return true;
    if (info.hasOpenEnded) return true;
    if (!info.maxEnd) return true;
    return info.maxEnd >= monthStart;
  }

  const [currentMonthAppts, nextMonthAppts] = await Promise.all([
    appointmentsRepo.selectColumnsFrom({ customerId: appointments.customerId })
      .where(
        and(
          inArray(appointments.customerId, customerIds),
          gte(appointments.date, currentMonthStart),
          lte(appointments.date, currentMonthEnd),
          ne(appointments.status, "cancelled"),
          appointmentsRepo.activeOnly(),
        )
      ),
    appointmentsRepo.selectColumnsFrom({ customerId: appointments.customerId })
      .where(
        and(
          inArray(appointments.customerId, customerIds),
          gte(appointments.date, nextMonthStart),
          lte(appointments.date, nextMonthEnd),
          ne(appointments.status, "cancelled"),
          appointmentsRepo.activeOnly(),
        )
      ),
  ]);

  const currentCoveredIds = new Set(currentMonthAppts.map(a => a.customerId));
  const nextCoveredIds = new Set(nextMonthAppts.map(a => a.customerId));

  function getRole(c: typeof assignedCustomers[0]): "primary" | "backup1" | "backup2" {
    if (c.primaryEmployeeId === effectiveEmployeeId) return "primary";
    if (c.backupEmployeeId === effectiveEmployeeId) return "backup1";
    return "backup2";
  }

  function buildUncoveredEntry(c: typeof assignedCustomers[0]) {
    const role = getRole(c);
    const entry: { id: number; name: string; role: string; primaryEmployeeName?: string } = { id: c.id, name: c.name, role };
    if (role !== "primary" && c.primaryEmployeeId) {
      entry.primaryEmployeeName = primaryEmployeeNames.get(c.primaryEmployeeId) ?? undefined;
    }
    return entry;
  }

  const currentUncovered = assignedCustomers
    .filter(c => !currentCoveredIds.has(c.id) && hasActiveContractForMonth(c.id, currentMonthStart))
    .map(buildUncoveredEntry);

  const nextUncovered = assignedCustomers
    .filter(c => !nextCoveredIds.has(c.id) && hasActiveContractForMonth(c.id, nextMonthStart))
    .map(buildUncoveredEntry);

  const coverageResponse: CoverageCheckResponse = {
    currentMonth: {
      label: `${monthNames[currentMonth - 1]} ${currentYear}`,
      year: currentYear,
      month: currentMonth,
      uncoveredCustomers: currentUncovered,
    },
    nextMonth: {
      label: `${monthNames[nextMonth - 1]} ${nextMonthYear}`,
      year: nextMonthYear,
      month: nextMonth,
      uncoveredCustomers: nextUncovered,
    },
  };

  res.json(coverageResponse);
}));

router.get("/", asyncHandler(ErrorMessages.fetchAppointmentsFailed, async (req, res) => {
  const date = req.query.date as string | undefined;
  const customerId = req.query.customerId ? parseInt(req.query.customerId as string) : undefined;
  const viewAsEmployeeId = req.query.viewAsEmployeeId ? parseInt(req.query.viewAsEmployeeId as string) : undefined;
  const user = req.user!;

  let customerIds: number[] | undefined;
  let employeeId: number | number[] | undefined;
  const assignedOnly = false;
  // Teamleiter besitzen firmenweite Admin-Sicht (flacher Marker).
  const adminScope = user.isAdmin || isTeamLead(user);

  if (adminScope && viewAsEmployeeId) {
    customerIds = await storage.getPrimaryCustomerIds(viewAsEmployeeId);
    employeeId = viewAsEmployeeId;
  } else if (!adminScope) {
    customerIds = await storage.getPrimaryCustomerIds(user.id);
    employeeId = user.id;
  }

  if (customerId) {
    if (!adminScope && employeeId !== undefined && !Array.isArray(employeeId)) {
      const allAssignedIds = await storage.getAssignedCustomerIds(employeeId);
      if (!allAssignedIds.includes(customerId)) {
        return res.json([]);
      }
    }
    customerIds = [customerId];
  }

  const appointments = await storage.getAppointmentsWithCustomers(date, customerIds, employeeId, assignedOnly);

  res.json(appointments);
}));

router.get("/counts", asyncHandler("Fehler beim Laden der Terminzähler", async (req, res) => {
  const user = req.user!;
  const datesParam = req.query.dates as string | undefined;
  const viewAsEmployeeId = req.query.viewAsEmployeeId ? parseInt(req.query.viewAsEmployeeId as string) : undefined;
  if (!datesParam) {
    return sendBadRequest(res, "Datumsangaben fehlen");
  }
  const dates = datesParam.split(",").filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
  if (dates.length === 0 || dates.length > 14) {
    return sendBadRequest(res, "Ungültige Datumsangaben (max. 14 Tage)");
  }

  let customerIds: number[] | undefined;
  let employeeId: number | number[] | undefined;
  const assignedOnlyCounts = false;
  // Teamleiter besitzen firmenweite Admin-Sicht (flacher Marker).
  const adminScope = user.isAdmin || isTeamLead(user);

  if (adminScope && viewAsEmployeeId) {
    customerIds = await storage.getPrimaryCustomerIds(viewAsEmployeeId);
    employeeId = viewAsEmployeeId;
  } else if (!adminScope) {
    customerIds = await storage.getPrimaryCustomerIds(user.id);
    employeeId = user.id;
  }

  const counts = await storage.getAppointmentCountsByDates(dates, customerIds, employeeId, assignedOnlyCounts);
  res.json(counts);
}));

router.get("/planned-consultations", asyncHandler("Fehler beim Laden der geplanten Erstberatungen", async (req, res) => {
  const user = req.user!;
  // Teamleitungen besitzen firmenweite Admin-Sicht und dürfen Erstberatungen
  // ebenfalls einsehen und umterminieren (analog zu /undocumented).
  if (!user.isAdmin && !isTeamLead(user)) {
    return sendForbidden(res, "FORBIDDEN", "Sie haben keine Berechtigung für diese Aktion");
  }
  const filterParam = (req.query.filter as string | undefined) ?? "all";
  const filter: "overdue" | "upcoming" | "all" =
    filterParam === "overdue" || filterParam === "upcoming" ? filterParam : "all";
  const today = todayISO();
  const appointments = await storage.getPlannedConsultations(filter, today);
  res.json(appointments);
}));

router.get("/undocumented", asyncHandler("Fehler beim Laden der offenen Dokumentationen", async (req, res) => {
  const user = req.user!;
  const today = todayISO();
  const viewAsEmployeeId = req.query.viewAsEmployeeId ? parseInt(req.query.viewAsEmployeeId as string) : undefined;
  
  let customerIds: number[] | undefined;
  let employeeId: number | number[] | undefined;
  let assignedOnlyUndoc = false;
  // Teamleiter besitzen firmenweite Admin-Sicht (flacher Marker).
  const adminScope = user.isAdmin || isTeamLead(user);

  if (adminScope && viewAsEmployeeId) {
    employeeId = viewAsEmployeeId;
    assignedOnlyUndoc = true;
  } else if (!adminScope) {
    customerIds = await storage.getAssignedCustomerIds(user.id);
    employeeId = user.id;
  }

  const nowTime = currentTimeHHMMSS().slice(0, 5);
  const appointments = await storage.getUndocumentedAppointments(today, customerIds, employeeId, assignedOnlyUndoc, nowTime);
  
  res.json(appointments);
}));

router.get("/undocumented/by-customer", asyncHandler("Fehler beim Laden der offenen Termine", async (req, res) => {
  const user = req.user!;
  const customerId = req.query.customerId ? parseInt(req.query.customerId as string, 10) : NaN;
  const year = req.query.year ? parseInt(req.query.year as string, 10) : NaN;
  const month = req.query.month ? parseInt(req.query.month as string, 10) : NaN;
  if (!Number.isFinite(customerId) || customerId <= 0
    || !Number.isFinite(year) || year < 2000 || year > 2100
    || !Number.isFinite(month) || month < 1 || month > 12) {
    return sendBadRequest(res, "Ungültige Parameter (customerId, year, month erforderlich)");
  }
  const viewAsEmployeeId = req.query.viewAsEmployeeId ? parseInt(req.query.viewAsEmployeeId as string, 10) : undefined;
  const adminScope = user.isAdmin || isTeamLead(user);
  // Scope-Parität mit /appointments/undocumented:
  // - Admin/Teamlead ohne viewAs → globale Sicht (kein Employee-Filter); via isPrimary=true erzwungen.
  // - Admin/Teamlead mit viewAs → Sicht des gewählten Mitarbeiters.
  // - Mitarbeiter → eigene Sicht (assigned/performed), isPrimary nach Primary-Liste.
  const effectiveEmployeeId = adminScope && viewAsEmployeeId ? viewAsEmployeeId : user.id;

  if (!(await checkCustomerAccess(user, customerId, res))) return;

  let isPrimary: boolean;
  if (adminScope && !viewAsEmployeeId) {
    isPrimary = true;
  } else {
    const primaryIds = await storage.getPrimaryCustomerIds(effectiveEmployeeId);
    isPrimary = primaryIds.includes(customerId);
  }
  const appointments = await storage.getUndocumentedAppointmentsForPeriod(
    customerId,
    effectiveEmployeeId,
    year,
    month,
    isPrimary,
  );
  res.json(appointments);
}));

router.get("/batch-services", asyncHandler("Fehler beim Laden der Batch-Services", async (req, res) => {
  const user = req.user!;
  const idsParam = req.query.ids as string | undefined;
  if (!idsParam) return sendBadRequest(res, "Termin-IDs fehlen");

  const ids = idsParam.split(",").map(Number).filter(n => !isNaN(n) && n > 0);
  if (ids.length === 0 || ids.length > 100) {
    return sendBadRequest(res, "Ungültige Termin-IDs (max. 100)");
  }

  const grouped = await storage.getBatchAppointmentServices(ids);

  res.json(grouped);
}));

router.get("/:id/services", asyncHandler("Fehler beim Laden der Termin-Services", async (req, res) => {
  const user = req.user!;
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;
  
  const appointment = await storage.getAppointment(id);
  if (!appointment) return sendNotFound(res, "Termin nicht gefunden");
  if (!(await checkCustomerAccess(user, appointment.customerId, res, {
    assignedEmployeeId: appointment.assignedEmployeeId,
    performedByEmployeeId: appointment.performedByEmployeeId,
  }))) return;
  
  const result = await storage.getAppointmentServices(id);
  
  res.json(result);
}));

router.get("/:id", asyncHandler(ErrorMessages.fetchAppointmentFailed, async (req, res) => {
  const user = req.user!;
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;
  
  const appointment = await storage.getAppointmentWithCustomer(id);
  
  if (!appointment) {
    return sendNotFound(res, ErrorMessages.appointmentNotFound);
  }
  
  if (!(await checkCustomerAccess(user, appointment.customerId, res, {
    assignedEmployeeId: appointment.assignedEmployeeId,
    performedByEmployeeId: appointment.performedByEmployeeId,
  }))) return;

  const isLocked = await storage.isAppointmentLocked(id);

  let isMonthClosed = false;
  if (appointment.status === "completed" && appointment.date) {
    const employeeId = appointment.assignedEmployeeId || appointment.performedByEmployeeId;
    if (employeeId) {
      isMonthClosed = await timeTrackingStorage.isMonthClosed(employeeId, appointment.date);
    }
  }

  let lockedReason: string | undefined;
  if (isLocked) {
    lockedReason = "Verknüpft mit einem unterschriebenen Leistungsnachweis";
  } else if (isMonthClosed) {
    lockedReason = "Der Monat ist bereits abgeschlossen";
  }

  res.json({ ...appointment, isLocked, isMonthClosed, lockedReason });
}));

router.post("/kundentermin", asyncHandler(ErrorMessages.createAppointmentFailed, async (req, res) => {
  const validatedData = insertKundenterminSchema.parse(req.body);
  const user = req.user!;

  const customer = await storage.getCustomer(validatedData.customerId);
  if (!customer) {
    return sendNotFound(res, "Kunde nicht gefunden.");
  }

  // Wer wird der Termin zugeordnet? Brauchen wir vorab für isMonthClosed-Check.
  const forOtherEmployee = !!(validatedData.assignedEmployeeId
    && validatedData.assignedEmployeeId !== user.id);
  const checkEmpId = validatedData.assignedEmployeeId || user.id;
  const monthClosed = await timeTrackingStorage.isMonthClosed(checkEmpId, validatedData.date);
  const isAssignedToCustomer = (await storage.getCurrentlyAssignedCustomerIds(user.id))
    .includes(validatedData.customerId);

  const farPastDate = isDateMoreThan3MonthsInPast(validatedData.date);
  const decision = policyCanCreate(toPolicyUser(user), {
    date: validatedData.date,
    isWeekend: isWeekend(validatedData.date),
    isHoliday: false,
    isFarPast: farPastDate,
    isMonthClosed: monthClosed,
    appointmentType: "Kundentermin",
    isAssignedToCustomer,
    forOtherEmployee,
  });
  if (!decision.allowed) return denyByPolicy(res, decision, "ACCESS_DENIED", { kind: "create" });

  let _warning: string | undefined;
  if (farPastDate && (user.isAdmin || user.isSuperAdmin)) {
    _warning = "Achtung: Dieser Termin liegt mehr als 3 Monate in der Vergangenheit.";
  }

  const currentContract = await customerManagementStorage.getCustomerCurrentContract(validatedData.customerId);
  if (currentContract?.contractEnd && validatedData.date > currentContract.contractEnd) {
    const endFormatted = currentContract.contractEnd.split("-").reverse().join(".");
    return sendBadRequest(res, `Der Vertrag endet am ${endFormatted}. Neue Termine können nicht nach dem Vertragsende erstellt werden.`);
  }

  let assignedEmployeeId: number;
  if (user.isAdmin || isTeamLead(user)) {
    if (!validatedData.assignedEmployeeId) {
      return sendBadRequest(res, "Bitte wählen Sie einen Mitarbeiter für diesen Termin aus.");
    }
    assignedEmployeeId = validatedData.assignedEmployeeId;

    const [targetEmployee] = await db
      .select({ id: users.id, isActive: users.isActive })
      .from(users)
      .where(eq(users.id, assignedEmployeeId))
      .limit(1);
    if (!targetEmployee || targetEmployee.isActive === false) {
      return sendBadRequest(
        res,
        "Der ausgewählte Mitarbeiter ist nicht aktiv. Bitte wählen Sie einen aktiven Mitarbeiter aus.",
      );
    }
  } else {
    assignedEmployeeId = user.id;
  }
  
  const serviceIds = validatedData.services.map(s => s.serviceId);
  const serviceRecords = await storage.getServicesByIds(serviceIds);
  const serviceCodeMap = Object.fromEntries(serviceRecords.map(s => [s.id, s.code]));

  const servicesWithCodes = validatedData.services.map(s => ({
    serviceId: s.serviceId,
    durationMinutes: s.durationMinutes,
    serviceCode: serviceCodeMap[s.serviceId] || null,
  }));

  const { appointmentData, scheduledEnd, serviceEntries } = appointmentService.prepareKundenterminData({
    ...validatedData,
    services: servicesWithCodes,
    assignedEmployeeId,
    isFahrtdienst: validatedData.isFahrtdienst ?? false,
    doctorName: validatedData.doctorName,
    doctorAppointmentTime: validatedData.doctorAppointmentTime,
    doctorStrasse: validatedData.doctorStrasse,
    doctorNr: validatedData.doctorNr,
    doctorPlz: validatedData.doctorPlz,
    doctorStadt: validatedData.doctorStadt,
    doctorLatitude: validatedData.doctorLatitude,
    doctorLongitude: validatedData.doctorLongitude,
    estimatedTravelMinutes: validatedData.estimatedTravelMinutes,
    travelBufferMinutes: validatedData.travelBufferMinutes,
  });
  
  const overlapResult = await appointmentService.checkOverlap(
    validatedData.date, 
    validatedData.scheduledStart, 
    scheduledEnd,
    assignedEmployeeId
  );
  
  if (overlapResult.hasUnreliableData) {
    return sendConflict(
      res, 
      "Datenprüfung erforderlich",
      ErrorMessages.unreliableData(overlapResult.unreliableAppointmentId!)
    );
  }
  
  if (overlapResult.hasOverlap) {
    return sendConflict(res, "Terminüberschneidung", ErrorMessages.timeOverlap);
  }

  const blockerConflict = await checkEmployeeBlocker(
    assignedEmployeeId, validatedData.date, validatedData.scheduledStart, scheduledEnd
  );
  if (blockerConflict) {
    return sendConflict(res, "Mitarbeiter blockiert", blockerConflict);
  }

  const customerOverlap = await appointmentService.checkCustomerOverlap(
    validatedData.date, validatedData.scheduledStart, scheduledEnd, validatedData.customerId
  );
  if (customerOverlap) {
    return sendConflict(res, "Kundenüberschneidung", "Dieser Kunde hat bereits einen Termin in diesem Zeitraum.");
  }
  
  const appointment = await db.transaction(async (tx) => {
    const created = await storage.createAppointment(appointmentData, tx);
    if (serviceEntries.length > 0) {
      await storage.createAppointmentServices(created.id, serviceEntries, tx);
    }
    return created;
  });

  await auditService.appointmentCreated(
    user.id,
    appointment.id,
    {
      customerId: validatedData.customerId,
      assignedEmployeeId,
      date: validatedData.date,
      actor: { role: actorRole(user) },
    },
    req.ip,
  );

  if (assignedEmployeeId !== user.id) {
    const customerName = `${customer.vorname} ${customer.nachname}`;
    notificationService.notifyAppointmentCreated(appointment.id, customerName, validatedData.date, assignedEmployeeId, user.id);
  }

  try {
    // Retry transiente Connection-Fehler — Budget-Warnung ist idempotenter Read,
    // soll aber bei einem Neon-Cold-Start nicht lautlos verschwinden (Task #536).
    await withDbRetry(
      () => budgetLedgerStorage.syncCarryoverAndExpiry(validatedData.customerId),
      { label: "syncCarryoverAndExpiry" },
    );
    const budgetSummary = await withDbRetry(
      () => budgetLedgerStorage.getBudgetSummary(validatedData.customerId),
      { label: "getBudgetSummary" },
    );
    _warning = buildBudgetWarning(budgetSummary, { appointmentDates: [validatedData.date] }) ?? undefined;
  } catch (err) {
    console.warn("[appointments] Budget-Warnung fehlgeschlagen:", err);
  }

  res.status(201).json(_warning ? { ...appointment, _warning } : appointment);
}));

router.post("/prospect-erstberatung", asyncHandler("Erstberatung konnte nicht erstellt werden", async (req, res) => {
  const validatedData = insertProspectErstberatungSchema.parse(req.body);
  const user = req.user!;

  const prospect = await prospectStorage.getById(validatedData.prospectId);
  if (!prospect) {
    return sendNotFound(res, "Interessent nicht gefunden");
  }

  const farPastDate = isDateMoreThan3MonthsInPast(validatedData.date);
  const checkEmpForMonth = validatedData.assignedEmployeeId || user.id;
  const monthClosedErst = await timeTrackingStorage.isMonthClosed(checkEmpForMonth, validatedData.date);
  const erstDecision = policyCanCreate(toPolicyUser(user), {
    date: validatedData.date,
    isWeekend: isWeekend(validatedData.date),
    isHoliday: false,
    isFarPast: farPastDate,
    isMonthClosed: monthClosedErst,
    appointmentType: "Erstberatung",
    forOtherEmployee: !!(validatedData.assignedEmployeeId && validatedData.assignedEmployeeId !== user.id),
  });
  if (!erstDecision.allowed) return denyByPolicy(res, erstDecision, "ACCESS_DENIED", { kind: "create" });

  let _warning: string | undefined;
  if (farPastDate && (user.isAdmin || user.isSuperAdmin)) {
    _warning = "Achtung: Dieser Termin liegt mehr als 3 Monate in der Vergangenheit.";
  }

  let assignedEmployeeId: number;
  if (user.isAdmin || isTeamLead(user)) {
    // Admins und Teamleitungen dürfen Erstberatungen im Namen jedes
    // aktiven Erstberaters anlegen (analog Kundentermine, vgl. Task #311/#312).
    if (!validatedData.assignedEmployeeId) {
      return sendBadRequest(res, "Bitte wählen Sie einen Mitarbeiter für diese Erstberatung aus.");
    }
    assignedEmployeeId = validatedData.assignedEmployeeId;

    const [targetEmployee] = await db
      .select({ id: users.id, isActive: users.isActive })
      .from(users)
      .where(eq(users.id, assignedEmployeeId))
      .limit(1);
    if (!targetEmployee || targetEmployee.isActive === false) {
      return sendBadRequest(
        res,
        "Der ausgewählte Mitarbeiter ist nicht aktiv. Bitte wählen Sie einen aktiven Mitarbeiter aus.",
      );
    }

    const [erstberatungRole] = await db
      .select({ userId: userRoles.userId })
      .from(userRoles)
      .where(and(eq(userRoles.userId, assignedEmployeeId), eq(userRoles.role, "erstberatung")))
      .limit(1);
    if (!erstberatungRole) {
      return sendBadRequest(
        res,
        "Der ausgewählte Mitarbeiter ist kein Erstberater. Bitte wählen Sie einen aktiven Erstberater aus.",
      );
    }
  } else {
    assignedEmployeeId = user.id;
  }

  const scheduledEnd = addMinutesToTimeHHMMSS(validatedData.scheduledStart, validatedData.erstberatungDauer);

  const overlapResult = await appointmentService.checkOverlap(
    validatedData.date,
    validatedData.scheduledStart,
    scheduledEnd,
    assignedEmployeeId
  );

  if (overlapResult.hasUnreliableData) {
    return sendConflict(
      res,
      "Datenprüfung erforderlich",
      ErrorMessages.unreliableData(overlapResult.unreliableAppointmentId!)
    );
  }

  if (overlapResult.hasOverlap) {
    return sendConflict(res, "Terminüberschneidung", ErrorMessages.timeOverlap);
  }

  const erstberatungBlockerConflict = await checkEmployeeBlocker(
    assignedEmployeeId, validatedData.date, validatedData.scheduledStart, scheduledEnd
  );
  if (erstberatungBlockerConflict) {
    return sendConflict(res, "Mitarbeiter blockiert", erstberatungBlockerConflict);
  }

  const erstberatungService = await serviceCatalogStorage.getServiceByCode("erstberatung");

  const result = await db.transaction(async (tx) => {
    const [appointment] = await tx.insert(appointments).values({
      prospectId: validatedData.prospectId,
      appointmentType: "Erstberatung",
      date: validatedData.date,
      scheduledStart: validatedData.scheduledStart,
      scheduledEnd,
      durationPromised: validatedData.erstberatungDauer,
      notes: validatedData.notes || null,
      status: "scheduled",
      createdByUserId: user.id,
      assignedEmployeeId,
    }).returning();

    await tx.update(prospects)
      .set({ status: "erstberatung_vereinbart", updatedAt: new Date() })
      .where(eq(prospects.id, validatedData.prospectId));

    if (erstberatungService) {
      await storage.createAppointmentServices(
        appointment.id,
        [{ serviceId: erstberatungService.id, plannedDurationMinutes: validatedData.erstberatungDauer }],
        tx,
      );
    }

    return appointment;
  });

  await prospectStorage.addNote({
    prospectId: validatedData.prospectId,
    userId: user.id,
    noteText: `Erstberatung am ${validatedData.date} um ${validatedData.scheduledStart} vereinbart`,
    noteType: "statuswechsel",
  });

  if (assignedEmployeeId !== user.id) {
    const customerName = `${prospect.vorname} ${prospect.nachname}`;
    notificationService.notifyAppointmentCreated(result.id, customerName, validatedData.date, assignedEmployeeId, user.id);
  }

  res.status(201).json(_warning ? { appointment: result, _warning } : { appointment: result });
}));

router.patch("/:id", asyncHandler(ErrorMessages.updateAppointmentFailed, async (req, res) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const existingAppointment = await storage.getAppointment(id);
  if (!existingAppointment) {
    return sendNotFound(res, ErrorMessages.appointmentNotFound);
  }

  // K8: Whitelist `notes` darf auch im Lock geändert werden; das wird über
  // `notesOnly` an die Policy weitergegeben.
  const PATCH_LOCK_WHITELIST = new Set(["notes"]);
  const bodyKeys = Object.keys(req.body || {});
  const notesOnly = bodyKeys.length > 0 && bodyKeys.every((k) => PATCH_LOCK_WHITELIST.has(k));

  const flags = await loadPolicyFlags(id, existingAppointment);
  const policyAppt = toPolicyAppointment(existingAppointment, flags);
  const decision = policyCanEdit(toPolicyUser(req.user!), policyAppt, { notesOnly });
  if (!decision.allowed) {
    // Lock-Verstoß bleibt 409 Conflict, alles andere 403.
    if (flags.isLocked && !notesOnly) {
      return sendConflict(res, "APPOINTMENT_LOCKED", decision.reason);
    }
    return denyByPolicy(res, decision, "ACCESS_DENIED");
  }
  
  if (existingAppointment.signatureData) {
    const protectedFields = ['signatureData', 'signatureHash', 'signedAt', 'signedByUserId'];
    const bodyKeys = Object.keys(req.body);
    const touchesSignature = protectedFields.some(f => bodyKeys.includes(f));
    if (touchesSignature) {
      return sendForbidden(res, "SIGNATURE_LOCKED", "Die Unterschrift dieses Termins ist gesperrt. Bitte nutzen Sie die Stornierungsfunktion im Admin-Bereich.");
    }
  }

  const validatedData = updateAppointmentSchema.parse(req.body);

  let validatedServicesPayload: { serviceId: number; plannedDurationMinutes: number }[] | undefined;
  if (req.body.services !== undefined) {
    if (!Array.isArray(req.body.services)) {
      return sendBadRequest(res, "Das Feld 'services' muss eine Liste sein.");
    }
    const servicesSchema = z.array(z.object({
      serviceId: z.number().int().positive(),
      plannedDurationMinutes: z.number().int().positive(),
    }));
    const parsed = servicesSchema.safeParse(req.body.services);
    if (!parsed.success) {
      return sendBadRequest(res, "Ungültige Service-Zeilen — jede Zeile braucht eine positive serviceId und plannedDurationMinutes.");
    }
    validatedServicesPayload = parsed.data;

    const servicesSum = parsed.data.reduce((s, sv) => s + sv.plannedDurationMinutes, 0);
    if (validatedData.durationPromised != null) {
      if (servicesSum !== validatedData.durationPromised) {
        return sendBadRequest(
          res,
          `Die geplante Termin-Dauer (${validatedData.durationPromised} Min) weicht von der Summe der Service-Minuten (${servicesSum} Min) ab. Bitte beide Werte konsistent setzen oder nur einen Wert ändern.`,
        );
      }
    } else if (servicesSum !== existingAppointment.durationPromised) {
      // Service-Änderungen, die die Gesamtdauer verschieben, sind eine
      // implizite Scheduling-Änderung. Wir tragen die neue Dauer in die
      // validierten Daten ein, damit `validateSchedulingChanges` sie sieht
      // und auf nicht-`scheduled` Termine korrekt mit 403 antwortet.
      validatedData.durationPromised = servicesSum;
    }

    // Wenn die Service-Summe die Gesamtdauer verschiebt und der Aufrufer
    // kein explizites scheduledEnd mitliefert, ziehen wir scheduledEnd
    // automatisch nach (scheduledStart + neue Dauer). So bleiben Kalender-
    // und Überlappungs-Anzeigen konsistent mit der neuen Dauer.
    if (validatedData.scheduledEnd === undefined && servicesSum !== existingAppointment.durationPromised) {
      const startForEnd = validatedData.scheduledStart ?? existingAppointment.scheduledStart;
      if (startForEnd) {
        validatedData.scheduledEnd = addMinutesToTimeHHMMSS(startForEnd, servicesSum);
      }
    }
  } else if (
    validatedData.durationPromised != null
    && validatedData.scheduledEnd === undefined
    && validatedData.durationPromised !== existingAppointment.durationPromised
  ) {
    // Wird die Gesamtdauer direkt geändert (ohne services-Array und ohne
    // explizites scheduledEnd), ziehen wir scheduledEnd analog zum
    // services-Pfad nach. Sonst bleiben Dauer und End-Zeit inkonsistent,
    // obwohl `syncAppointmentServicesAndDuration` die Service-Zeilen auf
    // die neue Dauer skaliert.
    const startForEnd = validatedData.scheduledStart ?? existingAppointment.scheduledStart;
    if (startForEnd) {
      validatedData.scheduledEnd = addMinutesToTimeHHMMSS(startForEnd, validatedData.durationPromised);
    }
  }

  if (validatedData.date && isWeekend(validatedData.date)) {
    return sendBadRequest(res, "Termine können nicht auf Samstage oder Sonntage verschoben werden.");
  }
  
  const validation = appointmentService.validateAllUpdateRules(existingAppointment, validatedData);
  if (!validation.valid) {
    return sendForbidden(res, validation.error!, validation.message!);
  }

  if (validatedData.date || validatedData.scheduledStart || validatedData.scheduledEnd || validatedData.durationPromised || validatedData.assignedEmployeeId) {
    const checkDate = validatedData.date || existingAppointment.date;
    const checkStart = validatedData.scheduledStart || existingAppointment.scheduledStart;
    const duration = validatedData.durationPromised ?? existingAppointment.durationPromised;
    const checkEnd = validatedData.scheduledEnd
      || (duration ? addMinutesToTimeHHMMSS(checkStart, duration) : null)
      || existingAppointment.scheduledEnd;
    const assignedEmpId = validatedData.assignedEmployeeId || existingAppointment.assignedEmployeeId;

    if (checkDate && checkStart && checkEnd) {
      if (assignedEmpId) {
        const empOverlap = await appointmentService.checkOverlap(checkDate, checkStart, checkEnd, assignedEmpId, id);
        if (empOverlap.hasOverlap) {
          // Reassign-spezifische Klarheit: bei Mitarbeiterwechsel den Namen + blockierten Zeitraum nennen,
          // ohne Details des fremden Termins (Kunde, Notizen) preiszugeben.
          const isReassign = validatedData.assignedEmployeeId !== undefined
            && validatedData.assignedEmployeeId !== existingAppointment.assignedEmployeeId;
          if (isReassign) {
            const targetEmployee = await authService.getUser(assignedEmpId);
            const employeeName = targetEmployee
              ? `${targetEmployee.vorname} ${targetEmployee.nachname}`.trim() || targetEmployee.email
              : `Mitarbeiter #${assignedEmpId}`;
            const startHHMM = checkStart.slice(0, 5);
            const endHHMM = checkEnd.slice(0, 5);
            return sendConflict(
              res,
              "Terminüberschneidung",
              `${employeeName} hat um ${startHHMM}–${endHHMM} bereits einen anderen Termin.`,
            );
          }
          return sendConflict(res, "Terminüberschneidung", ErrorMessages.timeOverlap);
        }

        const updateBlockerConflict = await checkEmployeeBlocker(assignedEmpId, checkDate, checkStart, checkEnd);
        if (updateBlockerConflict) {
          return sendConflict(res, "Mitarbeiter blockiert", updateBlockerConflict);
        }
      }

      // Erstberatungen sind an einen Interessenten (prospectId) gebunden und
      // haben customerId = null. Eine Kunden-Überlappung kann es nur geben,
      // wenn tatsächlich eine customerId existiert.
      if (existingAppointment.customerId != null) {
        const customerOverlap = await appointmentService.checkCustomerOverlap(
          checkDate, checkStart, checkEnd, existingAppointment.customerId, id
        );
        if (customerOverlap) {
          return sendConflict(res, "Kundenüberschneidung", "Dieser Kunde hat bereits einen Termin in diesem Zeitraum.");
        }
      }
    }
  }
  
  if (existingAppointment.seriesId && !existingAppointment.isSeriesException) {
    const hasSchedulingChange = validatedData.date !== undefined
      || validatedData.scheduledStart !== undefined
      || validatedData.scheduledEnd !== undefined
      || validatedData.assignedEmployeeId !== undefined;
    if (hasSchedulingChange) {
      (validatedData as Record<string, unknown>).isSeriesException = true;
    }
  }

  const updated = await db.transaction(async (tx) => {
    const sync = await syncAppointmentServicesAndDuration(
      id,
      {
        durationPromised: validatedData.durationPromised,
        services: validatedServicesPayload,
      },
      tx,
    );

    const dataForUpdate: Record<string, unknown> = { ...validatedData };
    if (sync.effectiveDurationPromised != null) {
      dataForUpdate.durationPromised = sync.effectiveDurationPromised;
    }

    if (Object.keys(dataForUpdate).length === 0) {
      return existingAppointment;
    }

    return await storage.updateAppointment(id, dataForUpdate as typeof validatedData, tx);
  });

  if (!updated) {
    return sendNotFound(res, ErrorMessages.appointmentNotFound);
  }

  const changedFields = Object.keys(validatedData).filter(k => (validatedData as Record<string, unknown>)[k] !== undefined);
  if (changedFields.length > 0) {
    const ip = req.ip || req.socket.remoteAddress;
    await auditService.appointmentUpdated(
      req.user!.id,
      id,
      {
        customerId: existingAppointment.customerId!,
        changedFields,
        actor: { role: actorRole(req.user!) },
      },
      ip
    );
  }

  if (updated) {
    const newEmployeeId = updated.assignedEmployeeId || updated.performedByEmployeeId;
    const oldEmployeeIdForNotify = existingAppointment.assignedEmployeeId || existingAppointment.performedByEmployeeId;
    const hasSchedulingChange = validatedData.date !== undefined
      || validatedData.scheduledStart !== undefined
      || validatedData.scheduledEnd !== undefined
      || validatedData.durationPromised !== undefined
      || validatedData.assignedEmployeeId !== undefined;

    // Nur bei tatsächlich relevanten Änderungen (Datum/Zeit/Mitarbeiter)
    // benachrichtigen — und nie sich selbst (Self-Assign-Schutz).
    if (newEmployeeId && updated.customerId && hasSchedulingChange && newEmployeeId !== req.user!.id) {
      const customer = await storage.getCustomer(updated.customerId);
      const customerName = customer ? `${customer.vorname} ${customer.nachname}` : "Unbekannt";
      notificationService.notifyAppointmentUpdated(id, customerName, updated.date || "", newEmployeeId, req.user!.id);
    }

    // Wechsel des zugewiesenen Mitarbeiters: alten Mitarbeiter informieren,
    // dass ihm der Termin entzogen wurde (Self-Assign-Schutz beachten).
    if (
      validatedData.assignedEmployeeId !== undefined
      && oldEmployeeIdForNotify
      && oldEmployeeIdForNotify !== newEmployeeId
      && oldEmployeeIdForNotify !== req.user!.id
      && updated.customerId
    ) {
      const customer = await storage.getCustomer(updated.customerId);
      const customerName = customer ? `${customer.vorname} ${customer.nachname}` : "Unbekannt";
      const revokedDate = existingAppointment.date || updated.date || "";
      notificationService.notifyAppointmentRevoked(id, customerName, revokedDate, oldEmployeeIdForNotify, req.user!.id);
    }
  }

  if (updated && updated.date) {
    const newEmployeeId = updated.assignedEmployeeId || updated.performedByEmployeeId;
    const oldEmployeeId = existingAppointment.assignedEmployeeId || existingAppointment.performedByEmployeeId;
    const employeesToRecalc = new Map<number, Set<string>>();

    const addRecalc = (empId: number, date: string) => {
      if (!employeesToRecalc.has(empId)) employeesToRecalc.set(empId, new Set());
      employeesToRecalc.get(empId)!.add(date);
    };

    if (newEmployeeId) addRecalc(newEmployeeId, updated.date);
    if (oldEmployeeId && existingAppointment.date) {
      addRecalc(oldEmployeeId, existingAppointment.date);
    }

    for (const [empId, dates] of employeesToRecalc) {
      for (const d of dates) {
        checkAndRecalcDailyAutoBreak(empId, d);
      }
    }
  }

  res.json(updated);
}));

/**
 * Lädt die Policy-Flags (isLocked, isMonthClosed) für einen Termin.
 * Zentralisiert die zwei DB-Lookups, die jede Mutation braucht, damit
 * die Policy mit konsistenten Werten entscheiden kann.
 */
async function loadPolicyFlags(appointmentId: number, appt: { date: string; assignedEmployeeId: number | null; performedByEmployeeId: number | null }): Promise<{ isLocked: boolean; isMonthClosed: boolean }> {
  const isLocked = await storage.isAppointmentLocked(appointmentId);
  let isMonthClosed = false;
  const employeeId = appt.assignedEmployeeId || appt.performedByEmployeeId;
  if (employeeId && appt.date) {
    isMonthClosed = await timeTrackingStorage.isMonthClosed(employeeId, appt.date);
  }
  return { isLocked, isMonthClosed };
}

function denyByPolicy(
  res: Response,
  decision: { allowed: false; reason: string },
  fallbackCode: string,
  opts: { kind?: "create" | "default" } = {},
): void {
  // Map Policy-Reason auf einen stabilen Error-Code für die UI.
  // Reihenfolge wichtig: spezifischere Treffer zuerst (z. B. „abgeschlossener Termin“
  // vs. „abgeschlossener Monat“).
  const reason = decision.reason;
  let code = fallbackCode;
  // CREATE-Verstöße sind Eingabevalidierung → 400 Bad Request
  if (opts.kind === "create" && /Samstag|Sonntag|Feiertag|3 Monate/i.test(reason)) {
    return sendBadRequest(res, reason);
  }
  if (/gestartete?|gestartet sind/i.test(reason)) code = "APPOINTMENT_STARTED";
  else if (/Lock|gesperrt|Leistungsnachweis/i.test(reason)) code = "APPOINTMENT_LOCKED";
  else if (/Monat ist bereits abgeschlossen|Monatsabschluss|Geschäftsführung/i.test(reason)) code = "MONTH_CLOSED";
  else if (/zugewiesen|Zugriff|deaktiviert|Rolle|Erstberater/i.test(reason)) code = "ACCESS_DENIED";
  else if (/Status|abgeschlossen|stornier|abgelaufen/i.test(reason)) code = "INVALID_STATUS";
  sendForbidden(res, code, reason);
}

router.post("/:id/start", asyncHandler("Fehler beim Starten des Besuchs", async (req, res) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const appointment = await storage.getAppointment(id);
  if (!appointment) return sendNotFound(res, ErrorMessages.appointmentNotFound);

  const flags = await loadPolicyFlags(id, appointment);
  const policyAppt = toPolicyAppointment(appointment, flags);
  const decision = policyCanDocument(toPolicyUser(req.user!), policyAppt);
  if (!decision.allowed) return denyByPolicy(res, decision, "ACCESS_DENIED");
  if (appointment.status !== "scheduled") {
    return sendForbidden(res, "INVALID_STATUS", "Nur geplante Termine können gestartet werden");
  }

  const updatedAppointment = await storage.updateAppointment(id, {
    status: "in-progress",
    actualStart: currentTimeHHMMSS(),
  });

  res.json(updatedAppointment);
}));

router.post("/:id/end", asyncHandler("Fehler beim Beenden des Besuchs", async (req, res) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const appointment = await storage.getAppointment(id);
  if (!appointment) return sendNotFound(res, ErrorMessages.appointmentNotFound);

  const flags = await loadPolicyFlags(id, appointment);
  const policyAppt = toPolicyAppointment(appointment, flags);
  const decision = policyCanDocument(toPolicyUser(req.user!), policyAppt);
  if (!decision.allowed) return denyByPolicy(res, decision, "ACCESS_DENIED");
  if (appointment.status !== "in-progress") {
    return sendForbidden(res, "INVALID_STATUS", "Nur laufende Termine können beendet werden");
  }
  
  const updatedAppointment = await storage.updateAppointment(id, {
    status: "documenting",
    actualEnd: currentTimeHHMMSS(),
  });

  if (appointment.date) {
    const employeeId = appointment.assignedEmployeeId || appointment.performedByEmployeeId;
    if (employeeId) {
      checkAndRecalcDailyAutoBreak(employeeId, appointment.date);
    }
  }
  
  res.json(updatedAppointment);
}));

router.get("/:id/travel-suggestion", asyncHandler("Fehler beim Laden der Fahrvorschläge", async (req, res) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;
  
  const appointment = await storage.getAppointmentWithCustomer(id);
  if (!appointment) {
    return sendNotFound(res, ErrorMessages.appointmentNotFound);
  }
  
  const user = req.user!;
  const targetEmployeeId = appointment.assignedEmployeeId ?? appointment.performedByEmployeeId ?? user.id;
  const sameDayAppointments = await storage.getAppointmentsWithCustomers(appointment.date, undefined, targetEmployeeId);
  
  const appointmentsWithNames = sameDayAppointments.map(apt => ({
    ...apt,
    customerName: apt.customer?.name
  }));
  
  const suggestion = suggestTravelOrigin(appointment, appointmentsWithNames);

  let suggestedKilometers: number | null = null;
  let suggestedMinutes: number | null = null;

  const destCustomer = appointment.customer;
  if (destCustomer?.latitude && destCustomer?.longitude) {
    if (suggestion.suggestedOrigin === "home") {
      const company = await getCachedCompanySettings();
      if (company?.latitude && company?.longitude) {
        const route = await calculateRoute(company.latitude, company.longitude, destCustomer.latitude, destCustomer.longitude);
        if (route) {
          suggestedKilometers = route.distanceKm;
          suggestedMinutes = route.durationMinutes;
        }
      }
    } else if (suggestion.previousAppointment) {
      const prevAppointment = await storage.getAppointmentWithCustomer(suggestion.previousAppointment.id);
      const prevCustomer = prevAppointment?.customer;
      if (prevCustomer?.latitude && prevCustomer?.longitude) {
        const route = await calculateRoute(prevCustomer.latitude, prevCustomer.longitude, destCustomer.latitude, destCustomer.longitude);
        if (route) {
          suggestedKilometers = route.distanceKm;
          suggestedMinutes = route.durationMinutes;
        }
      }
    }
  }
  
  res.json({
    suggestedOrigin: suggestion.suggestedOrigin,
    previousAppointmentId: suggestion.previousAppointment?.id ?? null,
    previousCustomerName: suggestion.previousCustomerName ?? null,
    suggestedKilometers,
    suggestedMinutes,
  });
}));

router.get("/:id/route-calculation", asyncHandler("Fehler bei der Routenberechnung", async (req, res) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const originType = req.query.originType as string;
  const fromAppointmentId = req.query.fromAppointmentId ? parseInt(req.query.fromAppointmentId as string) : null;

  if (!originType || !["home", "appointment"].includes(originType)) {
    return sendBadRequest(res, "Ungültiger Origin-Typ");
  }

  const appointment = await storage.getAppointmentWithCustomer(id);
  if (!appointment) {
    return sendNotFound(res, ErrorMessages.appointmentNotFound);
  }

  let prevAppointment: Awaited<ReturnType<typeof storage.getAppointmentWithCustomer>> | null = null;
  if (originType === "appointment" && fromAppointmentId) {
    prevAppointment = await storage.getAppointmentWithCustomer(fromAppointmentId);
    if (!prevAppointment) {
      return sendBadRequest(res, "Ungültiger Vorgänger-Termin");
    }
    const targetEmployeeId = appointment.assignedEmployeeId ?? appointment.performedByEmployeeId;
    const prevEmployeeId = prevAppointment.assignedEmployeeId ?? prevAppointment.performedByEmployeeId;
    if (!targetEmployeeId || !prevEmployeeId || targetEmployeeId !== prevEmployeeId) {
      return sendBadRequest(res, "Vorgänger-Termin gehört nicht zur zuständigen Mitarbeiterin");
    }
  }

  const destCustomer = appointment.customer;
  if (!destCustomer?.latitude || !destCustomer?.longitude) {
    return res.json({ suggestedKilometers: null, suggestedMinutes: null });
  }

  let suggestedKilometers: number | null = null;
  let suggestedMinutes: number | null = null;

  if (originType === "home") {
    const company = await getCachedCompanySettings();
    if (company?.latitude && company?.longitude) {
      const route = await calculateRoute(company.latitude, company.longitude, destCustomer.latitude, destCustomer.longitude);
      if (route) {
        suggestedKilometers = route.distanceKm;
        suggestedMinutes = route.durationMinutes;
      }
    }
  } else if (originType === "appointment" && prevAppointment) {
    const prevCustomer = prevAppointment.customer;
    if (prevCustomer?.latitude && prevCustomer?.longitude) {
      const route = await calculateRoute(prevCustomer.latitude, prevCustomer.longitude, destCustomer.latitude, destCustomer.longitude);
      if (route) {
        suggestedKilometers = route.distanceKm;
        suggestedMinutes = route.durationMinutes;
      }
    }
  }

  res.json({ suggestedKilometers, suggestedMinutes });
}));

router.post("/:id/reopen", asyncHandler("Fehler beim Wiedereröffnen des Termins", async (req, res) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const appointment = await storage.getAppointment(id);
  if (!appointment) return sendNotFound(res, ErrorMessages.appointmentNotFound);

  const flags = await loadPolicyFlags(id, appointment);
  const policyAppt = toPolicyAppointment(appointment, flags);
  const decision = policyCanReopen(toPolicyUser(req.user!), policyAppt);
  if (!decision.allowed) return denyByPolicy(res, decision, "ACCESS_DENIED");

  const transactions = await budgetLedgerStorage.getTransactionsByAppointmentId(id);

  const updatedAppointment = await db.transaction(async (txClient) => {
    for (const tx of transactions) {
      await budgetLedgerStorage.reverseBudgetTransaction(tx.id, req.user!.id, txClient);
    }

    const result = await storage.updateAppointment(id, {
      status: "documenting",
      signatureData: null,
      signatureHash: null,
      signedAt: null,
      signedByUserId: null,
    }, txClient);

    if (!result) {
      throw new Error("Termin konnte nicht zurückgesetzt werden");
    }

    return result;
  });

  const ip = req.ip || req.socket.remoteAddress;
  await auditService.log(
    req.user!.id,
    "appointment_reopened",
    "appointment",
    id,
    {
      customerId: appointment.customerId,
      reversedTransactions: transactions.length,
      hadSignature: !!appointment.signatureData,
    },
    ip
  );

  if (appointment.date) {
    const employeeId = appointment.assignedEmployeeId || appointment.performedByEmployeeId;
    if (employeeId) {
      checkAndRecalcDailyAutoBreak(employeeId, appointment.date);
    }
  }

  res.json(updatedAppointment);
}));

router.use(appointmentDocumentationRouter);

router.delete("/:id", asyncHandler(ErrorMessages.deleteAppointmentFailed, async (req, res) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const appointment = await storage.getAppointment(id);
  if (!appointment) return sendNotFound(res, ErrorMessages.appointmentNotFound);

  const user = req.user!;
  const isAdmin = user.isAdmin;

  const flags = await loadPolicyFlags(id, appointment);
  const policyAppt = toPolicyAppointment(appointment, flags);
  const decision = policyCanDelete(toPolicyUser(user), policyAppt);
  if (!decision.allowed) return denyByPolicy(res, decision, "ACCESS_DENIED");

  if (!isAdmin) {
    // Zusätzliche Service-seitige Validierung (z. B. Folgekosten-Sperren).
    const canDelete = appointmentService.canDeleteAppointment(appointment);
    if (!canDelete.valid) {
      return sendForbidden(res, canDelete.error!, canDelete.message!);
    }
  }
  const isLocked = flags.isLocked;
  const isCompleted = appointment.status === "completed";
  
  const ip = req.ip || req.socket.remoteAddress;

  let reversedTransactions = 0;
  const transactions = await budgetLedgerStorage.getTransactionsByAppointmentId(id);

  if (transactions.length > 0) {
    await db.transaction(async (txClient) => {
      for (const tx of transactions) {
        await budgetLedgerStorage.reverseBudgetTransaction(tx.id, req.user!.id, txClient);
      }
      const deleted = await storage.deleteAppointment(id, txClient);
      if (!deleted) {
        throw new Error("Termin konnte nicht gelöscht werden");
      }
    });
    reversedTransactions = transactions.length;
  } else {
    const deleted = await storage.deleteAppointment(id);
    if (!deleted) {
      return sendServerError(res, ErrorMessages.deleteAppointmentFailed);
    }
  }

  await auditService.log(
    req.user!.id,
    "appointment_deleted",
    "appointment",
    id,
    {
      customerId: appointment.customerId,
      date: appointment.date,
      status: appointment.status,
      adminForceDelete: isAdmin && isCompleted,
      reversedTransactions,
      wasLocked: isLocked,
      actor: { role: actorRole(user) },
    },
    ip
  );

  if (appointment.appointmentType?.trim().toLowerCase() === "erstberatung" && appointment.prospectId) {
    const prospectData = await prospectStorage.getAppointmentData(appointment.prospectId);
    if (prospectData && prospectData.prospect.status === "erstberatung_vereinbart") {
      const hasOtherActiveErstberatung = prospectData.appointments.some(
        (a) => a.appointmentType?.trim().toLowerCase() === "erstberatung" && a.status !== "cancelled"
      );
      if (!hasOtherActiveErstberatung) {
        await db.update(prospects)
          .set({ status: "qualifiziert", updatedAt: new Date() })
          .where(eq(prospects.id, appointment.prospectId));
      }
    }
  }

  if (appointment.date) {
    const employeeId = appointment.assignedEmployeeId || appointment.performedByEmployeeId;
    if (employeeId) {
      checkAndRecalcDailyAutoBreak(employeeId, appointment.date);
    }
  }
  
  res.json({ success: true, message: "Termin erfolgreich gelöscht" });
}));

export default router;
