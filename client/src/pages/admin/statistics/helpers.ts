import { formatCurrency } from "@shared/utils/format";

export function cents(value: number | string | bigint | null | undefined): string {
  if (value == null) return formatCurrency(0);
  const num = typeof value === "string" ? parseInt(value) || 0 : Number(value) || 0;
  return formatCurrency(num);
}

export function pct(a: number, b: number): string {
  if (b === 0) return "0%";
  return `${Math.round((a / b) * 100)}%`;
}

export function hours(minutes: number | null | undefined): string {
  const min = Number(minutes) || 0;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}min`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}min`;
}

export const SERVICE_TYPE_LABELS: Record<string, string> = {
  hauswirtschaft: "Hauswirtschaft",
  alltagsbegleitung: "Alltagsbegleitung",
  erstberatung: "Erstberatung",
};

export const SERVICE_TYPE_COLORS: Record<string, string> = {
  hauswirtschaft: "#3b82f6",
  alltagsbegleitung: "#14b8a6",
  erstberatung: "#f59e0b",
};

export const ENTRY_TYPE_LABELS: Record<string, string> = {
  verfuegbar: "Verfügbar",
  urlaub: "Urlaub",
  krank: "Krank",
  pause: "Pause",
  bueroarbeit: "Büroarbeit",
  besprechung: "Besprechung",
  vertrieb: "Vertrieb",
  sonstiges: "Sonstiges",
  weiterbildung: "Weiterbildung",
};

export const ENTRY_TYPE_COLORS: Record<string, string> = {
  verfuegbar: "#22c55e",
  urlaub: "#f59e0b",
  krank: "#ef4444",
  pause: "#94a3b8",
  bueroarbeit: "#6366f1",
  besprechung: "#8b5cf6",
  vertrieb: "#0ea5e9",
  sonstiges: "#a3a3a3",
  weiterbildung: "#ec4899",
};

export interface MarginData {
  revenueCents: number;
  costCents: number;
  marginCents: number;
  marginPercent: number;
  appointments: number;
  totalMinutes: number;
}

export interface UtilizationData {
  productiveMinutes: number;
  overheadMinutes: number;
  percent: number;
  appointments: number;
}

export interface BudgetData {
  allocatedCents: number;
  usedCents: number;
  percent: number;
  customerCount: number;
}

export interface BudgetPrevData {
  allocatedCents: number;
  usedCents: number;
  percent: number;
}

export interface CockpitData {
  month: number | null;
  year: number;
  hasPreviousMonth: boolean;
  margin: MarginData;
  marginPrev: MarginData | null;
  utilization: UtilizationData;
  utilizationPrev: UtilizationData | null;
  budget: BudgetData;
  budgetPrev: BudgetPrevData | null;
}

export interface MonthlyTrend {
  month: number;
  revenueCents: number;
  invoiceCount: number;
  appointmentCount: number;
  completedCount: number;
  completedHauswirtschaft: number;
  completedAlltagsbegleitung: number;
  completedErstberatungen: number;
  cancelledCount: number;
  activeCustomers: number;
  hwMinutes: number;
  abMinutes: number;
  ebMinutes: number;
  pauseMinutes: number;
  urlaubMinutes: number;
  krankMinutes: number;
  bueroarbeitMinutes: number;
  besprechungMinutes: number;
  vertriebMinutes: number;
  sonstigesMinutes: number;
  weiterbildungMinutes: number;
}

export interface EmployeeOverview {
  id: number;
  name: string;
  appointments: number;
  customers: number;
  workMinutes: number;
  travelKm: number;
  travelMinutes: number;
  customerKm: number;
  sickDays: number;
  vacationDays: number;
  officeMinutes: number;
  revenueCents: number;
}

export interface CustomerStats {
  activeCustomers: number;
  inactiveCustomers: number;
  prospects: number;
  terminated: number;
  avgAppointmentsPerCustomer: number;
  plannedConsultations: number;
  plannedConsultationsFuture: number;
  plannedConsultationsPast: number;
  consultation?: number;
}

