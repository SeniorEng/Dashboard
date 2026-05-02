import type { Appointment, Customer } from "../schema";

export interface AppointmentWithCustomer extends Appointment {
  customer: Customer | null;
  assignedEmployeeName?: string | null;
  isLocked?: boolean;
  isMonthClosed?: boolean;
  lockedReason?: string;
}

interface CoverageUncoveredCustomer {
  id: number;
  name: string;
  role: string;
  primaryEmployeeName?: string;
}

interface CoverageMonthData {
  label: string;
  year: number;
  month: number;
  uncoveredCustomers: CoverageUncoveredCustomer[];
}

export interface CoverageCheckResponse {
  currentMonth: CoverageMonthData;
  nextMonth: CoverageMonthData;
}
