import { Router, Request, Response } from "express";
import { authService } from "../../services/auth";
import { usersCache, birthdaysCache, customerIdsCache } from "../../services/cache";
import { log } from "../../lib/log";
import { sanitizeUser } from "../../utils/sanitize-user";
import { 
  users,
  userRoles,
  appointments,
  customers,
  prospects,
  employeeTimeEntries,
  customerAssignmentHistory,
} from "@shared/schema";
import { timeToMinutes, minutesToTimeDisplay, todayISO } from "@shared/utils/datetime";
import { loadEmployeesWeeklyAvailability, buildDateRange } from "../../services/employee-availability";
import { asyncHandler } from "../../lib/errors";
import { requireIntParam } from "../../lib/params";
import { auditService } from "../../services/audit";
import { db } from "../../lib/db";
import { loadTeamWorkload, getGlobalAvgHoursPerCustomerPerMonth } from "../../lib/team-workload";
import { eq, and, isNull, inArray, sql, asc } from "drizzle-orm";
import { z } from "zod";

const router = Router();

router.get("/employees", asyncHandler("Mitarbeiter konnten nicht geladen werden", async (_req: Request, res: Response) => {
  const cached = usersCache.getActiveEmployees();
  if (cached) {
    return res.json(cached);
  }

  const employees = await authService.getActiveEmployees();
  const safeEmployees = employees.map(sanitizeUser);
  
  usersCache.setActiveEmployees(safeEmployees);
  
  res.json(safeEmployees);
}));

function computeFreeSlots(
  availability: { startTime: string | null; endTime: string | null }[],
  blockedSlots: { start: number; end: number }[]
): { start: string; end: string }[] {
  if (availability.length === 0) return [];
  
  const freeSlots: { start: string; end: string }[] = [];
  
  for (const slot of availability) {
    if (!slot.startTime || !slot.endTime) continue;
    const slotStart = timeToMinutes(slot.startTime);
    const slotEnd = timeToMinutes(slot.endTime);
    
    const relevantBlocks = blockedSlots
      .filter(b => b.start < slotEnd && b.end > slotStart)
      .sort((a, b) => a.start - b.start);
    
    let cursor = slotStart;
    for (const block of relevantBlocks) {
      if (block.start > cursor) {
        freeSlots.push({ start: minutesToHHMM(cursor), end: minutesToHHMM(block.start) });
      }
      cursor = Math.max(cursor, block.end);
    }
    if (cursor < slotEnd) {
      freeSlots.push({ start: minutesToHHMM(cursor), end: minutesToHHMM(slotEnd) });
    }
  }
  
  return freeSlots;
}

function minutesToHHMM(mins: number): string {
  return minutesToTimeDisplay(((mins % 1440) + 1440) % 1440);
}

function collectBlockedSlots(
  dayAppointments: { scheduledStart: string | null; scheduledEnd: string | null; durationMinutes: number | null }[],
  dayTimeEntries: { startTime: string | null; endTime: string | null }[],
  dayBlockers: { startTime: string | null; endTime: string | null }[],
): { start: number; end: number }[] {
  const blockedSlots: { start: number; end: number }[] = [];
  for (const appt of dayAppointments) {
    if (appt.scheduledStart) {
      const s = timeToMinutes(appt.scheduledStart);
      const e = appt.scheduledEnd ? timeToMinutes(appt.scheduledEnd) : s + (appt.durationMinutes || 60);
      blockedSlots.push({ start: s, end: e });
    }
  }
  for (const te of dayTimeEntries) {
    if (te.startTime && te.endTime) {
      blockedSlots.push({
        start: timeToMinutes(te.startTime.slice(0, 5)),
        end: timeToMinutes(te.endTime.slice(0, 5)),
      });
    }
  }
  for (const blocker of dayBlockers) {
    if (blocker.startTime && blocker.endTime) {
      blockedSlots.push({
        start: timeToMinutes(blocker.startTime.slice(0, 5)),
        end: timeToMinutes(blocker.endTime.slice(0, 5)),
      });
    }
  }
  return blockedSlots;
}

