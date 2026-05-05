import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { KpiTile } from "@/components/charts";
import { Activity, Clock, TrendingUp, Briefcase, Heart, PiggyBank, Calculator } from "lucide-react";
import { api, unwrapResult } from "@/lib/api/client";
import { MONTH_NAMES } from "@/features/time-tracking/constants";
import type { PerformanceStatsResponse } from "@shared/statistics";
import { cents, hours } from "../helpers";
import { StatsPageShell, StatsLoading, StatsError, buildPeriodQs } from "./page-shell";
import { DrillDownTable } from "./drill-down-table";

type MinutesRow = PerformanceStatsResponse["minutesByMonth"][number];
type AvgDurationRow = PerformanceStatsResponse["avgDurationByServiceType"][number];
type EmpRow = PerformanceStatsResponse["revenuePerHour"]["byEmployee"][number];
type ProfitEmpRow = PerformanceStatsResponse["profitability"]["byEmployee"][number];
type ServicePriceRow = PerformanceStatsResponse["profitability"]["servicePrices"][number];

const SERVICE_LABELS: Record<string, string> = {
  hauswirtschaft: "Hauswirtschaft",
  alltagsbegleitung: "Alltagsbegleitung",
  erstberatung: "Erstberatung",
  sonstige: "Sonstige",
};

export default function PerformancePage() {
  return (
    <StatsPageShell
      title="Leistungs-Dashboard"
      description="Geleistete Stunden, Auslastung und Erlös pro Stunde."
      icon={<Activity className="w-6 h-6" />}
      testId="performance-dashboard"
    >
      {({ qs, year }) => <PerformanceContent qs={qs} year={year} />}
    </StatsPageShell>
  );
}

export function PerformanceSection({ selectedYear, selectedMonth }: { selectedYear: number; selectedMonth: string }) {
  return (
    <div data-testid="performance-dashboard">
      <PerformanceContent qs={buildPeriodQs(selectedYear, selectedMonth)} year={selectedYear} />
    </div>
  );
}

