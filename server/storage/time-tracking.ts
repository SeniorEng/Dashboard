import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { eq, and, gte, lte, sql as sqlBuilder } from "drizzle-orm";
import {
  employeeTimeEntries,
  employeeVacationAllowance,
  type EmployeeTimeEntry,
  type InsertTimeEntry,
  type UpdateTimeEntry,
  type EmployeeVacationAllowance,
  type InsertVacationAllowance,
} from "@shared/schema";

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle(sql);

export interface TimeEntryFilters {
  year?: number;
  month?: number;
  entryType?: string;
}

export interface VacationSummary {
  year: number;
  totalDays: number;
  carryOverDays: number;
  usedDays: number;
  plannedDays: number;
  remainingDays: number;
  sickDays: number;
}

export interface ITimeTrackingStorage {
  // Time Entries
  getTimeEntries(userId: number, filters?: TimeEntryFilters): Promise<EmployeeTimeEntry[]>;
  getTimeEntry(id: number): Promise<EmployeeTimeEntry | undefined>;
  createTimeEntry(userId: number, data: InsertTimeEntry): Promise<EmployeeTimeEntry>;
  updateTimeEntry(id: number, data: UpdateTimeEntry): Promise<EmployeeTimeEntry | undefined>;
  deleteTimeEntry(id: number): Promise<boolean>;
  
  // Vacation
  getVacationSummary(userId: number, year: number): Promise<VacationSummary>;
  getVacationAllowance(userId: number, year: number): Promise<EmployeeVacationAllowance | undefined>;
  setVacationAllowance(data: InsertVacationAllowance): Promise<EmployeeVacationAllowance>;
  
  // Admin views
  getAllTimeEntries(filters?: TimeEntryFilters & { userId?: number }): Promise<(EmployeeTimeEntry & { user: { displayName: string } })[]>;
}

class TimeTrackingStorage implements ITimeTrackingStorage {
  async getTimeEntries(userId: number, filters?: TimeEntryFilters): Promise<EmployeeTimeEntry[]> {
    let query = db.select().from(employeeTimeEntries).where(eq(employeeTimeEntries.userId, userId));
    
    const conditions = [eq(employeeTimeEntries.userId, userId)];
    
    if (filters?.year) {
      const startDate = `${filters.year}-01-01`;
      const endDate = `${filters.year}-12-31`;
      conditions.push(gte(employeeTimeEntries.entryDate, startDate));
      conditions.push(lte(employeeTimeEntries.entryDate, endDate));
    }
    
    if (filters?.month && filters?.year) {
      const monthStr = filters.month.toString().padStart(2, '0');
      const startDate = `${filters.year}-${monthStr}-01`;
      const lastDay = new Date(filters.year, filters.month, 0).getDate();
      const endDate = `${filters.year}-${monthStr}-${lastDay}`;
      conditions.push(gte(employeeTimeEntries.entryDate, startDate));
      conditions.push(lte(employeeTimeEntries.entryDate, endDate));
    }
    
    if (filters?.entryType) {
      conditions.push(eq(employeeTimeEntries.entryType, filters.entryType));
    }
    
    const results = await db
      .select()
      .from(employeeTimeEntries)
      .where(and(...conditions))
      .orderBy(employeeTimeEntries.entryDate);
    
    return results;
  }
  
  async getTimeEntry(id: number): Promise<EmployeeTimeEntry | undefined> {
    const results = await db
      .select()
      .from(employeeTimeEntries)
      .where(eq(employeeTimeEntries.id, id));
    return results[0];
  }
  
