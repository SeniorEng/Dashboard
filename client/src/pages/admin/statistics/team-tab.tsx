import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatCard, BarSimple, DonutChart } from "@/components/charts";
import {
  Loader2, Users, TrendingUp, Activity,
  Euro, Clock, PiggyBank,
} from "lucide-react";
import { iconSize } from "@/design-system";
import { api, unwrapResult } from "@/lib/api/client";
import { formatKm } from "@/lib/utils";
import { cents, hours, ENTRY_TYPE_LABELS, ENTRY_TYPE_COLORS } from "./helpers";
import type {
  OverviewResponse,
  ProfitabilityResponse,
  ProfitabilityEmployee,
  EmployeeOverview,
  GrowthResponse,
  HoursByType,
} from "./helpers";

interface TeamTabProps {
  selectedYear: number;
  selectedMonth: string;
}

export function TeamTab({ selectedYear, selectedMonth }: TeamTabProps) {
  const monthParam = selectedMonth !== "all" ? `&month=${selectedMonth}` : "";

  const { data: statsData } = useQuery<OverviewResponse>({
    queryKey: ["statistics", selectedYear, selectedMonth],
    queryFn: async () => {
      const result = await api.get<OverviewResponse>(`/statistics/overview?year=${selectedYear}${monthParam}`);
      return unwrapResult(result);
    },
    staleTime: 60000,
  });

  const { data: profitability } = useQuery<ProfitabilityResponse>({
    queryKey: ["statistics-profitability", selectedYear, selectedMonth],
    queryFn: async () => {
      const result = await api.get<ProfitabilityResponse>(`/statistics/profitability?year=${selectedYear}${monthParam}`);
      return unwrapResult(result);
    },
    staleTime: 60000,
  });

  const { data: growth } = useQuery<GrowthResponse>({
    queryKey: ["statistics-growth", selectedYear],
    queryFn: async () => {
      const result = await api.get<GrowthResponse>(`/statistics/growth?year=${selectedYear}`);
      return unwrapResult(result);
    },
    staleTime: 60000,
  });

  const employees = statsData?.employees ?? [];

  if (!profitability) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className={`${iconSize.lg} animate-spin text-teal-600`} />
      </div>
    );
  }

  const t = profitability.totals || {};
  const empList = profitability.employees || [];
  const maxEmpMargin = Math.max(...empList.map((e: ProfitabilityEmployee) => Number(e.marginCents || 0)), 1);
  const prices = profitability.servicePrices || [];
  const hwPrice = prices.find((p) => p.code === 'hauswirtschaft');
  const abPrice = prices.find((p) => p.code === 'alltagsbegleitung');

  const entrySegments = (growth?.hoursByEntryType || [])
    .filter((s: HoursByType) => s.entry_type)
    .map((s: HoursByType) => ({
      label: ENTRY_TYPE_LABELS[s.entry_type!] || s.entry_type!,
      value: Number(s.total_minutes || 0),
      color: ENTRY_TYPE_COLORS[s.entry_type!] || "#a3a3a3",
    }));

  return (
    <>
      <Card className="mb-4 border-emerald-200 bg-emerald-50/50">
        <CardContent className="p-4">
          <div className="flex items-center gap-3 mb-3">
            <PiggyBank className="w-6 h-6 text-emerald-600" />
            <div>
              <div className="text-sm text-muted-foreground">Deckungsbeitrag (ohne Fixkosten)</div>
              <div className="text-2xl font-bold text-emerald-700" data-testid="profit-margin-total">{cents(t.marginCents)}</div>
            </div>
            <div className="ml-auto text-right">
              <div className={`text-xl font-bold ${(profitability.marginPercent || 0) >= 50 ? 'text-emerald-600' : (profitability.marginPercent || 0) >= 30 ? 'text-amber-600' : 'text-red-600'}`} data-testid="profit-margin-pct">
                {profitability.marginPercent || 0}%
              </div>
              <div className="text-xs text-muted-foreground">DB-Marge</div>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <StatCard label="Erlöse" value={cents(t.revenueCents)} sub={`${cents(t.revenueServiceCents)} Dienst + ${cents(t.revenueKmCents)} KM`} icon={<Euro className="w-5 h-5" />} color="text-emerald-600" testId="profit-revenue" />
        <StatCard label="Personalkosten" value={cents(t.costCents)} sub={`${cents(t.costServiceCents)} Dienst + ${cents(t.costKmCents)} KM`} icon={<Users className="w-5 h-5" />} color="text-red-600" testId="profit-costs" />
        <StatCard label="Einsatzstunden" value={hours(t.totalMinutes)} sub={`${t.appointments} Termine`} icon={<Clock className="w-5 h-5" />} color="text-blue-600" testId="profit-hours" />
        <StatCard label="Erlös/Stunde" value={t.totalMinutes > 0 ? cents(Math.round(t.revenueCents / (t.totalMinutes / 60))) : "–"} sub={t.totalMinutes > 0 ? `Kosten: ${cents(Math.round(t.costCents / (t.totalMinutes / 60)))}/h` : ""} icon={<TrendingUp className="w-5 h-5" />} color="text-teal-600" testId="profit-per-hour" />
      </div>

      <Card className="mb-4">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Kalkulationsgrundlage</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
            {hwPrice && (
              <div className="bg-gray-50 rounded-lg p-3">
                <div className="font-medium mb-1">Hauswirtschaft</div>
                <div className="text-muted-foreground">Erlös: {cents(hwPrice.priceCents)}/h · MA: {cents(hwPrice.rateCents)}/h</div>
                <div className="text-emerald-600 font-medium">Marge: {cents(hwPrice.priceCents - hwPrice.rateCents)}/h ({Math.round(((hwPrice.priceCents - hwPrice.rateCents) / hwPrice.priceCents) * 100)}%)</div>
              </div>
            )}
            {abPrice && (
              <div className="bg-gray-50 rounded-lg p-3">
                <div className="font-medium mb-1">Alltagsbegleitung</div>
                <div className="text-muted-foreground">Erlös: {cents(abPrice.priceCents)}/h · MA: {cents(abPrice.rateCents)}/h</div>
                <div className="text-emerald-600 font-medium">Marge: {cents(abPrice.priceCents - abPrice.rateCents)}/h ({Math.round(((abPrice.priceCents - abPrice.rateCents) / abPrice.priceCents) * 100)}%)</div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <Card className="mb-4">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Deckungsbeitrag pro Mitarbeiter</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {empList.map((emp: ProfitabilityEmployee, i: number) => {
              const empMarginPct = Number(emp.revenueCents) > 0 ? Math.round((Number(emp.marginCents) / Number(emp.revenueCents)) * 100) : 0;
              const empOverview = employees.find((e: EmployeeOverview) => e.id === emp.employeeId);
              return (
                <div key={emp.employeeId} className="border rounded-lg p-3" data-testid={`team-employee-${emp.employeeId}`}>
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">{i + 1}.</span>
                      <span className="font-semibold text-sm">{emp.employeeName}</span>
                    </div>
                    <div className="text-right">
                      <span className={`font-bold ${Number(emp.marginCents) >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{cents(emp.marginCents)}</span>
                      <span className={`text-xs ml-1.5 px-1.5 py-0.5 rounded ${empMarginPct >= 50 ? 'bg-emerald-100 text-emerald-700' : empMarginPct >= 30 ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700'}`}>{empMarginPct}%</span>
                    </div>
                  </div>
                  <BarSimple value={Number(emp.marginCents)} max={maxEmpMargin} color={Number(emp.marginCents) >= 0 ? "bg-emerald-500" : "bg-red-500"} />
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2 mt-3 text-xs">
                    <div>
                      <div className="text-muted-foreground mb-0.5">Erlöse</div>
                      <div className="font-semibold">{cents(emp.revenueCents)}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground mb-0.5">Kosten</div>
                      <div className="font-semibold">{cents(emp.costCents)}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground mb-0.5">DB/h</div>
                      <div className="font-semibold">{Number(emp.totalMinutes) > 0 ? cents(Math.round(Number(emp.marginCents) / (Number(emp.totalMinutes) / 60))) : "–"}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground mb-0.5">Stunden</div>
                      <div className="font-semibold">{hours(emp.totalMinutes)}</div>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2 mt-2 text-xs border-t pt-2">
                    <div>
                      <div className="text-muted-foreground mb-0.5">Termine</div>
                      <div className="font-semibold">{emp.appointments}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground mb-0.5">KM</div>
                      <div className="font-semibold">{formatKm(emp.totalTravelKm)}+{formatKm(emp.totalCustomerKm)}</div>
                    </div>
                    {empOverview && (
                      <div>
                        <div className="text-muted-foreground mb-0.5">Krank/Urlaub</div>
                        <div className={`font-semibold ${empOverview.sickDays > 5 ? 'text-red-600' : ''}`}>{empOverview.sickDays}d / {empOverview.vacationDays}d</div>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {entrySegments.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Activity className={iconSize.sm} />
              Zeiterfassung {selectedYear}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <DonutChart segments={entrySegments} />
          </CardContent>
        </Card>
      )}
    </>
  );
}
