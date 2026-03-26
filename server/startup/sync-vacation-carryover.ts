import { db } from "../lib/db";
import { eq, and, gte, lte, isNull, inArray } from "drizzle-orm";
import { users, employeeVacationAllowance, employeeTimeEntries } from "@shared/schema";
import { getVacationEntitlement, calculateCarryOverDays } from "@shared/domain/vacation";
import { todayISO } from "@shared/utils/datetime";

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

  const [prevYearAllowances, prevYearEntries] = await Promise.all([
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

    const prevAllowance = prevAllowanceMap.get(emp.id);
    let prevEntitlement: number;
    if (prevAllowance) {
      prevEntitlement = prevAllowance.totalDays + prevAllowance.carryOverDays;
    } else {
      prevEntitlement = getVacationEntitlement(vacDays, eintritt, currentYear - 1);
    }

    const prevUsed = prevYearUsedMap.get(emp.id) ?? 0;
    const unusedFromPrevYear = Math.max(0, prevEntitlement - prevUsed);
    const carryOverDays = calculateCarryOverDays(unusedFromPrevYear, currentYear, today);

    const totalDays = getVacationEntitlement(vacDays, eintritt, currentYear);

    try {
      const result = await db.insert(employeeVacationAllowance).values({
        userId: emp.id,
        year: currentYear,
        totalDays,
        carryOverDays,
        notes: carryOverDays > 0
          ? `Automatischer Übertrag: ${carryOverDays} Tage aus ${currentYear - 1}`
          : null,
      }).onConflictDoNothing().returning();
      if (result.length > 0) synced++;
    } catch (err) {
      console.error(`[vacation-sync] Fehler bei Mitarbeiter ${emp.id}:`, err);
    }
  }

  return synced;
}