function isValidCalendarDate(dateStr: string): boolean {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

router.get("/employees/weekly-availability", asyncHandler("Wochen-Verfügbarkeit konnte nicht geladen werden", async (req: Request, res: Response) => {
  const { startDate, days: daysParam, allEmployees: allEmployeesParam } = req.query;
  if (!startDate || typeof startDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !isValidCalendarDate(startDate)) {
    return res.status(400).json({ error: "Gültiges startDate im Format YYYY-MM-DD erforderlich" });
  }
  const days = Math.min(Math.max(parseInt(daysParam as string) || 5, 1), 7);
  const showAllEmployees = allEmployeesParam === "true";

  const dates = buildDateRange(startDate, days);

  let employeeIds: number[];
  if (showAllEmployees) {
    const activeEmployees = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.isActive, true));
    employeeIds = activeEmployees.map(e => e.id);
  } else {
    const erstberatungEmployeeIds = await db
      .select({ userId: userRoles.userId })
      .from(userRoles)
      .where(eq(userRoles.role, "erstberatung"));
    employeeIds = erstberatungEmployeeIds.map(e => e.userId);
  }

  const result = await loadEmployeesWeeklyAvailability(employeeIds, dates);
  res.json(result);
}));

// Legacy implementation removed — see loadEmployeesWeeklyAvailability in server/services/employee-availability.ts.

