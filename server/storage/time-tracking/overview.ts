import { eq, and, gte, lte, inArray, isNull } from "drizzle-orm";
import {
  appointments,
  customers,
  employeeTimeEntries,
} from "@shared/schema";
import { appointmentServices as appointmentServicesTable } from "@shared/schema/appointments";
import { services as servicesTable } from "@shared/schema/services";
import type {
  ServiceHoursSummary,
  TravelSummary,
  TimeEntrySummary,
  TimeOverviewData,
} from "@shared/api";
import type { MissingBreakDay, OpenTasksSummary } from "@shared/types";
import {
  getEntryDuration,
  isWorkEntryType,
  calculateRequiredBreak,
} from "@shared/domain/time-entries";
import { formatDateISO } from "@shared/utils/datetime";
import { db } from "../../lib/db";
import { employeeVisibleAppointmentsFilter } from "../appointment-helpers";
import { monthDateRange, type TimeOverviewFilters } from "./shared";
import { getAllAppointmentsInRange, getEmployeeAppointments } from "./appointments";
import { getAllTimeEntries, getTimeEntries } from "./entries";
import type { AdminTimeTrackingOverview } from "@shared/api";
import { appointmentsRepo, employeeTimeEntriesRepo } from "../../repos";

export async function getTimeOverview(
  userId: number,
  filters: TimeOverviewFilters,
): Promise<TimeOverviewData> {
  const { year, month } = filters;
  const { startDate, endDate } = monthDateRange(year, month);

  const [employeeAppointments, timeEntries] = await Promise.all([
    getEmployeeAppointments(userId, startDate, endDate),
    getTimeEntries(userId, { year, month }),
  ]);

  const appointmentIds = employeeAppointments.map(a => a.id);

  let serviceBreakdown: Array<{
    appointmentId: number;
    serviceCode: string | null;
    plannedDurationMinutes: number;
    actualDurationMinutes: number | null;
  }> = [];
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

  // Task #485 — Leerfahrten (customer_no_show): MA war vor Ort, hat aber keine
  // Leistung erbracht. Wird separat aggregiert, damit die "echten" Service-
  // Stunden nicht durch No-Shows verwässert werden.
  const leerfahrten = {
    count: 0,
    plannedMinutes: 0,
    waitMinutes: 0,
    kilometers: 0,
  };

  const servicesByAppointment = new Map<number, typeof serviceBreakdown>();
  for (const svc of serviceBreakdown) {
    if (!servicesByAppointment.has(svc.appointmentId)) {
      servicesByAppointment.set(svc.appointmentId, []);
    }
    servicesByAppointment.get(svc.appointmentId)!.push(svc);
  }

  for (const appt of employeeAppointments) {
    if (appt.status === 'cancelled') continue;
    if (appt.status === 'customer_no_show') {
      // No-Show: keine erbrachten Service-Minuten, aber Anfahrt & Wartezeit
      // werden für die "Leerfahrten"-Kachel aggregiert. MA-Lohn wird über
      // die geplante Dauer (durationPromised) abgerechnet — siehe Lohnart
      // `leerfahrt` im Service-Katalog (Task #485).
      leerfahrten.count++;
      leerfahrten.plannedMinutes += appt.durationPromised || 0;
      leerfahrten.waitMinutes += appt.noShowWaitMinutes || 0;
      leerfahrten.kilometers += appt.travelKilometers || 0;
      continue;
    }
    const apptServices = servicesByAppointment.get(appt.id) || [];
    const isDone = appt.status === 'completed';
    const targetHours = isDone ? completedServiceHours : plannedServiceHours;
    const targetTravel = isDone ? completedTravel : plannedTravel;

    for (const svc of apptServices) {
      let minutes = 0;
      if (appt.status === 'completed' || appt.status === 'documenting') {
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
      case 'sonstiges':
        timeEntrySummary.sonstigesMinutes += duration;
        break;
    }
  }

  type EnrichedAppointment = typeof employeeAppointments[number] & {
    services: Array<{
      serviceCode: string | null;
      plannedDurationMinutes: number;
      actualDurationMinutes: number | null;
    }>;
  };
  const apptsByDate: Record<string, EnrichedAppointment[]> = {};
  for (const appt of employeeAppointments) {
    const apptServices = servicesByAppointment.get(appt.id) || [];
    const enriched = {
      ...appt,
      services: apptServices.map(s => ({
        serviceCode: s.serviceCode,
        plannedDurationMinutes: s.plannedDurationMinutes,
        actualDurationMinutes: s.actualDurationMinutes,
      })),
    };
    (apptsByDate[appt.date] ||= []).push(enriched);
  }

  const otherEntriesByDate: Record<string, typeof timeEntries> = {};
  for (const entry of timeEntries) {
    (otherEntriesByDate[entry.entryDate] ||= []).push(entry);
  }

  return {
    period: { year, month },
    serviceHours,
    completedServiceHours,
    plannedServiceHours,
    travel,
    completedTravel,
    plannedTravel,
    timeEntries: timeEntrySummary,
    appointments: apptsByDate,
    otherEntries: otherEntriesByDate,
    leerfahrten,
  } as TimeOverviewData;
}

export async function getOpenTasks(userId: number): Promise<OpenTasksSummary> {
  // Look at the last 30 days including today
  // Include today so employees see break warnings while they can still add a pause
  const today = new Date();
  const startDate = new Date(today);
  startDate.setDate(startDate.getDate() - 30);

  const startDateStr = formatDateISO(startDate);
  const todayStr = formatDateISO(today);

  const [apptDurations, timeEntries] = await Promise.all([
    appointmentsRepo.selectColumnsFrom({
      date: appointments.date,
      status: appointments.status,
      durationPromised: appointments.durationPromised,
    }, db)
      .innerJoin(customers, eq(appointments.customerId, customers.id))
      .where(
        and(
          employeeVisibleAppointmentsFilter(userId),
          gte(appointments.date, startDateStr),
          lte(appointments.date, todayStr),
          inArray(appointments.status, ['completed', 'documenting']),
          isNull(appointments.deletedAt),
        ),
      ),
    employeeTimeEntriesRepo.selectColumnsFrom({
      entryDate: employeeTimeEntries.entryDate,
      entryType: employeeTimeEntries.entryType,
      durationMinutes: employeeTimeEntries.durationMinutes,
      startTime: employeeTimeEntries.startTime,
      endTime: employeeTimeEntries.endTime,
    }, db)
      .where(
        and(
          eq(employeeTimeEntries.userId, userId),
          gte(employeeTimeEntries.entryDate, startDateStr),
          lte(employeeTimeEntries.entryDate, todayStr),
          isNull(employeeTimeEntries.deletedAt),
        ),
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
    } else if (isWorkEntryType(entry.entryType)) {
      workByDate[date].workMinutes += duration;
    }
  }

  const daysWithMissingBreaks: MissingBreakDay[] = [];

  for (const [date, data] of Object.entries(workByDate)) {
    const requiredBreak = calculateRequiredBreak(data.workMinutes);
    if (requiredBreak > 0 && data.breakMinutes < requiredBreak) {
      daysWithMissingBreaks.push({
        date,
        totalWorkMinutes: data.workMinutes,
        requiredBreakMinutes: requiredBreak,
        documentedBreakMinutes: data.breakMinutes,
      });
    }
  }

  daysWithMissingBreaks.sort((a, b) => b.date.localeCompare(a.date));

  return {
    daysWithMissingBreaks,
  };
}

export interface AdminTimeTrackingOverviewFilters {
  year: number;
  month: number;
  userId?: number;
  /**
   * Either `"all"`, eine `TimeEntryType`, oder `appt_erstberatung` /
   * `appt_kundentermin` für reine Termin-Filterung. Undefined = alles.
   */
  entryType?: string;
}

/**
 * Kombiniertes Datenfeed für die Admin-Zeiterfassungsseite: Time-Entries und
 * Termine pro Mitarbeiter, bereits server-seitig nach `userId` gruppiert. Die
 * UI muss daher keine zwei parallelen Queries mehr ausführen oder selbst
 * gruppieren.
 */
export async function getAdminTimeTrackingOverview(
  filters: AdminTimeTrackingOverviewFilters,
): Promise<AdminTimeTrackingOverview> {
  const { year, month, userId, entryType } = filters;
  const isApptFilter = !!entryType && entryType.startsWith("appt_");
  const hasEntryTypeFilter = !!entryType && entryType !== "all";

  const monthStr = String(month).padStart(2, "0");
  const startDate = `${year}-${monthStr}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const endDate = `${year}-${monthStr}-${lastDay}`;

  const entries = isApptFilter
    ? []
    : await getAllTimeEntries({
        year,
        month,
        userId,
        entryType: hasEntryTypeFilter ? entryType : undefined,
      });

  const showAppointments = !hasEntryTypeFilter || isApptFilter;
  let rawAppts: Awaited<ReturnType<typeof getAllAppointmentsInRange>> = [];
  if (showAppointments) {
    rawAppts = userId !== undefined
      ? await getEmployeeAppointments(userId, startDate, endDate)
      : await getAllAppointmentsInRange(startDate, endDate);
  }

  const apptTypeFilter = entryType === "appt_erstberatung"
    ? "Erstberatung"
    : entryType === "appt_kundentermin"
      ? "Kundentermin"
      : null;

  const apptsFiltered = apptTypeFilter
    ? rawAppts.filter(a => a.appointmentType === apptTypeFilter)
    : rawAppts;

  const apptIds = apptsFiltered.map(a => a.id);
  const servicesByAppt = apptIds.length > 0
    ? await (await import("./appointments")).getAppointmentServiceDetailsByAppointmentIds(apptIds)
    : new Map<number, never[]>();

  const entriesByEmployeeId: Record<number, typeof entries> = {};
  for (const entry of entries) {
    (entriesByEmployeeId[entry.userId] ||= []).push(entry);
  }

  type EnrichedAppt = typeof apptsFiltered[number] & {
    appointmentServiceDetails: ReturnType<Map<number, never[]>['get']>;
  };
  const appointmentsByEmployeeId: Record<number, EnrichedAppt[]> = {};
  for (const appt of apptsFiltered) {
    const empId = appt.assignedEmployeeId;
    if (empId == null) continue;
    const enriched = {
      ...appt,
      appointmentServiceDetails: servicesByAppt.get(appt.id) || [],
    } as EnrichedAppt;
    (appointmentsByEmployeeId[empId] ||= []).push(enriched);
  }

  // Cast: storage returns Date objects which become ISO strings after JSON
  // serialization (matches the AdminTimeTrackingOverview API contract).
  return {
    entriesByEmployeeId,
    appointmentsByEmployeeId,
  } as unknown as AdminTimeTrackingOverview;
}
