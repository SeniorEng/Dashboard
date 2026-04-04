import { eq, and, gte, lte, inArray, sql as sqlBuilder, asc, isNull, or, notInArray, count, ne } from "drizzle-orm";
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
import { getEntryDuration } from "@shared/domain/time-entries";
import { getVacationEntitlement, calculateCarryOverDays } from "@shared/domain/vacation";
import { appointmentServices as appointmentServicesTable } from "@shared/schema/appointments";
import { services as servicesTable } from "@shared/schema/services";
import { todayISO, formatDateISO } from "@shared/utils/datetime";
import { db, type DbOrTx } from "../lib/db";

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

import type { VacationSummary as SharedVacationSummary } from "@shared/api";
export type VacationSummary = SharedVacationSummary;

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
  timeEntryKilometers: number;
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
  completedServiceHours: ServiceHoursSummary;
  plannedServiceHours: ServiceHoursSummary;
  travel: TravelSummary;
  completedTravel: Pick<TravelSummary, 'totalKilometers' | 'customerKilometers' | 'totalMinutes'>;
  plannedTravel: Pick<TravelSummary, 'totalKilometers' | 'customerKilometers' | 'totalMinutes'>;
  timeEntries: TimeEntrySummary;
  appointments: AppointmentWithCustomerName[];
  otherEntries: EmployeeTimeEntry[];
}

import type { MissingBreakDay, OpenTasksSummary } from "@shared/types";
export type { MissingBreakDay, OpenTasksSummary };

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
  getAllAppointmentsInRange(startDate: string, endDate: string): Promise<AppointmentWithCustomerName[]>;
  
  // Open Tasks
  getOpenTasks(userId: number): Promise<OpenTasksSummary>;
}

class TimeTrackingStorage implements ITimeTrackingStorage {
  async getTimeEntries(userId: number, filters?: TimeEntryFilters): Promise<EmployeeTimeEntry[]> {
    const conditions = buildTimeEntryFilterConditions({ ...filters, userId });
    conditions.push(isNull(employeeTimeEntries.deletedAt));
    
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
      .where(and(eq(employeeTimeEntries.id, id), isNull(employeeTimeEntries.deletedAt)));
    return results[0];
  }

