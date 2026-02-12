import { eq, and, gte, lte, inArray, sql as sqlBuilder, asc } from "drizzle-orm";
import {
  employeeTimeEntries,
  employeeVacationAllowance,
  employeeMonthClosings,
  appointments,
  customers,
  users,
  type EmployeeTimeEntry,
  type InsertTimeEntry,
  type UpdateTimeEntry,
  type EmployeeVacationAllowance,
  type InsertVacationAllowance,
  type Appointment,
} from "@shared/schema";
import { getVacationEntitlement, calculateCarryOverDays } from "@shared/domain/vacation";
import { appointmentServices as appointmentServicesTable } from "@shared/schema/appointments";
import { services as servicesTable } from "@shared/schema/services";
import { todayISO, formatDateISO } from "@shared/utils/datetime";
import { db } from "../lib/db";

export interface TimeEntryFilters {
  year?: number;
  month?: number;
  entryType?: string;
}

/**
 * Builds date range conditions for time entry queries.
 * Centralized helper to avoid duplicating filter logic.
 */
function buildTimeEntryFilterConditions(filters?: TimeEntryFilters & { userId?: number }) {
  const conditions = [];
  
  if (filters?.userId) {
    conditions.push(eq(employeeTimeEntries.userId, filters.userId));
  }
  
  if (filters?.year && filters?.month) {
    // Month filter (more specific, so check first)
    const monthStr = filters.month.toString().padStart(2, '0');
    const startDate = `${filters.year}-${monthStr}-01`;
    const lastDay = new Date(filters.year, filters.month, 0).getDate();
    const endDate = `${filters.year}-${monthStr}-${lastDay}`;
    conditions.push(gte(employeeTimeEntries.entryDate, startDate));
    conditions.push(lte(employeeTimeEntries.entryDate, endDate));
  } else if (filters?.year) {
    // Year-only filter
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

export interface VacationSummary {
  year: number;
  totalDays: number;
  carryOverDays: number;
  usedDays: number;
  plannedDays: number;
  remainingDays: number;
  sickDays: number;
}

export interface AppointmentWithCustomerName extends Appointment {
  customerName: string;
}

export interface TimeOverviewFilters {
  year: number;
  month: number;
}

export interface ServiceHoursSummary {
  hauswirtschaftMinutes: number;
  alltagsbegleitungMinutes: number;
  erstberatungMinutes: number;
}

export interface TravelSummary {
  totalKilometers: number;
  customerKilometers: number;
  totalMinutes: number;
}

export interface TimeEntrySummary {
  urlaubDays: number;
  krankheitDays: number;
  pauseMinutes: number;
  bueroarbeitMinutes: number;
  vertriebMinutes: number;
  schulungMinutes: number;
  besprechungMinutes: number;
  sonstigesMinutes: number;
}

export interface TimeOverviewData {
  period: { year: number; month: number };
  serviceHours: ServiceHoursSummary;
  travel: TravelSummary;
  timeEntries: TimeEntrySummary;
  appointments: AppointmentWithCustomerName[];
  otherEntries: EmployeeTimeEntry[];
}

export interface MissingBreakDay {
  date: string;
  totalWorkMinutes: number;
  requiredBreakMinutes: number;
  documentedBreakMinutes: number;
}

export interface OpenTasksSummary {
  daysWithMissingBreaks: MissingBreakDay[];
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
  
  // Time Overview (combined appointments + time entries)
  getTimeOverview(userId: number, filters: TimeOverviewFilters): Promise<TimeOverviewData>;
  getEmployeeAppointments(userId: number, startDate: string, endDate: string): Promise<AppointmentWithCustomerName[]>;
  
  // Open Tasks
  getOpenTasks(userId: number): Promise<OpenTasksSummary>;
}

class TimeTrackingStorage implements ITimeTrackingStorage {
  async getTimeEntries(userId: number, filters?: TimeEntryFilters): Promise<EmployeeTimeEntry[]> {
    const conditions = buildTimeEntryFilterConditions({ ...filters, userId });
    
    const results = await db
      .select()
      .from(employeeTimeEntries)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
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

  async getTimeEntriesForDate(userId: number, date: string): Promise<EmployeeTimeEntry[]> {
    const results = await db
      .select()
      .from(employeeTimeEntries)
      .where(and(
        eq(employeeTimeEntries.userId, userId),
        eq(employeeTimeEntries.entryDate, date)
      ))
      .orderBy(employeeTimeEntries.startTime);
    return results;
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
    const startDate = `${year}-01-01`;
    const endDate = `${year}-12-31`;
    const today = todayISO();

    const [userResult, allowanceResult, prevAllowanceResult, absenceEntries, prevYearAbsence] = await Promise.all([
      db.select({
        eintrittsdatum: users.eintrittsdatum,
        vacationDaysPerYear: users.vacationDaysPerYear,
      }).from(users).where(eq(users.id, userId)).then(r => r[0]),
      this.getVacationAllowance(userId, year),
      this.getVacationAllowance(userId, year - 1),
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
            lte(employeeTimeEntries.entryDate, endDate)
          )
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
            lte(employeeTimeEntries.entryDate, `${year - 1}-12-31`)
          )
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
    const carryOverDays = allowanceResult
      ? allowanceResult.carryOverDays
      : calculateCarryOverDays(unusedFromPrevYear, year, today);

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
  
  async getAllTimeEntries(filters?: TimeEntryFilters & { userId?: number }): Promise<(EmployeeTimeEntry & { user: { displayName: string } })[]> {
    const conditions = buildTimeEntryFilterConditions(filters);
    
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
        isAutoGenerated: employeeTimeEntries.isAutoGenerated,
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
  
  async getEmployeeAppointments(userId: number, startDate: string, endDate: string): Promise<AppointmentWithCustomerName[]> {
    const results = await db
      .select({
        id: appointments.id,
        customerId: appointments.customerId,
        createdByUserId: appointments.createdByUserId,
        assignedEmployeeId: appointments.assignedEmployeeId,
        appointmentType: appointments.appointmentType,
        serviceType: appointments.serviceType,
        date: appointments.date,
        scheduledStart: appointments.scheduledStart,
        scheduledEnd: appointments.scheduledEnd,
        durationPromised: appointments.durationPromised,
        actualStart: appointments.actualStart,
        actualEnd: appointments.actualEnd,
        status: appointments.status,
        notes: appointments.notes,
        travelOriginType: appointments.travelOriginType,
        travelFromAppointmentId: appointments.travelFromAppointmentId,
        travelKilometers: appointments.travelKilometers,
        travelMinutes: appointments.travelMinutes,
        customerKilometers: appointments.customerKilometers,
        signatureData: appointments.signatureData,
        servicesDone: appointments.servicesDone,
        createdAt: appointments.createdAt,
        performedByEmployeeId: appointments.performedByEmployeeId,
        customerName: sqlBuilder`COALESCE(${customers.vorname} || ' ' || ${customers.nachname}, ${customers.name})`.as('customer_name'),
      })
      .from(appointments)
      .innerJoin(customers, eq(appointments.customerId, customers.id))
      .where(
        and(
          sqlBuilder`(
            ${appointments.assignedEmployeeId} = ${userId} 
            OR (${appointments.assignedEmployeeId} IS NULL AND (${customers.primaryEmployeeId} = ${userId} OR ${customers.backupEmployeeId} = ${userId}))
          )`,
          gte(appointments.date, startDate),
          lte(appointments.date, endDate)
        )
      )
      .orderBy(asc(appointments.date), asc(appointments.scheduledStart));
    
    return results.map(r => ({
      ...r,
      customerName: String(r.customerName),
    }));
  }
  
  async getTimeOverview(userId: number, filters: TimeOverviewFilters): Promise<TimeOverviewData> {
    const { year, month } = filters;
    const monthStr = month.toString().padStart(2, '0');
    const startDate = `${year}-${monthStr}-01`;
    const lastDay = new Date(year, month, 0).getDate();
    const endDate = `${year}-${monthStr}-${lastDay}`;
    
    const [employeeAppointments, timeEntries] = await Promise.all([
      this.getEmployeeAppointments(userId, startDate, endDate),
      this.getTimeEntries(userId, { year, month }),
    ]);
    
    const appointmentIds = employeeAppointments.map(a => a.id);
    
    let serviceBreakdown: Array<{ appointmentId: number; serviceCode: string | null; plannedDurationMinutes: number; actualDurationMinutes: number | null }> = [];
    if (appointmentIds.length > 0) {
      serviceBreakdown = await db.select({
        appointmentId: appointmentServicesTable.appointmentId,
        serviceCode: servicesTable.code,
        plannedDurationMinutes: appointmentServicesTable.plannedDurationMinutes,
        actualDurationMinutes: appointmentServicesTable.actualDurationMinutes,
      })
      .from(appointmentServicesTable)
      .innerJoin(servicesTable, eq(appointmentServicesTable.serviceId, servicesTable.id))
      .where(inArray(appointmentServicesTable.appointmentId, appointmentIds));
    }
    
    const serviceHours: ServiceHoursSummary = {
      hauswirtschaftMinutes: 0,
      alltagsbegleitungMinutes: 0,
      erstberatungMinutes: 0,
    };
    
    const travel: TravelSummary = {
      totalKilometers: 0,
      customerKilometers: 0,
      totalMinutes: 0,
    };
    
    const servicesByAppointment = new Map<number, typeof serviceBreakdown>();
    for (const svc of serviceBreakdown) {
      if (!servicesByAppointment.has(svc.appointmentId)) {
        servicesByAppointment.set(svc.appointmentId, []);
      }
      servicesByAppointment.get(svc.appointmentId)!.push(svc);
    }
    
    for (const appt of employeeAppointments) {
      const apptServices = servicesByAppointment.get(appt.id) || [];
      
      for (const svc of apptServices) {
        let minutes = 0;
        if (appt.status === 'completed') {
          minutes = svc.actualDurationMinutes || 0;
        } else if (appt.status === 'documenting') {
          minutes = svc.actualDurationMinutes ?? svc.plannedDurationMinutes ?? 0;
        } else {
          minutes = svc.plannedDurationMinutes || 0;
        }
        
        if (svc.serviceCode === 'hauswirtschaft') {
          serviceHours.hauswirtschaftMinutes += minutes;
        } else if (svc.serviceCode === 'alltagsbegleitung') {
          serviceHours.alltagsbegleitungMinutes += minutes;
        } else if (svc.serviceCode === 'erstberatung') {
          serviceHours.erstberatungMinutes += minutes;
        }
      }
      
      travel.totalKilometers += appt.travelKilometers || 0;
      travel.customerKilometers += appt.customerKilometers || 0;
      travel.totalMinutes += appt.travelMinutes || 0;
    }
    
    const timeEntrySummary: TimeEntrySummary = {
      urlaubDays: 0,
      krankheitDays: 0,
      pauseMinutes: 0,
      bueroarbeitMinutes: 0,
      vertriebMinutes: 0,
      schulungMinutes: 0,
      besprechungMinutes: 0,
      sonstigesMinutes: 0,
    };
    
    // Helper to calculate duration from startTime/endTime if durationMinutes is not set
    const getEntryDuration = (entry: { durationMinutes: number | null; startTime: string | null; endTime: string | null }): number => {
      if (entry.durationMinutes && entry.durationMinutes > 0) {
        return entry.durationMinutes;
      }
      if (entry.startTime && entry.endTime) {
        const [startH, startM] = entry.startTime.split(':').map(Number);
        const [endH, endM] = entry.endTime.split(':').map(Number);
        const startMinutes = startH * 60 + startM;
        const endMinutes = endH * 60 + endM;
        return Math.max(0, endMinutes - startMinutes);
      }
      return 0;
    };
    
    for (const entry of timeEntries) {
      const duration = getEntryDuration(entry);
      switch (entry.entryType) {
        case 'urlaub':
          timeEntrySummary.urlaubDays++;
          break;
        case 'krankheit':
          timeEntrySummary.krankheitDays++;
          break;
        case 'pause':
          timeEntrySummary.pauseMinutes += duration;
          break;
        case 'bueroarbeit':
          timeEntrySummary.bueroarbeitMinutes += duration;
          break;
        case 'vertrieb':
          timeEntrySummary.vertriebMinutes += duration;
          break;
        case 'schulung':
          timeEntrySummary.schulungMinutes += duration;
          break;
        case 'besprechung':
          timeEntrySummary.besprechungMinutes += duration;
          break;
        case 'sonstiges':
          timeEntrySummary.sonstigesMinutes += duration;
          break;
      }
    }
    
    return {
      period: { year, month },
      serviceHours,
      travel,
      timeEntries: timeEntrySummary,
      appointments: employeeAppointments,
      otherEntries: timeEntries,
    };
  }
  
  async getOpenTasks(userId: number): Promise<OpenTasksSummary> {
    // Look at the last 30 days including today
    // Include today so employees see break warnings while they can still add a pause
    const today = new Date();
    const startDate = new Date(today);
    startDate.setDate(startDate.getDate() - 30);
    
    const formatDate = (d: Date) => formatDateISO(d);
    const startDateStr = formatDate(startDate);
    const todayStr = formatDate(today);

    const [apptDurations, timeEntries] = await Promise.all([
      db.select({
        date: appointments.date,
        status: appointments.status,
        durationPromised: appointments.durationPromised,
      })
        .from(appointments)
        .innerJoin(customers, eq(appointments.customerId, customers.id))
        .where(
          and(
            sqlBuilder`(
              ${appointments.assignedEmployeeId} = ${userId} 
              OR (${appointments.assignedEmployeeId} IS NULL AND (${customers.primaryEmployeeId} = ${userId} OR ${customers.backupEmployeeId} = ${userId}))
            )`,
            gte(appointments.date, startDateStr),
            lte(appointments.date, todayStr),
            inArray(appointments.status, ['completed', 'documenting'])
          )
        ),
      db.select({
        entryDate: employeeTimeEntries.entryDate,
        entryType: employeeTimeEntries.entryType,
        durationMinutes: employeeTimeEntries.durationMinutes,
        startTime: employeeTimeEntries.startTime,
        endTime: employeeTimeEntries.endTime,
      })
        .from(employeeTimeEntries)
        .where(
          and(
            eq(employeeTimeEntries.userId, userId),
            gte(employeeTimeEntries.entryDate, startDateStr),
            lte(employeeTimeEntries.entryDate, todayStr)
          )
        ),
    ]);

    const workByDate: Record<string, { workMinutes: number; breakMinutes: number }> = {};

    for (const appt of apptDurations) {
      const date = appt.date;
      if (!workByDate[date]) {
        workByDate[date] = { workMinutes: 0, breakMinutes: 0 };
      }
      workByDate[date].workMinutes += appt.durationPromised || 0;
    }

    const getEntryDuration = (entry: { durationMinutes: number | null; startTime: string | null; endTime: string | null }): number => {
      if (entry.durationMinutes && entry.durationMinutes > 0) {
        return entry.durationMinutes;
      }
      if (entry.startTime && entry.endTime) {
        const [startH, startM] = entry.startTime.split(':').map(Number);
        const [endH, endM] = entry.endTime.split(':').map(Number);
        return Math.max(0, (endH * 60 + endM) - (startH * 60 + startM));
      }
      return 0;
    };

    for (const entry of timeEntries) {
      const date = entry.entryDate;
      if (!workByDate[date]) {
        workByDate[date] = { workMinutes: 0, breakMinutes: 0 };
      }
      const duration = getEntryDuration(entry);
      if (entry.entryType === 'pause') {
        workByDate[date].breakMinutes += duration;
      } else if (['bueroarbeit', 'vertrieb', 'schulung', 'besprechung', 'sonstiges'].includes(entry.entryType)) {
        workByDate[date].workMinutes += duration;
      }
    }
    
    // Find days with missing breaks (>6h work needs 30min, >9h needs 45min)
    const daysWithMissingBreaks: MissingBreakDay[] = [];
    
    for (const [date, data] of Object.entries(workByDate)) {
      let requiredBreak = 0;
      if (data.workMinutes > 540) { // > 9 hours
        requiredBreak = 45;
      } else if (data.workMinutes > 360) { // > 6 hours
        requiredBreak = 30;
      }
      
      if (requiredBreak > 0 && data.breakMinutes < requiredBreak) {
        daysWithMissingBreaks.push({
          date,
          totalWorkMinutes: data.workMinutes,
          requiredBreakMinutes: requiredBreak,
          documentedBreakMinutes: data.breakMinutes,
        });
      }
    }
    
    // Sort by date descending (most recent first)
    daysWithMissingBreaks.sort((a, b) => b.date.localeCompare(a.date));
    
    return {
      daysWithMissingBreaks,
    };
  }

  async isMonthClosed(userId: number, dateStr: string): Promise<boolean> {
    const [yearStr, monthStr] = dateStr.split("-");
    const year = parseInt(yearStr);
    const month = parseInt(monthStr);
    const closing = await db
      .select()
      .from(employeeMonthClosings)
      .where(
        and(
          eq(employeeMonthClosings.userId, userId),
          eq(employeeMonthClosings.year, year),
          eq(employeeMonthClosings.month, month)
        )
      )
      .limit(1);
    return closing.length > 0 && !closing[0].reopenedAt;
  }

  async getMonthClosing(userId: number, year: number, month: number) {
    const rows = await db
      .select()
      .from(employeeMonthClosings)
      .where(
        and(
          eq(employeeMonthClosings.userId, userId),
          eq(employeeMonthClosings.year, year),
          eq(employeeMonthClosings.month, month)
        )
      )
      .limit(1);
    return rows[0] || null;
  }

  async getAdminMonthClosings(year: number, month: number) {
    return await db
      .select()
      .from(employeeMonthClosings)
      .where(
        and(
          eq(employeeMonthClosings.year, year),
          eq(employeeMonthClosings.month, month)
        )
      );
  }

  async closeMonth(userId: number, year: number, month: number, closedByUserId: number, existingId?: number) {
    if (existingId) {
      await db
        .update(employeeMonthClosings)
        .set({
          closedAt: new Date(),
          closedByUserId,
          reopenedAt: null,
          reopenedByUserId: null,
        })
        .where(eq(employeeMonthClosings.id, existingId));
    } else {
      await db.insert(employeeMonthClosings).values({
        userId,
        year,
        month,
        closedByUserId,
      });
    }
  }

  async reopenMonth(closingId: number, reopenedByUserId: number) {
    await db
      .update(employeeMonthClosings)
      .set({
        reopenedAt: new Date(),
        reopenedByUserId,
      })
      .where(eq(employeeMonthClosings.id, closingId));
  }
}

export const timeTrackingStorage = new TimeTrackingStorage();