function PerformanceContent({ qs, year }: { qs: string; year: number }) {
  const query = useQuery<PerformanceStatsResponse>({
    queryKey: ["statistics-v2-performance", qs],
    queryFn: async () => unwrapResult(await api.get<PerformanceStatsResponse>(`/statistics/v2/performance?${qs}`)),
    staleTime: 60_000,
  });

  if (query.isLoading) return <StatsLoading testId="performance-loading" />;
  if (query.isError || !query.data) return <StatsError testId="performance-error" />;

  const data = query.data;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4" data-testid="performance-kpis">
        <KpiTile
          title="Produktive Zeit"
          icon={<Clock className="w-5 h-5" />}
          value={hours(data.utilization.productiveMinutes.current)}
          subValue={`${data.utilization.productivePct}%`}
          delta={{ abs: data.utilization.productiveMinutes.deltaAbs, pct: data.utilization.productiveMinutes.deltaPct }}
          deltaLabel="vs. Vormonat"
          higherIsBetter
          testId="kpi-productive"
        />
        <KpiTile
          title="Overhead"
          icon={<Briefcase className="w-5 h-5" />}
          value={hours(data.utilization.overheadMinutes.current)}
          subValue={`${data.utilization.overheadPct}%`}
          delta={{ abs: data.utilization.overheadMinutes.deltaAbs, pct: data.utilization.overheadMinutes.deltaPct }}
          deltaLabel="vs. Vormonat"
          higherIsBetter={false}
          testId="kpi-overhead"
        />
        <KpiTile
          title="Krank/Urlaub"
          icon={<Heart className="w-5 h-5" />}
          value={hours(data.utilization.sickVacationMinutes.current)}
          subValue={`${data.utilization.sickVacationPct}%`}
          delta={{ abs: data.utilization.sickVacationMinutes.deltaAbs, pct: data.utilization.sickVacationMinutes.deltaPct }}
          deltaLabel="vs. Vormonat"
          higherIsBetter={false}
          testId="kpi-sick-vacation"
        />
        <KpiTile
          title="Ø Erlös/Stunde"
          icon={<TrendingUp className="w-5 h-5" />}
          value={cents(data.revenuePerHour.totalCentsPerHour.current)}
          delta={{ abs: data.revenuePerHour.totalCentsPerHour.deltaAbs, pct: data.revenuePerHour.totalCentsPerHour.deltaPct }}
          deltaLabel="vs. Vormonat"
          higherIsBetter
          testId="kpi-revenue-per-hour"
        />
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Geleistete Stunden je Monat</CardTitle>
        </CardHeader>
        <CardContent>
          <DrillDownTable<MinutesRow>
            rows={data.minutesByMonth}
            columns={[
              { key: "month", label: "Monat", render: (r) => MONTH_NAMES[r.month - 1] ?? `M${r.month}`, sortBy: (r) => r.month },
              { key: "hw", label: "Hauswirtschaft", render: (r) => hours(r.hauswirtschaft), csvValue: (r) => r.hauswirtschaft, align: "right", sortBy: (r) => r.hauswirtschaft },
              { key: "ab", label: "Alltagsbegleitung", render: (r) => hours(r.alltagsbegleitung), csvValue: (r) => r.alltagsbegleitung, align: "right", sortBy: (r) => r.alltagsbegleitung },
              { key: "eb", label: "Erstberatung", render: (r) => hours(r.erstberatung), csvValue: (r) => r.erstberatung, align: "right", sortBy: (r) => r.erstberatung, hideOnMobile: true },
              { key: "rest", label: "Sonstige", render: (r) => hours(r.sonstige), csvValue: (r) => r.sonstige, align: "right", sortBy: (r) => r.sonstige, hideOnMobile: true },
              { key: "sum", label: "Summe", render: (r) => hours(r.hauswirtschaft + r.alltagsbegleitung + r.erstberatung + r.sonstige), csvValue: (r) => r.hauswirtschaft + r.alltagsbegleitung + r.erstberatung + r.sonstige, align: "right", sortBy: (r) => r.hauswirtschaft + r.alltagsbegleitung + r.erstberatung + r.sonstige },
            ]}
            getRowId={(r) => r.month}
            testId="performance-minutes-by-month"
            csvFilename={`stunden-je-monat-${year}`}
          />
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Ø Termindauer nach Leistungsart</CardTitle>
          </CardHeader>
          <CardContent>
            <DrillDownTable<AvgDurationRow>
              rows={data.avgDurationByServiceType}
              columns={[
                { key: "type", label: "Leistungsart", render: (r) => SERVICE_LABELS[r.serviceType] ?? r.serviceType },
                { key: "avg", label: "Ø Minuten", render: (r) => `${r.avgMinutes} min`, csvValue: (r) => r.avgMinutes, align: "right", sortBy: (r) => r.avgMinutes },
              ]}
              getRowId={(r) => r.serviceType}
              testId="performance-avg-duration"
              csvFilename={`avg-termindauer-${year}`}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Erlös pro Stunde je Mitarbeiter</CardTitle>
          </CardHeader>
          <CardContent>
            <DrillDownTable<EmpRow>
              rows={data.revenuePerHour.byEmployee}
              columns={[
                { key: "name", label: "Mitarbeiter", render: (r) => r.employeeName },
                { key: "rate", label: "Erlös/Stunde", render: (r) => cents(r.centsPerHour), csvValue: (r) => r.centsPerHour, align: "right", sortBy: (r) => r.centsPerHour },
              ]}
              getRowId={(r) => r.employeeId}
              getRowLink={(r) => `/admin/users/${r.employeeId}`}
              testId="performance-revenue-per-hour-by-employee"
              csvFilename={`erloes-pro-stunde-${year}`}
            />
          </CardContent>
        </Card>
      </div>

      <Card data-testid="profitability-totals">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <PiggyBank className="w-4 h-4 text-emerald-600" />
            Deckungsbeitrag
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
            <div>
              <div className="text-muted-foreground">Erlöse</div>
              <div className="font-semibold text-emerald-700" data-testid="profit-total-revenue">{cents(data.profitability.totals.revenueCents)}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Personalkosten</div>
              <div className="font-semibold text-red-600" data-testid="profit-total-cost">{cents(data.profitability.totals.costCents)}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Deckungsbeitrag</div>
              <div className={`font-semibold ${data.profitability.totals.marginCents >= 0 ? "text-emerald-700" : "text-red-600"}`} data-testid="profit-total-margin">
                {cents(data.profitability.totals.marginCents)}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground">DB-Marge</div>
              <div className={`font-semibold ${data.profitability.totals.marginPercent >= 30 ? "text-emerald-700" : data.profitability.totals.marginPercent >= 0 ? "text-amber-600" : "text-red-600"}`} data-testid="profit-total-margin-pct">
                {data.profitability.totals.marginPercent}%
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Deckungsbeitrag pro Mitarbeiter</CardTitle>
        </CardHeader>
        <CardContent>
          <DrillDownTable<ProfitEmpRow>
            rows={data.profitability.byEmployee}
            columns={[
              { key: "name", label: "Mitarbeiter", render: (r) => r.employeeName },
              { key: "revenue", label: "Erlöse", render: (r) => cents(r.revenueCents), csvValue: (r) => r.revenueCents, align: "right", sortBy: (r) => r.revenueCents, hideOnMobile: true },
              { key: "cost", label: "Kosten", render: (r) => cents(r.costCents), csvValue: (r) => r.costCents, align: "right", sortBy: (r) => r.costCents, hideOnMobile: true },
              { key: "margin", label: "Deckungsbeitrag", render: (r) => cents(r.marginCents), csvValue: (r) => r.marginCents, align: "right", sortBy: (r) => r.marginCents },
              { key: "marginPct", label: "DB-Marge", render: (r) => `${r.marginPercent}%`, csvValue: (r) => r.marginPercent, align: "right", sortBy: (r) => r.marginPercent },
              { key: "hours", label: "Stunden", render: (r) => hours(r.totalMinutes), csvValue: (r) => r.totalMinutes, align: "right", sortBy: (r) => r.totalMinutes, hideOnMobile: true },
              { key: "appts", label: "Termine", render: (r) => String(r.appointments), csvValue: (r) => r.appointments, align: "right", sortBy: (r) => r.appointments, hideOnMobile: true },
            ]}
            getRowId={(r) => r.employeeId}
            getRowLink={(r) => `/admin/users/${r.employeeId}`}
            testId="profitability-by-employee"
            csvFilename={`deckungsbeitrag-mitarbeiter-${year}`}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Calculator className="w-4 h-4" />
            Kalkulationsgrundlage
          </CardTitle>
        </CardHeader>
        <CardContent>
          <DrillDownTable<ServicePriceRow>
            rows={data.profitability.servicePrices}
            columns={[
              { key: "label", label: "Leistung", render: (r) => r.label },
              { key: "price", label: "Erlös/h", render: (r) => cents(r.priceCents), csvValue: (r) => r.priceCents, align: "right", sortBy: (r) => r.priceCents },
              { key: "rate", label: "MA-Kosten/h", render: (r) => cents(r.rateCents), csvValue: (r) => r.rateCents, align: "right", sortBy: (r) => r.rateCents },
              { key: "margin", label: "Marge/h", render: (r) => cents(r.marginCents), csvValue: (r) => r.marginCents, align: "right", sortBy: (r) => r.marginCents },
              { key: "marginPct", label: "%", render: (r) => `${r.marginPercent}%`, csvValue: (r) => r.marginPercent, align: "right", sortBy: (r) => r.marginPercent },
            ]}
            getRowId={(r) => r.code}
            testId="profitability-service-prices"
            csvFilename={`kalkulationsgrundlage-${year}`}
          />
        </CardContent>
      </Card>
    </div>
  );
}