router.get("/employees/availability", asyncHandler("Verfügbarkeiten konnten nicht geladen werden", async (req: Request, res: Response) => {
  const { date } = req.query;
  if (!date || typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: "Gültiges Datum im Format YYYY-MM-DD erforderlich" });
  }

  const erstberatungEmployeeIds = await db
    .select({ userId: userRoles.userId })
    .from(userRoles)
    .where(eq(userRoles.role, "erstberatung"));

  const employeeIds = erstberatungEmployeeIds.map(e => e.userId);
  if (employeeIds.length === 0) {
    return res.json([]);
  }

  const [employeeData, availabilityEntries, absenceEntries, dayAppointments, timeEntries, blockerEntries] = await Promise.all([
    db.select({
      id: users.id,
      displayName: users.displayName,
      vorname: users.vorname,
      nachname: users.nachname,
    })
    .from(users)
    .where(and(
      inArray(users.id, employeeIds),
      eq(users.isActive, true)
    )),

    db.select({
      userId: employeeTimeEntries.userId,
      startTime: employeeTimeEntries.startTime,
      endTime: employeeTimeEntries.endTime,
    })
    .from(employeeTimeEntries)
    .where(and(
      inArray(employeeTimeEntries.userId, employeeIds),
      eq(employeeTimeEntries.entryDate, date),
      eq(employeeTimeEntries.entryType, "verfuegbar"),
      isNull(employeeTimeEntries.deletedAt)
    ))
    .orderBy(asc(employeeTimeEntries.startTime)),

    db.select({
      userId: employeeTimeEntries.userId,
      entryType: employeeTimeEntries.entryType,
    })
    .from(employeeTimeEntries)
    .where(and(
      inArray(employeeTimeEntries.userId, employeeIds),
      eq(employeeTimeEntries.entryDate, date),
      inArray(employeeTimeEntries.entryType, ["urlaub", "krankheit"]),
      isNull(employeeTimeEntries.deletedAt)
    )),

    db.select({
      assignedEmployeeId: appointments.assignedEmployeeId,
      scheduledStart: appointments.scheduledStart,
      scheduledEnd: appointments.scheduledEnd,
      durationPromised: appointments.durationPromised,
      customerName: sql`COALESCE(
        ${customers.vorname} || ' ' || ${customers.nachname},
        ${customers.name},
        ${prospects.vorname} || ' ' || ${prospects.nachname},
        'Erstberatung'
      )`.as("customer_name"),
    })
    .from(appointments)
    .leftJoin(customers, eq(appointments.customerId, customers.id))
    .leftJoin(prospects, eq(appointments.prospectId, prospects.id))
    .where(and(
      inArray(appointments.assignedEmployeeId, employeeIds),
      eq(appointments.date, date),
      isNull(appointments.deletedAt),
      sql`${appointments.status} != 'cancelled'`
    ))
    .orderBy(asc(appointments.scheduledStart)),

    db.select({
      userId: employeeTimeEntries.userId,
      startTime: employeeTimeEntries.startTime,
      endTime: employeeTimeEntries.endTime,
    })
    .from(employeeTimeEntries)
    .where(and(
      inArray(employeeTimeEntries.userId, employeeIds),
      eq(employeeTimeEntries.entryDate, date),
      inArray(employeeTimeEntries.entryType, ["arbeitszeit", "pause", "fahrt"]),
      isNull(employeeTimeEntries.deletedAt)
    )),

    db.select({
      userId: employeeTimeEntries.userId,
      startTime: employeeTimeEntries.startTime,
      endTime: employeeTimeEntries.endTime,
      isFullDay: employeeTimeEntries.isFullDay,
    })
    .from(employeeTimeEntries)
    .where(and(
      inArray(employeeTimeEntries.userId, employeeIds),
      eq(employeeTimeEntries.entryDate, date),
      eq(employeeTimeEntries.entryType, "blocker"),
      isNull(employeeTimeEntries.deletedAt)
    )),
  ]);

  const result = employeeData.map(emp => {
    const availability = availabilityEntries
      .filter(a => a.userId === emp.id)
      .map(a => ({
        startTime: a.startTime?.slice(0, 5) || null,
        endTime: a.endTime?.slice(0, 5) || null,
      }));

    const existingAppointments = dayAppointments
      .filter(a => a.assignedEmployeeId === emp.id)
      .map(a => ({
        scheduledStart: a.scheduledStart?.slice(0, 5) || null,
        scheduledEnd: a.scheduledEnd?.slice(0, 5) || null,
        durationMinutes: a.durationPromised,
        customerName: String(a.customerName),
      }));

    const absence = absenceEntries.find(a => a.userId === emp.id);

    const dayTimeEntries = timeEntries
      .filter(t => t.userId === emp.id && t.startTime && t.endTime);

    const dayBlockers = blockerEntries
      .filter(b => b.userId === emp.id);

    const hasFullDayBlocker = dayBlockers.some(b => b.isFullDay);

    const blockedSlots = collectBlockedSlots(existingAppointments, dayTimeEntries, dayBlockers);

    const freeSlots = (absence || hasFullDayBlocker) ? [] : computeFreeSlots(availability, blockedSlots);

    return {
      id: emp.id,
      displayName: emp.displayName || `${emp.vorname || ""} ${emp.nachname || ""}`.trim(),
      availability,
      freeSlots,
      appointments: existingAppointments,
      absence: absence ? absence.entryType as "urlaub" | "krankheit" : null,
    };
  });

  result.sort((a, b) => {
    if (a.absence && !b.absence) return 1;
    if (!a.absence && b.absence) return -1;
    if (a.freeSlots.length > 0 && b.freeSlots.length === 0) return -1;
    if (a.freeSlots.length === 0 && b.freeSlots.length > 0) return 1;
    return a.displayName.localeCompare(b.displayName);
  });

  res.json(result);
}));

const handoverSchema = z.object({
  targetEmployeeId: z.number().int().positive(),
});