  async createTimeEntry(userId: number, data: InsertTimeEntry): Promise<EmployeeTimeEntry> {
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
        notes: data.notes || null,
      })
      .returning();
    return results[0];
  }
  
  async updateTimeEntry(id: number, data: UpdateTimeEntry): Promise<EmployeeTimeEntry | undefined> {
    const updateData: Partial<EmployeeTimeEntry> = {
      updatedAt: new Date(),
    };
    
    if (data.entryType !== undefined) updateData.entryType = data.entryType;
    if (data.entryDate !== undefined) updateData.entryDate = data.entryDate;
    if (data.startTime !== undefined) updateData.startTime = data.startTime;
    if (data.endTime !== undefined) updateData.endTime = data.endTime;
    if (data.isFullDay !== undefined) updateData.isFullDay = data.isFullDay;
    if (data.durationMinutes !== undefined) updateData.durationMinutes = data.durationMinutes;
    if (data.notes !== undefined) updateData.notes = data.notes;
    
    const results = await db
      .update(employeeTimeEntries)
      .set(updateData)
      .where(eq(employeeTimeEntries.id, id))
      .returning();
    
    return results[0];
  }
  
  async deleteTimeEntry(id: number): Promise<boolean> {
    const results = await db
      .delete(employeeTimeEntries)
      .where(eq(employeeTimeEntries.id, id))
      .returning();
    return results.length > 0;
  }
  
  async getVacationAllowance(userId: number, year: number): Promise<EmployeeVacationAllowance | undefined> {
    const results = await db
      .select()
      .from(employeeVacationAllowance)
      .where(
        and(
          eq(employeeVacationAllowance.userId, userId),
          eq(employeeVacationAllowance.year, year)
        )
      );
    return results[0];
  }
  
  async setVacationAllowance(data: InsertVacationAllowance): Promise<EmployeeVacationAllowance> {
    const existing = await this.getVacationAllowance(data.userId, data.year);
    
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
    } else {
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
  }
  
  async getVacationSummary(userId: number, year: number): Promise<VacationSummary> {
    // Get allowance for this year
    let allowance = await this.getVacationAllowance(userId, year);
    
    // Create default allowance if not exists
    if (!allowance) {
      allowance = await this.setVacationAllowance({
        userId,
        year,
        totalDays: 30,
        carryOverDays: 0,
      });
    }
    
    // Count vacation days taken this year
    const startDate = `${year}-01-01`;
    const endDate = `${year}-12-31`;
    const today = new Date().toISOString().split('T')[0];
    
    // Get vacation entries for this year
    const vacationEntries = await db
      .select()
      .from(employeeTimeEntries)
      .where(
        and(
          eq(employeeTimeEntries.userId, userId),
          eq(employeeTimeEntries.entryType, 'urlaub'),
          gte(employeeTimeEntries.entryDate, startDate),
          lte(employeeTimeEntries.entryDate, endDate)
        )
      );
    
    // Split into used (past) and planned (future)
    let usedDays = 0;
    let plannedDays = 0;
    
    for (const entry of vacationEntries) {
      if (entry.entryDate <= today) {
        usedDays++;
      } else {
        plannedDays++;
      }
    }
    
    // Count sick days
    const sickEntries = await db
      .select()
      .from(employeeTimeEntries)
      .where(
        and(
          eq(employeeTimeEntries.userId, userId),
          eq(employeeTimeEntries.entryType, 'krankheit'),
          gte(employeeTimeEntries.entryDate, startDate),
          lte(employeeTimeEntries.entryDate, endDate)
        )
      );
    
    const sickDays = sickEntries.length;
    
    const totalAvailable = allowance.totalDays + allowance.carryOverDays;
    const remainingDays = totalAvailable - usedDays - plannedDays;
    
    return {
      year,
      totalDays: allowance.totalDays,
      carryOverDays: allowance.carryOverDays,
      usedDays,
      plannedDays,
      remainingDays,
      sickDays,
    };
  }
  
  async getAllTimeEntries(filters?: TimeEntryFilters & { userId?: number }): Promise<(EmployeeTimeEntry & { user: { displayName: string } })[]> {
    const conditions = [];
    
    if (filters?.userId) {
      conditions.push(eq(employeeTimeEntries.userId, filters.userId));
    }
    
    if (filters?.year) {
      const startDate = `${filters.year}-01-01`;
      const endDate = `${filters.year}-12-31`;
      conditions.push(gte(employeeTimeEntries.entryDate, startDate));
      conditions.push(lte(employeeTimeEntries.entryDate, endDate));
    }
    
    if (filters?.month && filters?.year) {
      const monthStr = filters.month.toString().padStart(2, '0');
      const startDate = `${filters.year}-${monthStr}-01`;
      const lastDay = new Date(filters.year, filters.month, 0).getDate();
      const endDate = `${filters.year}-${monthStr}-${lastDay}`;
      conditions.push(gte(employeeTimeEntries.entryDate, startDate));
      conditions.push(lte(employeeTimeEntries.entryDate, endDate));
    }
    
    if (filters?.entryType) {
      conditions.push(eq(employeeTimeEntries.entryType, filters.entryType));
    }
    
    // Import users table for join
    const { users } = await import("@shared/schema");
    
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
        notes: employeeTimeEntries.notes,
        createdAt: employeeTimeEntries.createdAt,
        updatedAt: employeeTimeEntries.updatedAt,
        user: {
          displayName: users.displayName,
        },
      })
      .from(employeeTimeEntries)
      .leftJoin(users, eq(employeeTimeEntries.userId, users.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(employeeTimeEntries.entryDate);
    
    return results.map(r => ({
      ...r,
      user: { displayName: r.user?.displayName || 'Unbekannt' },
    }));
  }
}

export const timeTrackingStorage = new TimeTrackingStorage();
