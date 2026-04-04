import type { Appointment, Customer } from "../schema";

export interface AppointmentWithCustomerResponse extends Appointment {
  customer: Customer | null;
  assignedEmployeeName?: string | null;
  isLocked?: boolean;
  isMonthClosed?: boolean;
  lockedReason?: string;
}

export interface AppointmentCountsResponse {
  [date: string]: number;
}

export interface CoverageUncoveredCustomer {
  id: number;
  name: string;
  role: string;
  primaryEmployeeName?: string;
}

export interface CoverageMonthData {
  label: string;
  year: number;
  month: number;
  uncoveredCustomers: CoverageUncoveredCustomer[];
}

export interface CoverageCheckResponse {
  currentMonth: CoverageMonthData;
  nextMonth: CoverageMonthData;
}
