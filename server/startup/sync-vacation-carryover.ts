import { db } from "../lib/db";
import { eq, and, gte, lte, isNull, inArray } from "drizzle-orm";
import { users, employeeVacationAllowance, employeeTimeEntries } from "@shared/schema";
import { calculateCarryOverDays } from "@shared/domain/vacation";
import { todayISO } from "@shared/utils/datetime";
import { log } from "../lib/log";
import {
  getVacationEntitlementHistoryForUsers,
  computeAnnualEntitlement,
} from "../storage/time-tracking/vacation";

export async function syncVacationCarryover(): Promise<number> {
  const currentYear = new Date().getFullYear();
  const today = todayISO();
  const prevYearStart = `${currentYear - 1}-01-01`;
  const prevYearEnd = `${currentYear - 1}-12-31`;

  const activeEmployees = await db.select({
    id: users.id,
    vacationDaysPerYear: users.vacationDaysPerYear,
    eintrittsdatum: users.eintrittsdatum,
  })
    .from(users)
    .where(
      and(
        eq(users.employmentStatus, "aktiv"),
        eq(users.isActive, true),
      )
    );

  if (activeEmployees.length === 0) return 0;

  const userIds = activeEmployees.map(e => e.id);
  const existingAllowances = await db.select()
    .from(employeeVacationAllowance)
    .where(
      and(
        inArray(employeeVacationAllowance.userId, userIds),
        eq(employeeVacationAllowance.year, currentYear),
      )
    );
  const hasAllowanceSet = new Set(existingAllowances.map(a => a.userId));

  const employeesNeedingSync = activeEmployees.filter(e => !hasAllowanceSet.has(e.id));
  if (employeesNeedingSync.length === 0) return 0;

  const needingSyncIds = employeesNeedingSync.map(e => e.id);

  const [prevYearAllowances, prevYearEntries, historyMap] = await Promise.all([
    db.select()
      .from(employeeVacationAllowance)
      .where(
        and(
          inArray(employeeVacationAllowance.userId, needingSyncIds),
          eq(employeeVacationAllowance.year, currentYear - 1),
        )
      ),
    db.select({
      userId: employeeTimeEntries.userId,
    })
      .from(employeeTimeEntries)
      .where(
        and(
          inArray(employeeTimeEntries.userId, needingSyncIds),
          eq(employeeTimeEntries.entryType, "urlaub"),
          isNull(employeeTimeEntries.deletedAt),
          gte(employeeTimeEntries.entryDate, prevYearStart),
          lte(employeeTimeEntries.entryDate, prevYearEnd),
        )
      ),
    getVacationEntitlementHistoryForUsers(needingSyncIds),
  ]);

  const prevAllowanceMap = new Map(prevYearAllowances.map(a => [a.userId, a]));

  const prevYearUsedMap = new Map<number, number>();
  for (const entry of prevYearEntries) {
    prevYearUsedMap.set(entry.userId, (prevYearUsedMap.get(entry.userId) ?? 0) + 1);
  }

  let synced = 0;
  for (const emp of employeesNeedingSync) {
    const vacDays = emp.vacationDaysPerYear ?? 30;
    const eintritt = emp.eintrittsdatum ?? null;
    const history = historyMap.get(emp.id) ?? [];

    const prevAllowance = prevAllowanceMap.get(emp.id);
    let prevEntitlement: number;
    if (history.length > 0) {
      // History-basierte Berechnung des Vorjahresanspruchs (anteilig). Plus
      // ggf. existierender Übertrag aus dem Vorjahres-Cache.
      prevEntitlement = computeAnnualEntitlement(history, vacDays, eintritt, currentYear - 1)
        + (prevAllowance ? prevAllowance.carryOverDays : 0);
    } else if (prevAllowance) {
      // Drizzle numeric -> string; Number() ist sicher, weil Schema validiert.
      const prevTotal = typeof prevAllowance.totalDays === "string"
        ? Number(prevAllowance.totalDays)
        : prevAllowance.totalDays;
      prevEntitlement = prevTotal + prevAllowance.carryOverDays;
    } else {
      prevEntitlement = computeAnnualEntitlement([], vacDays, eintritt, currentYear - 1);
    }

    const prevUsed = prevYearUsedMap.get(emp.id) ?? 0;
    const unusedFromPrevYear = Math.max(0, prevEntitlement - prevUsed);
    const carryOverDays = calculateCarryOverDays(unusedFromPrevYear, currentYear, today);

    const totalDays = computeAnnualEntitlement(history, vacDays, eintritt, currentYear);

    try {
      const result = await db.insert(employeeVacationAllowance).values({
        userId: emp.id,
        year: currentYear,
        totalDays: totalDays.toFixed(2),
        carryOverDays,
        notes: carryOverDays > 0
          ? `Automatischer Übertrag: ${carryOverDays} Tage aus ${currentYear - 1}`
          : null,
      }).onConflictDoNothing().returning();
      if (result.length > 0) synced++;
    } catch (err) {
      log(`Urlaubsübertrag-Fehler bei Mitarbeiter ${emp.id}: ${err}`, "startup");
    }
  }

  return synced;
}