  async getTimeEntriesForDate(userId: number, date: string): Promise<EmployeeTimeEntry[]> {
    const results = await db
      .select()
      .from(employeeTimeEntries)
      .where(and(
        eq(employeeTimeEntries.userId, userId),
        eq(employeeTimeEntries.entryDate, date),
        isNull(employeeTimeEntries.deletedAt)
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
        kilometers: data.kilometers ?? 0,
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
    if (data.kilometers !== undefined) updateData.kilometers = data.kilometers;
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
      .update(employeeTimeEntries)
      .set({ deletedAt: new Date() })
      .where(and(eq(employeeTimeEntries.id, id), isNull(employeeTimeEntries.deletedAt)))
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
            lte(employeeTimeEntries.entryDate, endDate),
            isNull(employeeTimeEntries.deletedAt)
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
            lte(employeeTimeEntries.entryDate, `${year - 1}-12-31`),
            isNull(employeeTimeEntries.deletedAt)
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
  
  async getAllTimeEntries(filters?: TimeEntryFilters & { userId?: number }): Promise<(EmployeeTimeEntry & { user: { displayName: string } })[]> {
    const conditions = buildTimeEntryFilterConditions(filters);
    conditions.push(isNull(employeeTimeEntries.deletedAt));
    
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
        signatureHash: appointments.signatureHash,
        signedAt: appointments.signedAt,
        signedByUserId: appointments.signedByUserId,
        servicesDone: appointments.servicesDone,
        createdAt: appointments.createdAt,
        performedByEmployeeId: appointments.performedByEmployeeId,
        prospectId: appointments.prospectId,
        deletedAt: appointments.deletedAt,
        seriesId: appointments.seriesId,
        isSeriesException: appointments.isSeriesException,
        customerName: sqlBuilder`COALESCE(${customers.vorname} || ' ' || ${customers.nachname}, ${customers.name})`.as('customer_name'),
      })
      .from(appointments)
      .innerJoin(customers, eq(appointments.customerId, customers.id))
      .where(
        and(
          sqlBuilder`(
            ${appointments.assignedEmployeeId} = ${userId} 
            OR (${appointments.assignedEmployeeId} IS NULL AND (${customers.primaryEmployeeId} = ${userId} OR ${customers.backupEmployeeId} = ${userId} OR ${customers.backupEmployeeId2} = ${userId}))
          )`,
          gte(appointments.date, startDate),
          lte(appointments.date, endDate),
          isNull(appointments.deletedAt)
        )
      )
      .orderBy(asc(appointments.date), asc(appointments.scheduledStart));
    
    return results.map(r => ({
      ...r,
      customerName: String(r.customerName),
    }));
  }

  async getAllAppointmentsInRange(startDate: string, endDate: string): Promise<AppointmentWithCustomerName[]> {
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
        signatureHash: appointments.signatureHash,
        signedAt: appointments.signedAt,
        signedByUserId: appointments.signedByUserId,
        servicesDone: appointments.servicesDone,
        createdAt: appointments.createdAt,
        performedByEmployeeId: appointments.performedByEmployeeId,
        prospectId: appointments.prospectId,
        deletedAt: appointments.deletedAt,
        seriesId: appointments.seriesId,
        isSeriesException: appointments.isSeriesException,
        customerName: sqlBuilder`COALESCE(${customers.vorname} || ' ' || ${customers.nachname}, ${customers.name})`.as('customer_name'),
      })
      .from(appointments)
      .innerJoin(customers, eq(appointments.customerId, customers.id))
      .where(
        and(
          gte(appointments.date, startDate),
          lte(appointments.date, endDate),
          isNull(appointments.deletedAt)
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
    const completedServiceHours: ServiceHoursSummary = {
      hauswirtschaftMinutes: 0,
      alltagsbegleitungMinutes: 0,
      erstberatungMinutes: 0,
    };
    const plannedServiceHours: ServiceHoursSummary = {
      hauswirtschaftMinutes: 0,
      alltagsbegleitungMinutes: 0,
      erstberatungMinutes: 0,
    };
    
    const travel: TravelSummary = {
      totalKilometers: 0,
      customerKilometers: 0,
      timeEntryKilometers: 0,
      totalMinutes: 0,
    };
    const completedTravel = { totalKilometers: 0, customerKilometers: 0, totalMinutes: 0 };
    const plannedTravel = { totalKilometers: 0, customerKilometers: 0, totalMinutes: 0 };
    
    const servicesByAppointment = new Map<number, typeof serviceBreakdown>();
    for (const svc of serviceBreakdown) {
      if (!servicesByAppointment.has(svc.appointmentId)) {
        servicesByAppointment.set(svc.appointmentId, []);
      }
      servicesByAppointment.get(svc.appointmentId)!.push(svc);
    }
    
    for (const appt of employeeAppointments) {
      if (appt.status === 'cancelled') continue;
      const apptServices = servicesByAppointment.get(appt.id) || [];
      const isDone = appt.status === 'completed';
      const targetHours = isDone ? completedServiceHours : plannedServiceHours;
      const targetTravel = isDone ? completedTravel : plannedTravel;
      
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
          targetHours.hauswirtschaftMinutes += minutes;
        } else if (svc.serviceCode === 'alltagsbegleitung') {
          serviceHours.alltagsbegleitungMinutes += minutes;
          targetHours.alltagsbegleitungMinutes += minutes;
        } else if (svc.serviceCode === 'erstberatung') {
          serviceHours.erstberatungMinutes += minutes;
          targetHours.erstberatungMinutes += minutes;
        }
      }
      
      const km = appt.travelKilometers || 0;
      const ckm = appt.customerKilometers || 0;
      const tmin = appt.travelMinutes || 0;
      travel.totalKilometers += km;
      travel.customerKilometers += ckm;
      travel.totalMinutes += tmin;
      targetTravel.totalKilometers += km;
      targetTravel.customerKilometers += ckm;
      targetTravel.totalMinutes += tmin;
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
    
    for (const entry of timeEntries) {
      const duration = getEntryDuration(entry);
      travel.timeEntryKilometers += entry.kilometers || 0;
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
    
    const enrichedAppointments = employeeAppointments.map(appt => {
      const apptServices = servicesByAppointment.get(appt.id) || [];
      return {
        ...appt,
        services: apptServices.map(s => ({
          serviceCode: s.serviceCode,
          plannedDurationMinutes: s.plannedDurationMinutes,
          actualDurationMinutes: s.actualDurationMinutes,
        })),
      };
    });

    return {
      period: { year, month },
      serviceHours,
      completedServiceHours,
      plannedServiceHours,
      travel,
      completedTravel,
      plannedTravel,
      timeEntries: timeEntrySummary,
      appointments: enrichedAppointments,
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
              OR (${appointments.assignedEmployeeId} IS NULL AND (${customers.primaryEmployeeId} = ${userId} OR ${customers.backupEmployeeId} = ${userId} OR ${customers.backupEmployeeId2} = ${userId}))
            )`,
            gte(appointments.date, startDateStr),
            lte(appointments.date, todayStr),
            inArray(appointments.status, ['completed', 'documenting']),
            isNull(appointments.deletedAt)
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
            lte(employeeTimeEntries.entryDate, todayStr),
            isNull(employeeTimeEntries.deletedAt)
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

  async getMonthClosingReadiness(userId: number, year: number, month: number) {
    const monthStr = month.toString().padStart(2, '0');
    const startDate = `${year}-${monthStr}-01`;
    const lastDay = new Date(year, month, 0).getDate();
    const endDate = `${year}-${monthStr}-${lastDay}`;

    const employeeFilter = sqlBuilder`(
      ${appointments.assignedEmployeeId} = ${userId} 
      OR (${appointments.assignedEmployeeId} IS NULL AND (${customers.primaryEmployeeId} = ${userId} OR ${customers.backupEmployeeId} = ${userId} OR ${customers.backupEmployeeId2} = ${userId}))
    )`;

    const openAppointments = await db
      .select({
        id: appointments.id,
        date: appointments.date,
        scheduledStart: appointments.scheduledStart,
        status: appointments.status,
        customerId: appointments.customerId,
        customerName: sqlBuilder`COALESCE(${customers.vorname} || ' ' || ${customers.nachname}, ${customers.name})`.as('customer_name'),
      })
      .from(appointments)
      .innerJoin(customers, eq(appointments.customerId, customers.id))
      .where(
        and(
          employeeFilter,
          gte(appointments.date, startDate),
          lte(appointments.date, endDate),
          isNull(appointments.deletedAt),
          notInArray(appointments.status, ["completed", "cancelled"])
        )
      )
      .orderBy(asc(appointments.date), asc(appointments.scheduledStart));

    const unsignedAppointments = await db
      .select({
        id: appointments.id,
        date: appointments.date,
        scheduledStart: appointments.scheduledStart,
        status: appointments.status,
        customerId: appointments.customerId,
        customerName: sqlBuilder`COALESCE(${customers.vorname} || ' ' || ${customers.nachname}, ${customers.name})`.as('customer_name'),
      })
      .from(appointments)
      .innerJoin(customers, eq(appointments.customerId, customers.id))
      .where(
        and(
          employeeFilter,
          gte(appointments.date, startDate),
          lte(appointments.date, endDate),
          isNull(appointments.deletedAt),
          eq(appointments.status, "completed"),
          isNull(appointments.signatureData)
        )
      )
      .orderBy(asc(appointments.date), asc(appointments.scheduledStart));

    const timeEntryCount = await db
      .select({ count: count() })
      .from(employeeTimeEntries)
      .where(
        and(
          eq(employeeTimeEntries.userId, userId),
          gte(employeeTimeEntries.entryDate, startDate),
          lte(employeeTimeEntries.entryDate, endDate),
          isNull(employeeTimeEntries.deletedAt)
        )
      );

    const completedAppointmentCount = await db
      .select({ count: count() })
      .from(appointments)
      .innerJoin(customers, eq(appointments.customerId, customers.id))
      .where(
        and(
          employeeFilter,
          gte(appointments.date, startDate),
          lte(appointments.date, endDate),
          isNull(appointments.deletedAt),
          inArray(appointments.status, ["completed", "cancelled"])
        )
      );

    const timeEntries = Number(timeEntryCount[0]?.count ?? 0);
    const completedAppts = Number(completedAppointmentCount[0]?.count ?? 0);
    const hasActivity = timeEntries > 0 || completedAppts > 0;

    const mapAppointment = (a: { id: number; date: string; scheduledStart: string | null; status: string; customerName: unknown }) => ({
      id: a.id,
      date: a.date,
      scheduledStart: a.scheduledStart,
      status: a.status,
      customerName: String(a.customerName ?? "Unbekannt"),
    });

    return {
      ready: openAppointments.length === 0 && unsignedAppointments.length === 0 && hasActivity,
      openAppointments: openAppointments.map(mapAppointment),
      unsignedAppointments: unsignedAppointments.map(mapAppointment),
      hasTimeEntries: hasActivity,
      timeEntryCount: timeEntries + completedAppts,
    };
  }

  async getAdminMonthClosingReadiness(year: number, month: number) {
    const monthStr = month.toString().padStart(2, '0');
    const startDate = `${year}-${monthStr}-01`;
    const lastDay = new Date(year, month, 0).getDate();
    const endDate = `${year}-${monthStr}-${lastDay}`;

    const activeEmployees = await db
      .select({ id: users.id, displayName: users.displayName })
      .from(users)
      .where(and(eq(users.isActive, true), eq(users.isAdmin, false)));

    if (activeEmployees.length === 0) return [];

    const employeeIds = activeEmployees.map(e => e.id);

    const employeeAppointmentFilter = (userId: typeof appointments.assignedEmployeeId) =>
      sqlBuilder`(
        ${appointments.assignedEmployeeId} = ${userId}
        OR (${appointments.assignedEmployeeId} IS NULL AND (${customers.primaryEmployeeId} = ${userId} OR ${customers.backupEmployeeId} = ${userId} OR ${customers.backupEmployeeId2} = ${userId}))
      )`;

    const [allOpenAppts, allUnsignedAppts, allTimeEntryCounts, allCompletedCounts, allClosings] = await Promise.all([
      db
        .select({
          employeeId: sqlBuilder`COALESCE(${appointments.assignedEmployeeId}, ${customers.primaryEmployeeId})`.as('employee_id'),
          id: appointments.id,
          date: appointments.date,
          scheduledStart: appointments.scheduledStart,
          status: appointments.status,
          customerId: appointments.customerId,
          customerName: sqlBuilder`COALESCE(${customers.vorname} || ' ' || ${customers.nachname}, ${customers.name})`.as('customer_name'),
        })
        .from(appointments)
        .innerJoin(customers, eq(appointments.customerId, customers.id))
        .where(
          and(
            gte(appointments.date, startDate),
            lte(appointments.date, endDate),
            isNull(appointments.deletedAt),
            notInArray(appointments.status, ["completed", "cancelled"]),
            or(
              inArray(appointments.assignedEmployeeId, employeeIds),
              and(
                isNull(appointments.assignedEmployeeId),
                or(
                  inArray(customers.primaryEmployeeId, employeeIds),
                  inArray(customers.backupEmployeeId, employeeIds),
                  inArray(customers.backupEmployeeId2, employeeIds)
                )
              )
            )
          )
        )
        .orderBy(asc(appointments.date), asc(appointments.scheduledStart)),

      db
        .select({
          employeeId: sqlBuilder`COALESCE(${appointments.assignedEmployeeId}, ${customers.primaryEmployeeId})`.as('employee_id'),
          id: appointments.id,
          date: appointments.date,
          scheduledStart: appointments.scheduledStart,
          status: appointments.status,
          customerId: appointments.customerId,
          customerName: sqlBuilder`COALESCE(${customers.vorname} || ' ' || ${customers.nachname}, ${customers.name})`.as('customer_name'),
        })
        .from(appointments)
        .innerJoin(customers, eq(appointments.customerId, customers.id))
        .where(
          and(
            gte(appointments.date, startDate),
            lte(appointments.date, endDate),
            isNull(appointments.deletedAt),
            eq(appointments.status, "completed"),
            isNull(appointments.signatureData),
            or(
              inArray(appointments.assignedEmployeeId, employeeIds),
              and(
                isNull(appointments.assignedEmployeeId),
                or(
                  inArray(customers.primaryEmployeeId, employeeIds),
                  inArray(customers.backupEmployeeId, employeeIds),
                  inArray(customers.backupEmployeeId2, employeeIds)
                )
              )
            )
          )
        )
        .orderBy(asc(appointments.date), asc(appointments.scheduledStart)),

      db
        .select({
          userId: employeeTimeEntries.userId,
          count: count(),
        })
        .from(employeeTimeEntries)
        .where(
          and(
            inArray(employeeTimeEntries.userId, employeeIds),
            gte(employeeTimeEntries.entryDate, startDate),
            lte(employeeTimeEntries.entryDate, endDate),
            isNull(employeeTimeEntries.deletedAt)
          )
        )
        .groupBy(employeeTimeEntries.userId),

      db
        .select({
          employeeId: sqlBuilder`COALESCE(${appointments.assignedEmployeeId}, ${customers.primaryEmployeeId})`.as('employee_id'),
          count: count(),
        })
        .from(appointments)
        .innerJoin(customers, eq(appointments.customerId, customers.id))
        .where(
          and(
            gte(appointments.date, startDate),
            lte(appointments.date, endDate),
            isNull(appointments.deletedAt),
            inArray(appointments.status, ["completed", "cancelled"]),
            or(
              inArray(appointments.assignedEmployeeId, employeeIds),
              and(
                isNull(appointments.assignedEmployeeId),
                or(
                  inArray(customers.primaryEmployeeId, employeeIds),
                  inArray(customers.backupEmployeeId, employeeIds),
                  inArray(customers.backupEmployeeId2, employeeIds)
                )
              )
            )
          )
        )
        .groupBy(sqlBuilder`COALESCE(${appointments.assignedEmployeeId}, ${customers.primaryEmployeeId})`),

      db
        .select()
        .from(employeeMonthClosings)
        .where(
          and(
            eq(employeeMonthClosings.year, year),
            eq(employeeMonthClosings.month, month),
            inArray(employeeMonthClosings.userId, employeeIds)
          )
        ),
    ]);

    const mapAppointment = (a: { id: number; date: string; scheduledStart: string | null; status: string; customerName: unknown }) => ({
      id: a.id,
      date: a.date,
      scheduledStart: a.scheduledStart,
      status: a.status,
      customerName: String(a.customerName ?? "Unbekannt"),
    });

    const openByEmployee = new Map<number, typeof allOpenAppts>();
    for (const appt of allOpenAppts) {
      const empId = Number(appt.employeeId);
      if (!openByEmployee.has(empId)) openByEmployee.set(empId, []);
      openByEmployee.get(empId)!.push(appt);
    }

    const unsignedByEmployee = new Map<number, typeof allUnsignedAppts>();
    for (const appt of allUnsignedAppts) {
      const empId = Number(appt.employeeId);
      if (!unsignedByEmployee.has(empId)) unsignedByEmployee.set(empId, []);
      unsignedByEmployee.get(empId)!.push(appt);
    }

    const timeEntryCountMap = new Map(allTimeEntryCounts.map(r => [r.userId, Number(r.count)]));
    const completedCountMap = new Map(allCompletedCounts.map(r => [Number(r.employeeId), Number(r.count)]));
    const closingMap = new Map(allClosings.map(c => [c.userId, c]));

    return activeEmployees.map(emp => {
      const openAppts = openByEmployee.get(emp.id) ?? [];
      const unsignedAppts = unsignedByEmployee.get(emp.id) ?? [];
      const timeEntries = timeEntryCountMap.get(emp.id) ?? 0;
      const completedAppts = completedCountMap.get(emp.id) ?? 0;
      const hasActivity = timeEntries > 0 || completedAppts > 0;
      const closing = closingMap.get(emp.id);
      const isClosed = !!(closing && !closing.reopenedAt);

      return {
        userId: emp.id,
        displayName: emp.displayName,
        isClosed,
        closingId: closing?.id ?? null,
        ready: openAppts.length === 0 && unsignedAppts.length === 0 && hasActivity,
        openAppointments: openAppts.map(mapAppointment),
        unsignedAppointments: unsignedAppts.map(mapAppointment),
        hasTimeEntries: hasActivity,
        timeEntryCount: timeEntries + completedAppts,
      };
    });
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

  async closeMonth(userId: number, year: number, month: number, closedByUserId: number, existingId?: number, txOrDb: DbOrTx = db) {
    if (existingId) {
      await txOrDb
        .update(employeeMonthClosings)
        .set({
          closedAt: new Date(),
          closedByUserId,
          reopenedAt: null,
          reopenedByUserId: null,
        })
        .where(eq(employeeMonthClosings.id, existingId));
    } else {
      await txOrDb.insert(employeeMonthClosings).values({
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
