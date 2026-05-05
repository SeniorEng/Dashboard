import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { KpiTile } from "@/components/charts";
import { Users, UserPlus, UserMinus, AlertTriangle, TrendingUp, PiggyBank, CalendarCheck } from "lucide-react";
import { api, unwrapResult } from "@/lib/api/client";
import { MONTH_NAMES } from "@/features/time-tracking/constants";
import type { CustomerStatsResponse, ChurnRiskCustomer } from "@shared/statistics";
import { cents } from "../helpers";
import { StatsPageShell, StatsLoading, StatsError, buildPeriodQs } from "./page-shell";
import { DrillDownTable } from "./drill-down-table";

type TopCustomer = CustomerStatsResponse["topCustomersByRevenue"][number];
type UnusedBudgetCustomer = CustomerStatsResponse["unusedBudgetCustomers"][number];
type PflegegradRow = CustomerStatsResponse["pflegegradMix"][number];
type MonthlyDelta = CustomerStatsResponse["monthlyGainedLost"][number] & { ratePct?: number };

const PFLEGEGRAD_LABEL = (pg: number | null) => pg == null || pg === 0 ? "Ohne Pflegegrad" : `Pflegegrad ${pg}`;

export default function CustomersPage() {
  return (
    <StatsPageShell
      title="Kunden-Dashboard"
      description="Funnel, Wachstum, Churn-Risiko, Pflegegrad-Mix und Top-Kunden."
      icon={<Users className="w-6 h-6" />}
      testId="customers-dashboard"
    >
      {({ qs, year }) => <CustomersContent qs={qs} year={year} />}
    </StatsPageShell>
  );
}

export function CustomersSection({ selectedYear, selectedMonth }: { selectedYear: number; selectedMonth: string }) {
  return (
    <div data-testid="customers-dashboard">
      <CustomersContent qs={buildPeriodQs(selectedYear, selectedMonth)} year={selectedYear} />
    </div>
  );
}

