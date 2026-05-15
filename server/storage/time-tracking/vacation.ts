import { eq, and, gte, lte, inArray, isNull } from "drizzle-orm";
import {
  employeeTimeEntries,
  employeeVacationAllowance,
  vacationEntitlementHistory,
  users,
  type EmployeeVacationAllowance,
  type InsertVacationAllowance,
  type VacationEntitlementHistory,
  type InsertVacationEntitlementHistory,
} from "@shared/schema";
import type { VacationSummary } from "@shared/api";
import {
  getVacationEntitlement,
  calculateCarryOverDays,
  calculateAnnualEntitlementWithHistory,
  summarizeMonthlyBreakdown,
  type VacationEntitlementHistoryEntry,
} from "@shared/domain/vacation";
import { todayISO } from "@shared/utils/datetime";
import { db } from "../../lib/db";
import { employeeTimeEntriesRepo } from "../../repos";

// Drizzles `numeric`-Typ liefert Strings; nach außen geben wir reine Zahlen weiter.
function normalizeAllowance(row: typeof employeeVacationAllowance.$inferSelect): EmployeeVacationAllowance {
  return {
    ...row,
    totalDays: typeof row.totalDays === "string" ? Number(row.totalDays) : row.totalDays,
  } as unknown as EmployeeVacationAllowance;
}

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
  return results[0] ? normalizeAllowance(results[0]) : undefined;
}

export async function setVacationAllowance(
  data: InsertVacationAllowance,
): Promise<EmployeeVacationAllowance> {
  const existing = await getVacationAllowance(data.userId, data.year);

  // numeric-Spalte akzeptiert in Drizzle string|number — wir geben Strings rein,
  // damit die Nachkommastellen erhalten bleiben.
  const totalDaysAsString = data.totalDays.toFixed(2);

  if (existing) {
    const results = await db
      .update(employeeVacationAllowance)
      .set({
        totalDays: totalDaysAsString,
        carryOverDays: data.carryOverDays,
        notes: data.notes,
        updatedAt: new Date(),
      })
      .where(eq(employeeVacationAllowance.id, existing.id))
      .returning();
    return normalizeAllowance(results[0]);
  }

  const results = await db
    .insert(employeeVacationAllowance)
    .values({
      userId: data.userId,
      year: data.year,
      totalDays: totalDaysAsString,
      carryOverDays: data.carryOverDays,
      notes: data.notes,
    })
    .returning();
  return normalizeAllowance(results[0]);
}

// ============================================
// Vacation Entitlement History
// ============================================

export async function getVacationEntitlementHistoryForUser(
  userId: number,
): Promise<VacationEntitlementHistory[]> {
  return await db
    .select()
    .from(vacationEntitlementHistory)
    .where(eq(vacationEntitlementHistory.userId, userId));
}

export async function getVacationEntitlementHistoryForUsers(
  userIds: number[],
): Promise<Map<number, VacationEntitlementHistory[]>> {
  const map = new Map<number, VacationEntitlementHistory[]>();
  if (userIds.length === 0) return map;
  const rows = await db
    .select()
    .from(vacationEntitlementHistory)
    .where(inArray(vacationEntitlementHistory.userId, userIds));
  for (const row of rows) {
    const list = map.get(row.userId) ?? [];
    list.push(row);
    map.set(row.userId, list);
  }
  return map;
}

/**
 * Upsert auf `(userId, validFromYear, validFromMonth)`. Wenn im selben Monat
 * mehrfach geändert wird, gewinnt der letzte Wert (Spec VAC-PRO-8).
 */
export async function upsertVacationEntitlementHistory(
  data: InsertVacationEntitlementHistory,
): Promise<VacationEntitlementHistory> {
  const results = await db
    .insert(vacationEntitlementHistory)
    .values({
      userId: data.userId,
      validFromYear: data.validFromYear,
      validFromMonth: data.validFromMonth,
      daysPerYear: data.daysPerYear,
      createdBy: data.createdBy ?? null,
    })
    .onConflictDoUpdate({
      target: [
        vacationEntitlementHistory.userId,
        vacationEntitlementHistory.validFromYear,
        vacationEntitlementHistory.validFromMonth,
      ],
      set: {
        daysPerYear: data.daysPerYear,
        createdBy: data.createdBy ?? null,
      },
    })
    .returning();
  return results[0];
}

function toHistoryEntries(rows: VacationEntitlementHistory[]): VacationEntitlementHistoryEntry[] {
  return rows.map(r => ({
    validFromYear: r.validFromYear,
    validFromMonth: r.validFromMonth,
    daysPerYear: r.daysPerYear,
  }));
}

/**
 * Liefert den effektiven Jahresanspruch für `year` — bevorzugt aus dem
 * History-Helper, mit Fallback auf bestehende `getVacationEntitlement`-Logik.
 */
export function computeAnnualEntitlement(
  history: VacationEntitlementHistory[],
  vacationDaysPerYear: number,
  eintrittsdatum: string | null,
  year: number,
): number {
  return calculateAnnualEntitlementWithHistory(
    toHistoryEntries(history),
    eintrittsdatum,
    year,
    vacationDaysPerYear,
  );
}

