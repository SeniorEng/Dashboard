import { eq, and, isNull } from "drizzle-orm";
import {
  employeeTimeEntries,
  users,
  type EmployeeTimeEntry,
  type InsertTimeEntry,
  type UpdateTimeEntry,
} from "@shared/schema";
import { isWeekend, parseLocalDate, formatDateISO } from "@shared/utils/datetime";
import { db } from "../../lib/db";
import { buildTimeEntryFilterConditions, type TimeEntryFilters } from "./shared";

export async function getTimeEntries(
  userId: number,
  filters?: TimeEntryFilters,
): Promise<EmployeeTimeEntry[]> {
  const conditions = buildTimeEntryFilterConditions({ ...filters, userId });
  conditions.push(isNull(employeeTimeEntries.deletedAt));

  return db
    .select()
    .from(employeeTimeEntries)
    .where(and(...conditions))
    .orderBy(employeeTimeEntries.entryDate);
}

export async function getTimeEntry(id: number): Promise<EmployeeTimeEntry | undefined> {
  const results = await db
    .select()
    .from(employeeTimeEntries)
    .where(and(eq(employeeTimeEntries.id, id), isNull(employeeTimeEntries.deletedAt)));
  return results[0];
}

export async function getTimeEntriesForDate(
  userId: number,
  date: string,
): Promise<EmployeeTimeEntry[]> {
  return db
    .select()
    .from(employeeTimeEntries)
    .where(and(
      eq(employeeTimeEntries.userId, userId),
      eq(employeeTimeEntries.entryDate, date),
      isNull(employeeTimeEntries.deletedAt),
    ))
    .orderBy(employeeTimeEntries.startTime);
}

export async function createTimeEntry(
  userId: number,
  data: InsertTimeEntry,
): Promise<EmployeeTimeEntry> {
  const results = await db
    .insert(employeeTimeEntries)
    .values({
      userId,
      entryType: data.entryType,
      entryDate: data.entryDate,
      startTime: data.startTime || null,
      endTime: data.endTime || null,
      isFullDay: data.isFullDay ?? false,
      durationMinutes: data.durationMinutes || null,
      kilometers: data.kilometers ?? 0,
      notes: data.notes || null,
    })
    .returning();
  return results[0];
}

/**
 * Liefert die Liste der Werktagsdaten zwischen `startDate` und `endDate`
 * (jeweils inklusive) — Wochenenden werden übersprungen.
 *
 * Reine Hilfsfunktion, ohne DB-Zugriff. Nützlich für Mehrtages-
 * Abwesenheits-Eingaben (Urlaub/Krankheit).
 */
export function collectWeekdayDates(startDate: string, endDate: string): string[] {
  const start = parseLocalDate(startDate);
  const end = parseLocalDate(endDate);
  const dates: string[] = [];
  const cursor = new Date(start.getTime());
  while (cursor <= end) {
    const dateStr = formatDateISO(cursor);
    if (!isWeekend(dateStr)) {
      dates.push(dateStr);
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates;
}

/**
 * Erzeugt für jedes Datum aus `dates` einen Zeiteintrag mit den gleichen
 * Basisdaten. Verwendet eine Transaktion, damit die Mehrtages-Anlage
 * atomar bleibt.
 */
export async function createTimeEntriesForDates(
  userId: number,
  dates: string[],
  data: InsertTimeEntry,
): Promise<EmployeeTimeEntry[]> {
  if (dates.length === 0) return [];
  return db.transaction(async (tx) => {
    const created: EmployeeTimeEntry[] = [];
    for (const dateStr of dates) {
      const rows = await tx
        .insert(employeeTimeEntries)
        .values({
          userId,
          entryType: data.entryType,
          entryDate: dateStr,
          startTime: data.startTime || null,
          endTime: data.endTime || null,
          isFullDay: data.isFullDay ?? false,
          durationMinutes: data.durationMinutes || null,
          kilometers: data.kilometers ?? 0,
          notes: data.notes || null,
        })
        .returning();
      created.push(rows[0]);
    }
    return created;
  });
}

export async function updateTimeEntry(
  id: number,
  data: UpdateTimeEntry,
): Promise<EmployeeTimeEntry | undefined> {
  const updateData: Partial<EmployeeTimeEntry> = {
    updatedAt: new Date(),
  };

  if (data.entryType !== undefined) updateData.entryType = data.entryType;
  if (data.entryDate !== undefined) updateData.entryDate = data.entryDate;
  if (data.startTime !== undefined) updateData.startTime = data.startTime;
  if (data.endTime !== undefined) updateData.endTime = data.endTime;
  if (data.isFullDay !== undefined) updateData.isFullDay = data.isFullDay;
  if (data.durationMinutes !== undefined) updateData.durationMinutes = data.durationMinutes;
  if (data.kilometers !== undefined) updateData.kilometers = data.kilometers;
  if (data.notes !== undefined) updateData.notes = data.notes;

  const results = await db
    .update(employeeTimeEntries)
    .set(updateData)
    .where(eq(employeeTimeEntries.id, id))
    .returning();

  return results[0];
}

export async function deleteTimeEntry(id: number): Promise<boolean> {
  const results = await db
    .update(employeeTimeEntries)
    .set({ deletedAt: new Date() })
    .where(and(eq(employeeTimeEntries.id, id), isNull(employeeTimeEntries.deletedAt)))
    .returning();
  return results.length > 0;
}

export async function getAllTimeEntries(
  filters?: TimeEntryFilters & { userId?: number },
): Promise<(EmployeeTimeEntry & { user: { displayName: string } })[]> {
  const conditions = buildTimeEntryFilterConditions(filters);
  conditions.push(isNull(employeeTimeEntries.deletedAt));

  const results = await db
    .select({
      id: employeeTimeEntries.id,
      userId: employeeTimeEntries.userId,
      entryType: employeeTimeEntries.entryType,
      entryDate: employeeTimeEntries.entryDate,
      startTime: employeeTimeEntries.startTime,
      endTime: employeeTimeEntries.endTime,
      isFullDay: employeeTimeEntries.isFullDay,
      durationMinutes: employeeTimeEntries.durationMinutes,
      isAutoGenerated: employeeTimeEntries.isAutoGenerated,
      kilometers: employeeTimeEntries.kilometers,
      notes: employeeTimeEntries.notes,
      createdAt: employeeTimeEntries.createdAt,
      updatedAt: employeeTimeEntries.updatedAt,
      deletedAt: employeeTimeEntries.deletedAt,
      user: {
        displayName: users.displayName,
      },
    })
    .from(employeeTimeEntries)
    .leftJoin(users, eq(employeeTimeEntries.userId, users.id))
    .where(and(...conditions))
    .orderBy(employeeTimeEntries.entryDate);

  return results.map(r => ({
    ...r,
    user: { displayName: r.user?.displayName || 'Unbekannt' },
  }));
}