function CustomersContent({ qs, year }: { qs: string; year: number }) {
  const query = useQuery<CustomerStatsResponse>({
    queryKey: ["statistics-v2-customers", qs],
    queryFn: async () => unwrapResult(await api.get<CustomerStatsResponse>(`/statistics/v2/customers?${qs}`)),
    staleTime: 60_000,
  });

  if (query.isLoading) return <StatsLoading testId="customers-loading" />;
  if (query.isError || !query.data) return <StatsError testId="customers-error" />;

  const data = query.data;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4" data-testid="customers-kpis">
        <KpiTile
          title="Aktive Kunden"
          icon={<Users className="w-5 h-5" />}
          value={String(data.activeCustomers.current)}
          delta={{ abs: data.activeCustomers.deltaAbs, pct: data.activeCustomers.deltaPct }}
          deltaLabel="vs. Vormonat"
          higherIsBetter
          testId="kpi-active-customers"
        />
        <KpiTile
          title="Conversion-Rate"
          icon={<TrendingUp className="w-5 h-5" />}
          value={`${data.conversionRatePct.current}%`}
          delta={{ abs: data.conversionRatePct.deltaAbs, pct: data.conversionRatePct.deltaPct }}
          deltaLabel="vs. Vormonat"
          higherIsBetter
          testId="kpi-conversion-rate"
        />
        <KpiTile
          title="Ø Tage bis 1. Termin"
          icon={<CalendarCheck className="w-5 h-5" />}
          value={data.avgDaysConsultationToFirstAppointment != null
            ? `${data.avgDaysConsultationToFirstAppointment} d`
            : "–"}
          higherIsBetter={false}
          testId="kpi-days-to-first-appointment"
        />
        <KpiTile
          title="Geplante Erstbesuche"
          icon={<UserPlus className="w-5 h-5" />}
          value={String(data.plannedConsultations)}
          subValue={
            data.projectedNewCustomersRange.sampleSize > 0
              ? `Prognose neu: ${data.projectedNewCustomers} (95%-KI ${data.projectedNewCustomersRange.lower}–${data.projectedNewCustomersRange.upper}, n=${data.projectedNewCustomersRange.sampleSize})`
              : `Prognose neu: ${data.projectedNewCustomers}`
          }
          higherIsBetter
          testId="kpi-planned-consultations"
        />
      </div>

      <Card data-testid="customer-funnel">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Kunden-Funnel</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-sm">
            <FunnelStep label="Interessent" value={data.funnel.prospect} testId="funnel-prospect" />
            <FunnelStep label="In Beratung" value={data.funnel.inConsultation} testId="funnel-in-consultation" />
            <FunnelStep label="Aktiv" value={data.funnel.active} testId="funnel-active" highlight />
            <FunnelStep label="Inaktiv" value={data.funnel.inactive} testId="funnel-inactive" />
            <FunnelStep label="Gekündigt" value={data.funnel.terminated} testId="funnel-terminated" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs" data-testid="funnel-conversion-rates">
            <ConversionStep
              label="Interessent → In Beratung"
              pct={data.funnelConversionRates.prospectToConsultationPct}
              testId="conversion-prospect-to-consultation"
            />
            <ConversionStep
              label="In Beratung → Aktiv"
              pct={data.funnelConversionRates.consultationToActivePct}
              testId="conversion-consultation-to-active"
            />
            <ConversionStep
              label="Aktiv-Anteil (Retention)"
              pct={data.funnelConversionRates.retentionPct}
              testId="conversion-retention"
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Monatliche Veränderung {year}</CardTitle>
        </CardHeader>
        <CardContent>
          <DrillDownTable<MonthlyDelta>
            rows={data.monthlyGainedLost.map((m) => ({
              ...m,
              ratePct: data.cancellationRatePct.find((c) => c.month === m.month)?.ratePct ?? 0,
            }))}
            columns={[
              { key: "month", label: "Monat", render: (r) => MONTH_NAMES[r.month - 1] ?? `M${r.month}`, sortBy: (r) => r.month },
              { key: "gained", label: "Neu", render: (r) => r.gained, align: "right", sortBy: (r) => r.gained },
              { key: "lost", label: "Verloren", render: (r) => r.lost, align: "right", sortBy: (r) => r.lost },
              { key: "net", label: "Netto", render: (r) => r.gained - r.lost, align: "right", sortBy: (r) => r.gained - r.lost },
              { key: "rate", label: "Stornoquote", render: (r) => `${r.ratePct ?? 0}%`, align: "right", sortBy: (r) => r.ratePct ?? 0 },
            ]}
            getRowId={(r) => r.month}
            testId="customers-monthly"
            csvFilename={`kunden-monatlich-${year}`}
          />
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <PiggyBank className="w-4 h-4" />
              Pflegegrad-Mix
            </CardTitle>
          </CardHeader>
          <CardContent>
            <DrillDownTable<PflegegradRow>
              rows={data.pflegegradMix}
              columns={[
                { key: "pflegegrad", label: "Pflegegrad", render: (r) => PFLEGEGRAD_LABEL(r.pflegegrad), sortBy: (r) => r.pflegegrad ?? -1 },
                { key: "count", label: "Kunden", render: (r) => r.count, align: "right", sortBy: (r) => r.count },
                { key: "revenue", label: "Umsatz", render: (r) => cents(r.revenueCents), csvValue: (r) => r.revenueCents, align: "right", sortBy: (r) => r.revenueCents },
              ]}
              getRowId={(r) => r.pflegegrad ?? "none"}
              testId="customers-pflegegrad"
              csvFilename={`pflegegrad-mix-${year}`}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2 text-amber-700">
              <AlertTriangle className="w-4 h-4" />
              Frühwarnung Churn
            </CardTitle>
          </CardHeader>
          <CardContent>
            <DrillDownTable<ChurnRiskCustomer>
              rows={data.churnEarlyWarning}
              columns={[
                { key: "name", label: "Kunde", render: (r) => r.name },
                { key: "appts30", label: "Termine 30 T", render: (r) => r.apptsLast30, align: "right", sortBy: (r) => r.apptsLast30 },
                { key: "baseline", label: "Ø Monat", render: (r) => r.apptsBaselineMonthly, align: "right", sortBy: (r) => r.apptsBaselineMonthly, hideOnMobile: true },
                { key: "risk", label: "Risiko", render: (r) => `${r.riskScore}%`, csvValue: (r) => r.riskScore, align: "right", sortBy: (r) => r.riskScore },
                { key: "reason", label: "Begründung", render: (r) => r.reason, hideOnMobile: true },
              ]}
              getRowId={(r) => r.id}
              getRowLink={(r) => `/admin/customers/${r.id}`}
              testId="customers-churn"
              csvFilename={`churn-fruehwarnung-${year}`}
              emptyMessage="Keine Kunden mit auffällig sinkender Aktivität."
            />
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Top-Kunden nach Umsatz</CardTitle>
          </CardHeader>
          <CardContent>
            <DrillDownTable<TopCustomer>
              rows={data.topCustomersByRevenue}
              columns={[
                { key: "name", label: "Kunde", render: (r) => r.name },
                { key: "revenue", label: "Umsatz", render: (r) => cents(r.revenueCents), csvValue: (r) => r.revenueCents, align: "right", sortBy: (r) => r.revenueCents },
              ]}
              getRowId={(r) => r.id}
              getRowLink={(r) => `/admin/customers/${r.id}`}
              testId="customers-top-revenue"
              csvFilename={`top-kunden-${year}`}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <UserMinus className="w-4 h-4" />
              Ungenutzte Budgets
            </CardTitle>
          </CardHeader>
          <CardContent>
            <DrillDownTable<UnusedBudgetCustomer>
              rows={data.unusedBudgetCustomers}
              columns={[
                { key: "name", label: "Kunde", render: (r) => r.name },
                { key: "remaining", label: "Rest", render: (r) => cents(r.remainingCents), csvValue: (r) => r.remainingCents, align: "right", sortBy: (r) => r.remainingCents },
                { key: "pct", label: "Rest %", render: (r) => `${r.remainingPct}%`, csvValue: (r) => r.remainingPct, align: "right", sortBy: (r) => r.remainingPct },
              ]}
              getRowId={(r) => r.id}
              getRowLink={(r) => `/admin/customers/${r.id}`}
              testId="customers-unused-budget"
              csvFilename={`ungenutzte-budgets-${year}`}
              emptyMessage="Alle Kundenbudgets werden gut genutzt."
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function ConversionStep({ label, pct, testId }: { label: string; pct: number; testId: string }) {
  return (
    <div className="flex items-center justify-between rounded-md border bg-muted/20 px-3 py-2" data-testid={testId}>
      <span className="text-muted-foreground">{label}</span>
      <span className="font-semibold tabular-nums">{pct}%</span>
    </div>
  );
}

function FunnelStep({ label, value, testId, highlight }: { label: string; value: number; testId: string; highlight?: boolean }) {
  return (
    <div
      className={`rounded-lg p-3 ${highlight ? "bg-teal-50 border border-teal-200" : "bg-muted/30"}`}
      data-testid={testId}
    >
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-2xl font-bold ${highlight ? "text-teal-700" : ""}`}>{value}</div>
    </div>
  );
}