router.get("/employees/:id/handover-preview", asyncHandler("Übergabe-Vorschau konnte nicht geladen werden", async (req: Request, res: Response) => {
  const sourceId = requireIntParam(req.params.id, res);
  if (sourceId === null) return;
  const targetId = parseInt(req.query.targetEmployeeId as string);
  if (!targetId || isNaN(targetId)) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "targetEmployeeId ist erforderlich" });
    return;
  }

  const sourceEmployee = await authService.getUser(sourceId);
  if (!sourceEmployee) {
    res.status(404).json({ error: "NOT_FOUND", message: "Quell-Mitarbeiter nicht gefunden" });
    return;
  }
  const targetEmployee = await authService.getUser(targetId);
  if (!targetEmployee || !targetEmployee.isActive) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ziel-Mitarbeiter nicht gefunden oder nicht aktiv" });
    return;
  }

  const today = todayISO();

  const [primaryCustomers, backupCustomers, backup2Customers, futureAppointments] = await Promise.all([
    db.select({ id: customers.id, name: customers.name, vorname: customers.vorname, nachname: customers.nachname })
      .from(customers)
      .where(and(eq(customers.primaryEmployeeId, sourceId), isNull(customers.deletedAt))),
    db.select({ id: customers.id, name: customers.name, vorname: customers.vorname, nachname: customers.nachname })
      .from(customers)
      .where(and(eq(customers.backupEmployeeId, sourceId), isNull(customers.deletedAt))),
    db.select({ id: customers.id, name: customers.name, vorname: customers.vorname, nachname: customers.nachname })
      .from(customers)
      .where(and(eq(customers.backupEmployeeId2, sourceId), isNull(customers.deletedAt))),
    db.execute(sql`
      SELECT a.id, a.date, a.scheduled_start AS "startTime", a.scheduled_end AS "endTime",
             c.name AS "customerName", c.vorname AS "customerVorname", c.nachname AS "customerNachname"
      FROM appointments a
      JOIN customers c ON c.id = a.customer_id
      WHERE a.assigned_employee_id = ${sourceId}
        AND a.deleted_at IS NULL
        AND a.status IN ('scheduled', 'in_progress', 'documenting')
        AND a.date >= ${today}
      ORDER BY a.date, a.scheduled_start
    `),
  ]);

  res.json({
    sourceEmployee: { id: sourceId, displayName: sourceEmployee.displayName },
    targetEmployee: { id: targetId, displayName: targetEmployee.displayName },
    primaryCustomers,
    backupCustomers,
    backup2Customers,
    futureAppointments: futureAppointments.rows,
    summary: {
      primaryCount: primaryCustomers.length,
      backupCount: backupCustomers.length,
      backup2Count: backup2Customers.length,
      appointmentCount: futureAppointments.rows.length,
    },
  });
}));

