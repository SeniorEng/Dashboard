import { eq, and, gte, lte } from "drizzle-orm";
import { employeeTimeEntries } from "@shared/schema";

export interface TimeEntryFilters {
  year?: number;
  month?: number;
  entryType?: string;
  /** Optional ISO date (YYYY-MM-DD) — restricts to a single day. */
  date?: string;
}

export interface TimeOverviewFilters {
  year: number;
  month: number;
}

/**
 * Builds date range conditions for time entry queries.
 * Centralized helper to avoid duplicating filter logic.
 */
export function buildTimeEntryFilterConditions(filters?: TimeEntryFilters & { userId?: number }) {
  const conditions = [];

  if (filters?.userId) {
    conditions.push(eq(employeeTimeEntries.userId, filters.userId));
  }

  if (filters?.date) {
    conditions.push(eq(employeeTimeEntries.entryDate, filters.date));
  } else if (filters?.year && filters?.month) {
    const monthStr = filters.month.toString().padStart(2, '0');
    const startDate = `${filters.year}-${monthStr}-01`;
    const lastDay = new Date(filters.year, filters.month, 0).getDate();
    const endDate = `${filters.year}-${monthStr}-${lastDay}`;
    conditions.push(gte(employeeTimeEntries.entryDate, startDate));
    conditions.push(lte(employeeTimeEntries.entryDate, endDate));
  } else if (filters?.year) {
    const startDate = `${filters.year}-01-01`;
    const endDate = `${filters.year}-12-31`;
    conditions.push(gte(employeeTimeEntries.entryDate, startDate));
    conditions.push(lte(employeeTimeEntries.entryDate, endDate));
  }

  if (filters?.entryType) {
    conditions.push(eq(employeeTimeEntries.entryType, filters.entryType));
  }

  return conditions;
}

/**
 * Computes inclusive [start, end] ISO date strings for a given year/month.
 */
export function monthDateRange(year: number, month: number): { startDate: string; endDate: string } {
  const monthStr = month.toString().padStart(2, '0');
  const startDate = `${year}-${monthStr}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const endDate = `${year}-${monthStr}-${lastDay.toString().padStart(2, '0')}`;
  return { startDate, endDate };
}
