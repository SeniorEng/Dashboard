import { eq, and, gte, lte, inArray, isNull } from "drizzle-orm";
import {
  employeeTimeEntries,
  employeeVacationAllowance,
  users,
  type EmployeeVacationAllowance,
  type InsertVacationAllowance,
} from "@shared/schema";
import type { VacationSummary } from "@shared/api";
import { getVacationEntitlement, calculateCarryOverDays } from "@shared/domain/vacation";
import { todayISO } from "@shared/utils/datetime";
import { db } from "../../lib/db";

export async function getVacationAllowance(
  userId: number,
  year: number,
): Promise<EmployeeVacationAllowance | undefined> {
  const results = await db
    .select()
    .from(employeeVacationAllowance)
    .where(
      and(
        eq(employeeVacationAllowance.userId, userId),
        eq(employeeVacationAllowance.year, year),
      ),
    );
  return results[0];
}

export async function setVacationAllowance(
  data: InsertVacationAllowance,
): Promise<EmployeeVacationAllowance> {
  const existing = await getVacationAllowance(data.userId, data.year);

  if (existing) {
    const results = await db
      .update(employeeVacationAllowance)
      .set({
        totalDays: data.totalDays,
        carryOverDays: data.carryOverDays,
        notes: data.notes,
        updatedAt: new Date(),
      })
      .where(eq(employeeVacationAllowance.id, existing.id))
      .returning();
    return results[0];
  }

  const results = await db
    .insert(employeeVacationAllowance)
    .values({
      userId: data.userId,
      year: data.year,
      totalDays: data.totalDays,
      carryOverDays: data.carryOverDays,
      notes: data.notes,
    })
    .returning();
  return results[0];
}

export async function getVacationSummary(
  userId: number,
  year: number,
): Promise<VacationSummary> {
  const startDate = `${year}-01-01`;
  const endDate = `${year}-12-31`;
  const today = todayISO();

  const [userResult, allowanceResult, prevAllowanceResult, absenceEntries, prevYearAbsence] = await Promise.all([
    db.select({
      eintrittsdatum: users.eintrittsdatum,
      vacationDaysPerYear: users.vacationDaysPerYear,
    }).from(users).where(eq(users.id, userId)).then(r => r[0]),
    getVacationAllowance(userId, year),
    getVacationAllowance(userId, year - 1),
    db.select({
      entryType: employeeTimeEntries.entryType,
      entryDate: employeeTimeEntries.entryDate,
    })
      .from(employeeTimeEntries)
      .where(
        and(
          eq(employeeTimeEntries.userId, userId),
          inArray(employeeTimeEntries.entryType, ['urlaub', 'krankheit']),
          gte(employeeTimeEntries.entryDate, startDate),
          lte(employeeTimeEntries.entryDate, endDate),
          isNull(employeeTimeEntries.deletedAt),
        ),
      ),
    db.select({
      entryType: employeeTimeEntries.entryType,
      entryDate: employeeTimeEntries.entryDate,
    })
      .from(employeeTimeEntries)
      .where(
        and(
          eq(employeeTimeEntries.userId, userId),
          eq(employeeTimeEntries.entryType, 'urlaub'),
          gte(employeeTimeEntries.entryDate, `${year - 1}-01-01`),
          lte(employeeTimeEntries.entryDate, `${year - 1}-12-31`),
          isNull(employeeTimeEntries.deletedAt),
        ),
      ),
  ]);

  const vacationDaysPerYear = userResult?.vacationDaysPerYear ?? 30;
  const eintrittsdatum = userResult?.eintrittsdatum ?? null;

  const entitlement = allowanceResult
    ? allowanceResult.totalDays
    : getVacationEntitlement(vacationDaysPerYear, eintrittsdatum, year);

  let prevYearUsed = 0;
  for (const entry of prevYearAbsence) {
    if (entry.entryType === 'urlaub') prevYearUsed++;
  }

  const prevEntitlement = prevAllowanceResult
    ? prevAllowanceResult.totalDays + prevAllowanceResult.carryOverDays
    : getVacationEntitlement(vacationDaysPerYear, eintrittsdatum, year - 1);

  const unusedFromPrevYear = Math.max(0, prevEntitlement - prevYearUsed);
  const rawCarryOver = allowanceResult
    ? allowanceResult.carryOverDays
    : calculateCarryOverDays(unusedFromPrevYear, year, today);
  const carryOverDays = calculateCarryOverDays(rawCarryOver, year, today);

  let usedDays = 0;
  let plannedDays = 0;
  let sickDays = 0;

  for (const entry of absenceEntries) {
    if (entry.entryType === 'urlaub') {
      if (entry.entryDate <= today) {
        usedDays++;
      } else {
        plannedDays++;
      }
    } else {
      sickDays++;
    }
  }

  const totalAvailable = entitlement + carryOverDays;
  const remainingDays = totalAvailable - usedDays - plannedDays;

  return {
    year,
    totalDays: entitlement,
    carryOverDays,
    usedDays,
    plannedDays,
    remainingDays,
    sickDays,
  };
}