export async function getVacationSummary(
  userId: number,
  year: number,
): Promise<VacationSummary> {
  const startDate = `${year}-01-01`;
  const endDate = `${year}-12-31`;
  const today = todayISO();

  // `employeeVacationAllowance` ist die autoritative Quelle für Jahres-Anspruch
  // und Carry-Over (wird beim Patchen von `vacationDaysPerYear` und durch den
  // Startup-Job `syncVacationCarryover` synchron mit der History gepflegt).
  // Die History wird hier nur noch für die Antwortfelder
  // `entitlementHistory` und `monthlyBreakdown` sowie als Fallback für
  // Mitarbeiter ohne Allowance-Eintrag geladen.
  const [userResult, allowanceResult, absenceEntries, history] = await Promise.all([
    db.select({
      eintrittsdatum: users.eintrittsdatum,
      vacationDaysPerYear: users.vacationDaysPerYear,
    }).from(users).where(eq(users.id, userId)).then(r => r[0]),
    getVacationAllowance(userId, year),
    employeeTimeEntriesRepo.selectColumnsFrom({
      entryType: employeeTimeEntries.entryType,
      entryDate: employeeTimeEntries.entryDate,
    }, db)
      .where(
        and(
          eq(employeeTimeEntries.userId, userId),
          inArray(employeeTimeEntries.entryType, ['urlaub', 'krankheit']),
          gte(employeeTimeEntries.entryDate, startDate),
          lte(employeeTimeEntries.entryDate, endDate),
          isNull(employeeTimeEntries.deletedAt),
        ),
      ),
    getVacationEntitlementHistoryForUser(userId),
  ]);

  const vacationDaysPerYear = userResult?.vacationDaysPerYear ?? 30;
  const eintrittsdatum = userResult?.eintrittsdatum ?? null;

  let entitlement: number;
  let rawCarryOver: number;

  if (allowanceResult) {
    // Schneller Standardpfad: Allowance ist autoritativ.
    entitlement = Number(allowanceResult.totalDays);
    rawCarryOver = allowanceResult.carryOverDays;
  } else {
    // Legacy-Fallback: kein Allowance-Eintrag (z.B. neuer Mitarbeiter, bei dem
    // `syncVacationCarryover` noch nicht lief). Anspruch und Carry-Over werden
    // wie bisher aus History bzw. Vorjahres-Buchungen rekonstruiert.
    const fallback = await computeFallbackEntitlementAndCarryOver(
      userId,
      year,
      today,
      history,
      vacationDaysPerYear,
      eintrittsdatum,
    );
    entitlement = fallback.entitlement;
    rawCarryOver = fallback.rawCarryOver;
  }

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
  const remainingDays = Math.round((totalAvailable - usedDays - plannedDays) * 100) / 100;

  const historyEntries = toHistoryEntries(history);
  const monthlyBreakdown = summarizeMonthlyBreakdown(
    historyEntries,
    eintrittsdatum,
    year,
    vacationDaysPerYear,
  );

  return {
    year,
    totalDays: Math.round(entitlement * 100) / 100,
    configuredAnnualDays: vacationDaysPerYear,
    eintrittsdatum,
    entitlementHistory: historyEntries,
    monthlyBreakdown,
    carryOverDays,
    usedDays,
    plannedDays,
    remainingDays,
    sickDays,
  };
}

/**
 * Legacy-Fallback (Task #413): rekonstruiert Jahres-Anspruch + Carry-Over
 * aus History und Vorjahres-Buchungen. Wird nur genutzt, wenn kein
 * `employeeVacationAllowance`-Eintrag für `year` existiert. Im Normalbetrieb
 * sorgt `syncVacationCarryover` (server/startup/sync-vacation-carryover.ts)
 * dafür, dass dieser Pfad nicht erreicht wird.
 */
async function computeFallbackEntitlementAndCarryOver(
  userId: number,
  year: number,
  today: string,
  history: VacationEntitlementHistory[],
  vacationDaysPerYear: number,
  eintrittsdatum: string | null,
): Promise<{ entitlement: number; rawCarryOver: number }> {
  const [prevAllowanceResult, prevYearAbsence] = await Promise.all([
    getVacationAllowance(userId, year - 1),
    employeeTimeEntriesRepo.selectColumnsFrom({
      entryType: employeeTimeEntries.entryType,
      entryDate: employeeTimeEntries.entryDate,
    }, db)
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

  const entitlement = history.length > 0
    ? computeAnnualEntitlement(history, vacationDaysPerYear, eintrittsdatum, year)
    : getVacationEntitlement(vacationDaysPerYear, eintrittsdatum, year);

  let prevYearUsed = 0;
  for (const entry of prevYearAbsence) {
    if (entry.entryType === 'urlaub') prevYearUsed++;
  }

  const prevEntitlement = history.length > 0
    ? computeAnnualEntitlement(history, vacationDaysPerYear, eintrittsdatum, year - 1)
      + (prevAllowanceResult?.carryOverDays ?? 0)
    : (prevAllowanceResult
        ? Number(prevAllowanceResult.totalDays) + prevAllowanceResult.carryOverDays
        : getVacationEntitlement(vacationDaysPerYear, eintrittsdatum, year - 1));

  const unusedFromPrevYear = Math.max(0, prevEntitlement - prevYearUsed);
  const rawCarryOver = calculateCarryOverDays(unusedFromPrevYear, year, today);

  return { entitlement, rawCarryOver };
}
