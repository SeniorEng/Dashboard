/**
 * Facade für das Zeiten-/Time-Tracking-Storage-Modul.
 *
 * Die eigentliche Implementierung ist in Sub-Module unter
 * `./time-tracking/` aufgeteilt:
 *  - `entries.ts`        – CRUD auf `employeeTimeEntries`
 *  - `vacation.ts`       – Urlaubs-Kontingent + Summary
 *  - `appointments.ts`   – Termin-Listen für die Zeiten-Sicht
 *  - `overview.ts`       – Monatsübersicht + offene Aufgaben
 *  - `month-closing.ts`  – Monatsabschluss-Logik
 *  - `shared.ts`         – gemeinsame Typen + Filter-Helfer
 *
 * Diese Datei reexportiert das öffentliche API als Klasse mit fester
 * Methoden-Oberfläche, damit bestehende Aufrufer (Routes, andere Storage-
 * Module) keine Änderungen benötigen.
 */

import type {
  EmployeeTimeEntry,
  InsertTimeEntry,
  UpdateTimeEntry,
  EmployeeVacationAllowance,
  InsertVacationAllowance,
  VacationEntitlementHistory,
  InsertVacationEntitlementHistory,
} from "@shared/schema";
import type {
  VacationSummary,
  AppointmentWithCustomerName,
  ServiceHoursSummary,
  TravelSummary,
  TimeEntrySummary,
  TimeOverviewData,
} from "@shared/api";
import type { MissingBreakDay, OpenTasksSummary } from "@shared/types";
import type { DbOrTx } from "../lib/db";

import {
  type TimeEntryFilters,
  type TimeOverviewFilters,
} from "./time-tracking/shared";
import * as entriesModule from "./time-tracking/entries";
import * as vacationModule from "./time-tracking/vacation";
import * as appointmentsModule from "./time-tracking/appointments";
import * as overviewModule from "./time-tracking/overview";
import * as monthClosingModule from "./time-tracking/month-closing";

export type {
  TimeEntryFilters,
  TimeOverviewFilters,
};
export type {
  VacationSummary,
  AppointmentWithCustomerName,
  ServiceHoursSummary,
  TravelSummary,
  TimeEntrySummary,
  TimeOverviewData,
};
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
  getVacationEntitlementHistoryForUser(userId: number): Promise<VacationEntitlementHistory[]>;
  upsertVacationEntitlementHistory(data: InsertVacationEntitlementHistory): Promise<VacationEntitlementHistory>;

  // Admin views
  getAllTimeEntries(filters?: TimeEntryFilters & { userId?: number }): Promise<(EmployeeTimeEntry & { user: { displayName: string } })[]>;

  // Time Overview (combined appointments + time entries)
  getTimeOverview(userId: number, filters: TimeOverviewFilters): Promise<TimeOverviewData>;
  getEmployeeAppointments(userId: number, startDate: string, endDate: string): Promise<AppointmentWithCustomerName[]>;
  getAllAppointmentsInRange(startDate: string, endDate: string): Promise<AppointmentWithCustomerName[]>;

  // Open Tasks
  getOpenTasks(userId: number): Promise<OpenTasksSummary>;
}

export const timeTrackingStorage = {
  // entries
  getTimeEntries: entriesModule.getTimeEntries,
  getTimeEntry: entriesModule.getTimeEntry,
  getTimeEntriesForDate: entriesModule.getTimeEntriesForDate,
  createTimeEntry: entriesModule.createTimeEntry,
  createTimeEntriesForDates: entriesModule.createTimeEntriesForDates,
  collectWeekdayDates: entriesModule.collectWeekdayDates,
  updateTimeEntry: entriesModule.updateTimeEntry,
  deleteTimeEntry: entriesModule.deleteTimeEntry,
  getAllTimeEntries: entriesModule.getAllTimeEntries,

  // vacation
  getVacationAllowance: vacationModule.getVacationAllowance,
  setVacationAllowance: vacationModule.setVacationAllowance,
  getVacationSummary: vacationModule.getVacationSummary,
  getVacationEntitlementHistoryForUser: vacationModule.getVacationEntitlementHistoryForUser,
  getVacationEntitlementHistoryForUsers: vacationModule.getVacationEntitlementHistoryForUsers,
  upsertVacationEntitlementHistory: vacationModule.upsertVacationEntitlementHistory,
  computeAnnualEntitlement: vacationModule.computeAnnualEntitlement,

  // appointments
  getEmployeeAppointments: appointmentsModule.getEmployeeAppointments,
  getAllAppointmentsInRange: appointmentsModule.getAllAppointmentsInRange,
  getAppointmentServiceDetailsByAppointmentIds: appointmentsModule.getAppointmentServiceDetailsByAppointmentIds,

  // overview
  getTimeOverview: overviewModule.getTimeOverview,
  getOpenTasks: overviewModule.getOpenTasks,

  // month closing
  isMonthClosed: monthClosingModule.isMonthClosed,
  getMonthClosingReadiness: monthClosingModule.getMonthClosingReadiness,
  getAdminMonthClosingReadiness: monthClosingModule.getAdminMonthClosingReadiness,
  getMonthClosing: monthClosingModule.getMonthClosing,
  getAdminMonthClosings: monthClosingModule.getAdminMonthClosings,
  closeMonth: monthClosingModule.closeMonth,
  reopenMonth: monthClosingModule.reopenMonth,
} as const;

// Stable module type alias (used by some callers via inference).
export type TimeTrackingStorage = typeof timeTrackingStorage;

// Re-export the close-month signature type so Drizzle DbOrTx flow stays intact for callers.
export type { DbOrTx };
