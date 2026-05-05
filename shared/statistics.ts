export interface StatisticsPeriod {
  year: number;
  month?: number | null;
  from?: string | null;
  to?: string | null;
}

export interface KpiValue {
  current: number;
  /** Previous period (month-over-month if month given, else previous year). */
  previous: number | null;
  deltaAbs: number | null;
  deltaPct: number | null;
  /** Same period one year earlier (year-over-year). */
  previousYear: number | null;
  deltaYearAbs: number | null;
  deltaYearPct: number | null;
}

export interface SparklinePoint {
  period: string;
  value: number;
}

export interface DrillDownRow {
  id: number;
  label: string;
  date?: string | null;
  employeeName?: string | null;
  link?: string | null;
}

export type RevenueStage = "planned" | "documented" | "proven" | "invoiced";

export interface RevenueStageBreakdown {
  planned: KpiValue;
  documented: KpiValue;
  proven: KpiValue;
  invoiced: KpiValue;
}

export interface ServiceTypeMinutesBreakdown {
  hauswirtschaft: number;
  alltagsbegleitung: number;
  erstberatung: number;
  sonstige: number;
}

export interface CockpitResponse {
  period: StatisticsPeriod;
  revenueByStage: RevenueStageBreakdown;
  activeCustomers: KpiValue;
  netCustomerGrowth: KpiValue;
  totalMinutes: KpiValue;
  minutesByServiceType: ServiceTypeMinutesBreakdown;
  appointmentsPerCustomer: KpiValue;
  revenuePerCustomer: KpiValue;
  sparklines: {
    revenueDocumented: SparklinePoint[];
    activeCustomers: SparklinePoint[];
    totalMinutes: SparklinePoint[];
    appointmentsPerCustomer: SparklinePoint[];
    revenuePerCustomer: SparklinePoint[];
  };
}

export type HealthScore = "gruen" | "gelb" | "rot";

export interface HealthThresholds {
  yellow: number;
  red: number;
}

export interface ProcessHealthSummary {
  period: StatisticsPeriod;
  customersWithoutEmployee: KpiValue;
  customersWithoutAppointments: KpiValue;
  undocumentedAppointments: KpiValue;
  appointmentsWithoutRecord: KpiValue;
  recordsWithoutInvoice: KpiValue;
  total: KpiValue;
  healthScore: HealthScore;
  thresholds: HealthThresholds;
  sparklines: {
    customersWithoutEmployee: SparklinePoint[];
    customersWithoutAppointments: SparklinePoint[];
    undocumentedAppointments: SparklinePoint[];
    appointmentsWithoutRecord: SparklinePoint[];
    recordsWithoutInvoice: SparklinePoint[];
  };
}

export interface ProcessHealthRow extends DrillDownRow {
  customerId?: number | null;
  appointmentId?: number | null;
  serviceRecordId?: number | null;
  invoiceId?: number | null;
}

export interface CustomerFunnel {
  prospect: number;
  inConsultation: number;
  active: number;
  inactive: number;
  terminated: number;
}

export interface CustomerStatsResponse {
  period: StatisticsPeriod;
  funnel: CustomerFunnel;
  activeCustomers: KpiValue;
  conversionRatePct: KpiValue;
  avgDaysConsultationToFirstAppointment: number | null;
  monthlyGainedLost: { month: number; gained: number; lost: number }[];
  cancellationRatePct: { month: number; ratePct: number }[];
  churnEarlyWarning: ChurnRiskCustomer[];
  pflegegradMix: { pflegegrad: number | null; count: number; revenueCents: number }[];
  plannedConsultations: number;
  projectedNewCustomers: number;
  topCustomersByRevenue: { id: number; name: string; revenueCents: number }[];
  unusedBudgetCustomers: { id: number; name: string; remainingCents: number; remainingPct: number }[];
}

export interface ChurnRiskCustomer {
  id: number;
  name: string;
  apptsLast30: number;
  apptsBaselineMonthly: number;
  riskScore: number;
}

export interface RevenueByDimensionRow {
  id: number;
  name: string;
  planned: number;
  documented: number;
  proven: number;
  invoiced: number;
}

export interface RevenueStatsResponse {
  period: StatisticsPeriod;
  byStage: RevenueStageBreakdown;
  byServiceType: { serviceType: string; planned: number; documented: number; proven: number; invoiced: number }[];
  byEmployee: RevenueByDimensionRow[];
  byCustomer: RevenueByDimensionRow[];
  gaps: {
    documentedMinusProvenCents: number;
    documentedMinusProvenCount: number;
    provenMinusInvoicedCents: number;
    provenMinusInvoicedCount: number;
  };
  timeToDocumentDays: { month: number; avgDays: number }[];
  timeToInvoiceDays: { month: number; avgDays: number }[];
  monthForecastCents: number;
  travelCostRatioPct: number;
  travelCostRatioByEmployee: { employeeId: number; employeeName: string; ratioPct: number }[];
}

export interface PerformanceStatsResponse {
  period: StatisticsPeriod;
  minutesByMonth: { month: number; hauswirtschaft: number; alltagsbegleitung: number; erstberatung: number; sonstige: number }[];
  avgDurationByServiceType: { serviceType: string; avgMinutes: number }[];
  utilization: {
    productiveMinutes: KpiValue;
    overheadMinutes: KpiValue;
    sickVacationMinutes: KpiValue;
    productivePct: number;
    overheadPct: number;
    sickVacationPct: number;
  };
  revenuePerHour: { totalCentsPerHour: KpiValue; byEmployee: { employeeId: number; employeeName: string; centsPerHour: number }[] };
}

export interface BudgetPotRow {
  customerId: number;
  customerName: string;
  budgetType: string;
  yearlyBudgetCents: number;
  usedCents: number;
  expectedProRataPct: number;
  forecastYearEndCents: number;
  forecastPct: number;
  status: HealthScore;
}

export interface BudgetStatsResponse {
  period: StatisticsPeriod;
  rows: BudgetPotRow[];
  aggregateByStatus: { budgetType: string; gruen: number; gelb: number; rot: number }[];
  totalUsedCents: KpiValue;
  totalAllocatedCents: KpiValue;
}