export interface PflegegradEntry {
  pflegegrad: number;
  count: number;
}

export interface BudgetUtilization {
  totalAllocatedCents: number;
  totalUsedCents: number;
  customerCount: number;
}

export interface OverviewResponse {
  year: number;
  month: number | null;
  employees: EmployeeOverview[];
  revenue: Record<string, number>;
  customers: CustomerStats;
  efficiency: Record<string, number>;
  monthlyTrends: MonthlyTrend[];
  pflegegradDistribution: PflegegradEntry[];
  budgetUtilization: BudgetUtilization;
  cockpit: CockpitData;
}

export interface AlertItem {
  severity: "rot" | "gelb" | "gruen";
  title: string;
  description: string;
  count: number;
  link?: string;
}

export interface ServicePrice {
  code: string;
  priceCents: number;
  rateCents: number;
}

export interface ProfitabilityEmployee {
  employeeId: number;
  employeeName: string;
  appointments: number;
  customers: number;
  totalMinutes: number;
  totalTravelKm: number;
  totalCustomerKm: number;
  revenueCents: number;
  costCents: number;
  marginCents: number;
  revenueServiceCents: number;
  revenueKmCents: number;
  costServiceCents: number;
  costKmCents: number;
}

export interface ProfitabilityTotals {
  appointments: number;
  customers: number;
  totalMinutes: number;
  revenueCents: number;
  costCents: number;
  marginCents: number;
  revenueServiceCents: number;
  revenueKmCents: number;
  costServiceCents: number;
  costKmCents: number;
}

export interface ProfitabilityResponse {
  employees: ProfitabilityEmployee[];
  totals: ProfitabilityTotals;
  servicePrices: ServicePrice[];
  marginPercent: number;
}

export interface HoursByType {
  service_type?: string;
  entry_type?: string;
  total_minutes: number;
}

export interface CustomerLifecycleMonth {
  month: number;
  customersGained: number;
  customersLost: number;
}

export interface GrowthSummary {
  activeCustomers: number;
  gainedThisYear: number;
  lostThisYear: number;
  netGrowth: number;
  gainedPrevYear: number;
  lostPrevYear: number;
}

export interface GrowthResponse {
  year: number;
  hoursByServiceType: HoursByType[];
  hoursByEntryType: HoursByType[];
  customerLifecycle: CustomerLifecycleMonth[];
  summary: GrowthSummary;
}

export interface BudgetPotentialCustomer {
  id: number;
  name: string;
  pflegegrad: number;
  unusedCents: number;
  percent: number;
}

export interface BudgetPotentialResponse {
  customers: BudgetPotentialCustomer[];
}

export interface PlanningEmployee {
  employeeId: number;
  employeeName: string;
  appointments: number;
  scheduledCount: number;
  completedCount: number;
  documentedCount: number;
  customers: number;
  totalMinutes: number;
  revenueCents: number;
  costCents: number;
  marginCents: number;
  revenueServiceCents: number;
  revenueKmCents: number;
  costServiceCents: number;
  costKmCents: number;
}

export interface PlanningTotals {
  appointments: number;
  scheduledCount: number;
  completedCount: number;
  documentedCount: number;
  customers: number;
  totalMinutes: number;
  revenueCents: number;
  costCents: number;
  marginCents: number;
  revenueServiceCents: number;
  revenueKmCents: number;
  costServiceCents: number;
  costKmCents: number;
}

export interface CustomerWithoutAppointment {
  id: number;
  name: string;
  vorname: string;
  nachname: string;
  pflegegrad: number | null;
  primaryEmployeeName: string | null;
}

export interface PlanningResponse {
  employees: PlanningEmployee[];
  totals: PlanningTotals;
  servicePrices: ServicePrice[];
  marginPercent: number;
  customersWithoutAppointments: CustomerWithoutAppointment[];
}