router.post("/employees/:id/handover", asyncHandler("Übergabe konnte nicht durchgeführt werden", async (req: Request, res: Response) => {
  const sourceId = requireIntParam(req.params.id, res);
  if (sourceId === null) return;

  const result = handoverSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "targetEmployeeId ist erforderlich" });
    return;
  }
  const { targetEmployeeId } = result.data;

  if (sourceId === targetEmployeeId) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Quell- und Ziel-Mitarbeiter dürfen nicht identisch sein" });
    return;
  }

  const sourceEmployee = await authService.getUser(sourceId);
  if (!sourceEmployee) {
    res.status(404).json({ error: "NOT_FOUND", message: "Quell-Mitarbeiter nicht gefunden" });
    return;
  }
  const targetEmployee = await authService.getUser(targetEmployeeId);
  if (!targetEmployee || !targetEmployee.isActive) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ziel-Mitarbeiter nicht gefunden oder nicht aktiv" });
    return;
  }

  const today = todayISO();
  const changedByUserId = req.user?.id ?? null;

  const counts = await db.transaction(async (tx) => {
    const affectedPrimary = await tx.select({ id: customers.id, primaryEmployeeId: customers.primaryEmployeeId, backupEmployeeId: customers.backupEmployeeId, backupEmployeeId2: customers.backupEmployeeId2 })
      .from(customers)
      .where(and(eq(customers.primaryEmployeeId, sourceId), isNull(customers.deletedAt)));

    for (const cust of affectedPrimary) {
      await tx.update(customerAssignmentHistory)
        .set({ validTo: today })
        .where(and(
          eq(customerAssignmentHistory.customerId, cust.id),
          eq(customerAssignmentHistory.employeeId, sourceId),
          eq(customerAssignmentHistory.role, "primary"),
          isNull(customerAssignmentHistory.validTo)
        ));
      await tx.insert(customerAssignmentHistory).values({
        customerId: cust.id,
        employeeId: targetEmployeeId,
        role: "primary",
        validFrom: today,
        changedByUserId,
      });
      const updateData: Record<string, number | null> = { primaryEmployeeId: targetEmployeeId };
      if (cust.backupEmployeeId === targetEmployeeId) {
        await tx.update(customerAssignmentHistory)
          .set({ validTo: today })
          .where(and(
            eq(customerAssignmentHistory.customerId, cust.id),
            eq(customerAssignmentHistory.employeeId, targetEmployeeId),
            eq(customerAssignmentHistory.role, "backup"),
            isNull(customerAssignmentHistory.validTo)
          ));
        updateData.backupEmployeeId = null;
      }
      if (cust.backupEmployeeId2 === targetEmployeeId) {
        await tx.update(customerAssignmentHistory)
          .set({ validTo: today })
          .where(and(
            eq(customerAssignmentHistory.customerId, cust.id),
            eq(customerAssignmentHistory.employeeId, targetEmployeeId),
            eq(customerAssignmentHistory.role, "backup2"),
            isNull(customerAssignmentHistory.validTo)
          ));
        updateData.backupEmployeeId2 = null;
      }
      await tx.update(customers).set(updateData).where(eq(customers.id, cust.id));
    }

    const affectedBackup = await tx.select({ id: customers.id, primaryEmployeeId: customers.primaryEmployeeId, backupEmployeeId2: customers.backupEmployeeId2 })
      .from(customers)
      .where(and(eq(customers.backupEmployeeId, sourceId), isNull(customers.deletedAt)));

    for (const cust of affectedBackup) {
      if (cust.primaryEmployeeId === targetEmployeeId) {
        await tx.update(customerAssignmentHistory)
          .set({ validTo: today })
          .where(and(
            eq(customerAssignmentHistory.customerId, cust.id),
            eq(customerAssignmentHistory.employeeId, sourceId),
            eq(customerAssignmentHistory.role, "backup"),
            isNull(customerAssignmentHistory.validTo)
          ));
        await tx.update(customers).set({ backupEmployeeId: null }).where(eq(customers.id, cust.id));
        continue;
      }
      await tx.update(customerAssignmentHistory)
        .set({ validTo: today })
        .where(and(
          eq(customerAssignmentHistory.customerId, cust.id),
          eq(customerAssignmentHistory.employeeId, sourceId),
          eq(customerAssignmentHistory.role, "backup"),
          isNull(customerAssignmentHistory.validTo)
        ));
      await tx.insert(customerAssignmentHistory).values({
        customerId: cust.id,
        employeeId: targetEmployeeId,
        role: "backup",
        validFrom: today,
        changedByUserId,
      });
      const updateData: Record<string, number | null> = { backupEmployeeId: targetEmployeeId };
      if (cust.backupEmployeeId2 === targetEmployeeId) {
        await tx.update(customerAssignmentHistory)
          .set({ validTo: today })
          .where(and(
            eq(customerAssignmentHistory.customerId, cust.id),
            eq(customerAssignmentHistory.employeeId, targetEmployeeId),
            eq(customerAssignmentHistory.role, "backup2"),
            isNull(customerAssignmentHistory.validTo)
          ));
        updateData.backupEmployeeId2 = null;
      }
      await tx.update(customers).set(updateData).where(eq(customers.id, cust.id));
    }

    const affectedBackup2 = await tx.select({ id: customers.id, primaryEmployeeId: customers.primaryEmployeeId, backupEmployeeId: customers.backupEmployeeId })
      .from(customers)
      .where(and(eq(customers.backupEmployeeId2, sourceId), isNull(customers.deletedAt)));

    for (const cust of affectedBackup2) {
      if (cust.primaryEmployeeId === targetEmployeeId || cust.backupEmployeeId === targetEmployeeId) {
        await tx.update(customerAssignmentHistory)
          .set({ validTo: today })
          .where(and(
            eq(customerAssignmentHistory.customerId, cust.id),
            eq(customerAssignmentHistory.employeeId, sourceId),
            eq(customerAssignmentHistory.role, "backup2"),
            isNull(customerAssignmentHistory.validTo)
          ));
        await tx.update(customers).set({ backupEmployeeId2: null }).where(eq(customers.id, cust.id));
        continue;
      }
      await tx.update(customerAssignmentHistory)
        .set({ validTo: today })
        .where(and(
          eq(customerAssignmentHistory.customerId, cust.id),
          eq(customerAssignmentHistory.employeeId, sourceId),
          eq(customerAssignmentHistory.role, "backup2"),
          isNull(customerAssignmentHistory.validTo)
        ));
      await tx.insert(customerAssignmentHistory).values({
        customerId: cust.id,
        employeeId: targetEmployeeId,
        role: "backup2",
        validFrom: today,
        changedByUserId,
      });
      await tx.update(customers).set({ backupEmployeeId2: targetEmployeeId }).where(eq(customers.id, cust.id));
    }

    const appointmentResult = await tx.execute(sql`
      UPDATE appointments
      SET assigned_employee_id = ${targetEmployeeId}
      WHERE assigned_employee_id = ${sourceId}
        AND deleted_at IS NULL
        AND status IN ('scheduled', 'in_progress', 'documenting')
        AND date >= ${today}
    `);

    return {
      primaryCount: affectedPrimary.length,
      backupCount: affectedBackup.length,
      backup2Count: affectedBackup2.length,
      appointmentCount: Number(appointmentResult.rowCount || 0),
    };
  });

  birthdaysCache.invalidateAll();
  usersCache.invalidateAll();
  customerIdsCache.invalidateAll();

  await auditService.log(
    changedByUserId ?? 0,
    "employee_handover",
    "employee",
    sourceId,
    {
      sourceEmployeeId: sourceId,
      sourceEmployeeName: sourceEmployee.displayName,
      targetEmployeeId,
      targetEmployeeName: targetEmployee.displayName,
      ...counts,
    },
    req.ip
  );

  log(`Employee handover: ${sourceEmployee.displayName} → ${targetEmployee.displayName} (${counts.primaryCount} primary, ${counts.backupCount} backup, ${counts.backup2Count} backup2, ${counts.appointmentCount} appointments)`);

  res.json({
    message: "Übergabe erfolgreich durchgeführt",
    ...counts,
  });
}));

router.get("/employees/workload", asyncHandler("Auslastungsdaten konnten nicht geladen werden", async (_req: Request, res: Response) => {
  const [rows, globalAvgHoursPerCustomerPerMonth] = await Promise.all([
    loadTeamWorkload(),
    getGlobalAvgHoursPerCustomerPerMonth(),
  ]);
  const workloadMap: Record<number, { primaryCount: number; backupCount: number; backup2Count: number; avgMonthlyHwMinutes: number; avgMonthlyAllMinutes: number; monthsConsidered: number; monthlyWorkHours: number | null; employmentType: "minijobber" | "sozialversicherungspflichtig" }> = {};
  for (const r of rows) {
    workloadMap[r.employeeId] = {
      primaryCount: r.primaryCount,
      backupCount: r.backupCount,
      backup2Count: r.backup2Count,
      avgMonthlyHwMinutes: r.avgMonthlyHwMinutes,
      avgMonthlyAllMinutes: r.avgMonthlyAllMinutes,
      monthsConsidered: r.monthsConsidered,
      monthlyWorkHours: r.monthlyWorkHours,
      employmentType: r.employmentType,
    };
  }
  res.json({ workload: workloadMap, globalAvgHoursPerCustomerPerMonth });
}));

export default router;
