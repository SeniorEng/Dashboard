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

interface DrillDownRow {
  id: number;
  label: string;
  date?: string | null;
  employeeName?: string | null;
  link?: string | null;
}

export type RevenueStage = "planned" | "documented" | "proven" | "invoiced";

interface RevenueStageBreakdown {
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

interface CustomerFunnel {
  prospect: number;
  inConsultation: number;
  active: number;
  inactive: number;
  terminated: number;
}

interface FunnelConversionRates {
  /** Anteil Interessent → In Beratung (in %). */
  prospectToConsultationPct: number;
  /** Anteil In Beratung → Aktiv (in %). */
  consultationToActivePct: number;
  /** Aktiv-Anteil von allen jemals aktiven Kunden (Aktiv / (Aktiv + Inaktiv + Gekündigt)). */
  retentionPct: number;
}

interface ProjectedGrowthRange {
  /** Punkt-Schätzung (planned * Conversion-Rate). */
  point: number;
  /** Untere Grenze 95%-Wilson-Konfidenz. */
  lower: number;
  /** Obere Grenze 95%-Wilson-Konfidenz. */
  upper: number;
  /** Anzahl historischer Erstberatungen (Sample-Größe). */
  sampleSize: number;
}

/**
 * Task #1194 — Aufschlüsselung der aktiven Kunden in „laufend" (ohne
 * Vertragsende / nicht gekündigt) vs. „gekündigt" (aktiv, aber Vertrag beendet
 * oder gekündigt). Summe entspricht `funnel.active`; die Funnel-Zahlen selbst
 * bleiben unverändert.
 */
/**
 * Aufteilung der aktiven Kohorte nach Lebenszyklus. Die Schluessel entsprechen
 * `ActiveCustomerLifecycle` — ein Wert dort ohne Feld hier laesst die Summe
 * nicht mehr aufgehen.
 */
interface ActiveCustomerBreakdown {
  laufend: number;
  pausiert: number;
  gekuendigt: number;
}

export interface CustomerStatsResponse {
  period: StatisticsPeriod;
  funnel: CustomerFunnel;
  funnelConversionRates: FunnelConversionRates;
  activeBreakdown: ActiveCustomerBreakdown;
  activeCustomers: KpiValue;
  conversionRatePct: KpiValue;
  avgDaysConsultationToFirstAppointment: number | null;
  monthlyGainedLost: { month: number; gained: number; lost: number }[];
  cancellationRatePct: { month: number; ratePct: number }[];
  churnEarlyWarning: ChurnRiskCustomer[];
  pflegegradMix: { pflegegrad: number | null; count: number; revenueCents: number }[];
  plannedConsultations: number;
  projectedNewCustomers: number;
  projectedNewCustomersRange: ProjectedGrowthRange;
  topCustomersByRevenue: { id: number; name: string; revenueCents: number }[];
  unusedBudgetCustomers: { id: number; name: string; remainingCents: number; remainingPct: number }[];
}

export interface ChurnRiskCustomer {
  id: number;
  name: string;
  apptsLast30: number;
  apptsBaselineMonthly: number;
  riskScore: number;
  /** Klartext-Begründung warum dieser Kunde im Frühwarn-Score steht. */
  reason: string;
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
  timeToDocumentDays: { month: number; avgDays: number; medianDays: number; p90Days: number }[];
  timeToInvoiceDays: { month: number; avgDays: number; medianDays: number; p90Days: number }[];
  monthForecastCents: number;
  /** Geplante Erlöse / Kosten / Marge / Stunden / Termine im Auswahl-Zeitraum
   *  (Stand: alle nicht-stornierten Termine, unabhängig vom Status — also
   *  inkl. künftiger scheduled-Termine). Migriert aus dem alten Planung-Tab. */
  planned: PlannedRevenueTotals;
  travelCostRatioPct: number;
  travelCostRatioByEmployee: { employeeId: number; employeeName: string; ratioPct: number }[];
  sparklines: {
    planned: SparklinePoint[];
    documented: SparklinePoint[];
    proven: SparklinePoint[];
    invoiced: SparklinePoint[];
  };
  /** Task #1355 — Erlös-Trichter zusätzlich in Minuten (Geplant/Dokumentiert/
   *  Nachgewiesen/Berechnet), Teil des Wirtschaftlichkeits-Blocks. */
  stageHours: RevenueStageHours;
  /** Task #1355 — Wirtschaftlichkeits-Aufstellung (Personalkosten,
   *  km, Deckungsbeitrag) für den gewählten Zeitraum. */
  economics: EconomicsBreakdown;
}

export interface RevenueStageHours {
  plannedMinutes: number;
  documentedMinutes: number;
  provenMinutes: number;
  invoicedMinutes: number;
}

// ============================================================
// Task #1355 — Wirtschaftlichkeit (SSoT, siehe shared/domain/statistics/economics.ts)
// ============================================================

/** Sätze ausschließlich aus dem Service-Katalog (Integer-Cents). */
export interface EconomicsRatesCents {
  /** employee_rate_cents — an Mitarbeiter ausgezahlte Stundensätze. */
  hauswirtschaftRateCents: number;
  alltagsbegleitungRateCents: number;
  erstberatungRateCents: number;
  /** employee_rate_cents pro km — an Mitarbeiter ausgezahlt (Kosten). */
  travelKmRateCents: number;
  customerKmRateCents: number;
  /** default_price_cents pro km — dem Kunden berechnet (Erlös). */
  travelKmPriceCents: number;
  customerKmPriceCents: number;
}

export interface EconomicsInput {
  rates: EconomicsRatesCents;
  hauswirtschaftMinutes: number;
  alltagsbegleitungMinutes: number;
  erstberatungMinutes: number;
  nonBillable: { category: string; minutes: number }[];
  travelKm: number;
  customerKm: number;
  timeEntryKm: number;
  /** Dokumentierter Service-Erlös (Stunden-Leistungen, ohne km). */
  documentedServiceRevenueCents: number;
  /**
   * Task #1503 — optional vorberechnete, rollenbasierte Personal-/km-KOSTEN
   * (über `wageFor` je leistendem Mitarbeiter × Leistung × Datum in SQL
   * aufgelöst). Ist dieses Feld gesetzt, ersetzt es die flache
   * `costForMinutes`/km-Kostenrechnung für die KOSTEN-Seite; die ERLÖS-Seite
   * (Preis) bleibt katalog-/preisgesteuert. Fehlt es, gilt das alte
   * flache-Satz-Verhalten (Rückwärtskompatibilität der reinen Unit-Tests).
   */
  costOverride?: EconomicsCostOverride;
}

/** Task #1503 — rollenbasiert (in SQL) vorberechnete Kosten-Beträge. */
export interface EconomicsCostOverride {
  hauswirtschaftCostCents: number;
  alltagsbegleitungCostCents: number;
  erstberatungCostCents: number;
  /** Kategorie → Kosten-Cents (zum HW-Lohnsatz der jeweils leistenden Rolle). */
  nonBillableCostCentsByCategory: Record<string, number>;
  travelKmPaidCents: number;
  customerKmPaidCents: number;
  timeEntryKmPaidCents: number;
}

export interface EconomicsCostGroup {
  minutes: number;
  costCents: number;
}

export interface EconomicsNonBillableCategory {
  category: string;
  label: string;
  minutes: number;
  costCents: number;
}

export interface EconomicsKmRow {
  km: number;
  /** dem Kunden berechnet (Erlös). */
  chargedCents: number;
  /** an Mitarbeiter ausgezahlt (Kosten). */
  paidCents: number;
}

export interface EconomicsBreakdown {
  rates: EconomicsRatesCents;
  personnel: {
    hauswirtschaft: EconomicsCostGroup;
    alltagsbegleitung: EconomicsCostGroup;
    /** Hauswirtschaft + Alltagsbegleitung. */
    billable: EconomicsCostGroup;
    erstberatung: EconomicsCostGroup;
    nonBillable: EconomicsCostGroup & { byCategory: EconomicsNonBillableCategory[] };
    totalMinutes: number;
    totalCostCents: number;
  };
  km: {
    travel: EconomicsKmRow;
    customer: EconomicsKmRow;
    /** Mitarbeiter-km aus der Zeiterfassung (nur Kostenseite). */
    timeEntry: EconomicsKmRow;
    totalChargedCents: number;
    totalPaidCents: number;
  };
  result: {
    /** Dokumentierter Service-Erlös + dem Kunden berechnete km. */
    revenueCents: number;
    documentedRevenueCents: number;
    kmChargedCents: number;
    personnelCostCents: number;
    kmPaidCents: number;
    totalCostCents: number;
    marginCents: number;
    marginPercent: number;
    /** Kundennahe Wertschöpfung (abrechenbar + Erstberatung + km). */
    productiveCostCents: number;
    /** Bezahlter Overhead (Büro/Vertrieb/Sonstiges/Krank/Urlaub). */
    nonBillableCostCents: number;
  };
}

/** Drill-down-Zeile: nicht-abrechenbare Stunden je Mitarbeiter + Kategorie. */
export interface EconomicsNonBillableDrillRow {
  employeeId: number;
  employeeName: string;
  category: string;
  categoryLabel: string;
  minutes: number;
  costCents: number;
}

export interface PlannedRevenueTotals {
  revenueCents: number;
  costCents: number;
  marginCents: number;
  marginPercent: number;
  totalMinutes: number;
  appointments: number;
  customers: number;
}

export interface RevenueGapRow {
  appointmentId: number;
  date: string;
  customerId: number | null;
  customerName: string;
  employeeId: number | null;
  employeeName: string | null;
  serviceType: string;
  revenueCents: number;
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
  /** Deckungsbeitrag pro Mitarbeiter + Kalkulationsgrundlage (HW/AB Erlös vs.
   *  Mitarbeiterkosten je Stunde). Migriert aus dem alten Team-Tab. */
  profitability: ProfitabilityBreakdown;
  /** Task #1358 — Wirtschaftlichkeits-Aufstellung (Personalkosten-Split +
   *  km-Block) für den gewählten Zeitraum, identisch zum Umsatz-Dashboard
   *  (gemeinsame SSoT getEconomics / buildEconomics). */
  economics: EconomicsBreakdown;
}

interface ProfitabilityEmployeeRow {
  employeeId: number;
  employeeName: string;
  revenueCents: number;
  costCents: number;
  marginCents: number;
  marginPercent: number;
  totalMinutes: number;
  appointments: number;
}

interface ServicePriceCalculationRow {
  code: string;
  label: string;
  priceCents: number;
  rateCents: number;
  marginCents: number;
  marginPercent: number;
}

export interface ProfitabilityBreakdown {
  totals: {
    revenueCents: number;
    costCents: number;
    marginCents: number;
    marginPercent: number;
  };
  byEmployee: ProfitabilityEmployeeRow[];
  servicePrices: ServicePriceCalculationRow[];
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
