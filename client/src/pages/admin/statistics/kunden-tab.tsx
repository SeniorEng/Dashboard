import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { StatCard, BarSimple, BarStacked, DonutChart } from "@/components/charts";
import {
  Loader2, Users, TrendingUp, ArrowUpRight, ArrowDownRight, Minus,
  Clock, UserCheck, Heart, Euro,
  CalendarCheck, UserX, Wallet,
} from "lucide-react";
import { iconSize } from "@/design-system";
import { api, unwrapResult } from "@/lib/api/client";
import { formatDateForDisplay } from "@shared/utils/datetime";
import { MONTH_NAMES } from "@/features/time-tracking/constants";
import { cents, pct, hours, SERVICE_TYPE_LABELS, SERVICE_TYPE_COLORS } from "./helpers";
import type {
  OverviewResponse,
  GrowthResponse,
  BudgetPotentialResponse,
  MonthlyTrend,
  PflegegradEntry,
  CustomerLifecycleMonth,
  BudgetPotentialCustomer,
  HoursByType,
} from "./helpers";

interface DonutSegment {
  label: string;
  value: number;
  color: string;
}

interface LifecycleCustomer {
  id: number;
  name: string;
  date: string;
  reason?: string | null;
}

interface LifecycleDetailsResponse {
  gained: LifecycleCustomer[];
  lost: LifecycleCustomer[];
}

interface CustomerRevenueResponse {
  mode: "month" | "year";
  month: number | null;
  year: number;
  activeCustomers: number;
  activeCustomersDelta: number;
  totalRevenueCents: number;
  totalRevenueDeltaCents: number;
  avgRevenuePerCustomerCents: number;
  avgRevenueDeltaCents: number;
  prevMonth?: number;
  prevMonthYear?: number;
  prevYear?: number;
}

interface KundenTabProps {
  selectedYear: number;
  selectedMonth: string;
}

export function KundenTab({ selectedYear, selectedMonth }: KundenTabProps) {
  const [lifecycleMonth, setLifecycleMonth] = useState<number | null>(null);
  const monthParam = selectedMonth !== "all" ? `&month=${selectedMonth}` : "";

  const { data: statsData } = useQuery<OverviewResponse>({
    queryKey: ["statistics", selectedYear, selectedMonth],
    queryFn: async () => {
      const result = await api.get<OverviewResponse>(`/statistics/overview?year=${selectedYear}${monthParam}`);
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

  const { data: budgetPotential } = useQuery<BudgetPotentialResponse>({
    queryKey: ["statistics-budget-potential", selectedYear],
    queryFn: async () => {
      const result = await api.get<BudgetPotentialResponse>(`/statistics/budget-potential?year=${selectedYear}`);
      return unwrapResult(result);
    },
    staleTime: 60000,
  });

  const { data: customerRevenue } = useQuery<CustomerRevenueResponse>({
    queryKey: ["statistics-customer-revenue", selectedYear, selectedMonth],
    queryFn: async () => {
      const result = await api.get<CustomerRevenueResponse>(`/statistics/customer-revenue?year=${selectedYear}${monthParam}`);
      return unwrapResult(result);
    },
    staleTime: 60000,
  });

  const { data: lifecycleDetails, isLoading: lifecycleLoading } = useQuery<LifecycleDetailsResponse>({
    queryKey: ["statistics-lifecycle-details", selectedYear, lifecycleMonth],
    queryFn: async () => {
      const result = await api.get<LifecycleDetailsResponse>(`/statistics/lifecycle-details?year=${selectedYear}&month=${lifecycleMonth}`);
      return unwrapResult(result);
    },
    enabled: lifecycleMonth !== null,
    staleTime: 60000,
  });

  const customerStats = statsData?.customers ?? {} as OverviewResponse["customers"];
  const pflegegrad = statsData?.pflegegradDistribution ?? [];
  const budget = statsData?.budgetUtilization ?? {} as OverviewResponse["budgetUtilization"];
  const trends = statsData?.monthlyTrends ?? [];

  const maxTrendMinutes = useMemo(() => {
    return Math.max(...trends.map((t: MonthlyTrend) => {
      const hw = Number(t.hwMinutes || 0);
      const ab = Number(t.abMinutes || 0);
      const eb = Number(t.ebMinutes || 0);
      const pause = Number(t.pauseMinutes || 0);
      const urlaub = Number(t.urlaubMinutes || 0);
      const krank = Number(t.krankMinutes || 0);
      const buero = Number(t.bueroarbeitMinutes || 0);
      const bespr = Number(t.besprechungMinutes || 0);
      const vertr = Number(t.vertriebMinutes || 0);
      const sonst = Number(t.sonstigesMinutes || 0);
      const weiter = Number(t.weiterbildungMinutes || 0);
      return hw + ab + eb + pause + urlaub + krank + buero + bespr + vertr + sonst + weiter;
    }), 1);
  }, [trends]);

  const summary = growth?.summary || {} as GrowthResponse["summary"];
  const lifecycle = growth?.customerLifecycle || [];
  const maxLifecycle = Math.max(...lifecycle.map((m: CustomerLifecycleMonth) => Math.max(m.customersGained, m.customersLost)), 1);
  const yoyGrowthPct = summary.gainedPrevYear > 0
    ? Math.round(((summary.gainedThisYear - summary.gainedPrevYear) / summary.gainedPrevYear) * 100)
    : null;
  const serviceSegments: DonutSegment[] = (growth?.hoursByServiceType || [])
    .filter((s: HoursByType) => s.service_type)
    .map((s: HoursByType) => ({
      label: SERVICE_TYPE_LABELS[s.service_type!] || s.service_type!,
      value: Number(s.total_minutes || 0),
      color: SERVICE_TYPE_COLORS[s.service_type!] || "#a3a3a3",
    }));

  const deltaIcon = (delta: number) => {
    if (delta > 0) return <ArrowUpRight className="h-3.5 w-3.5 text-green-600" />;
    if (delta < 0) return <ArrowDownRight className="h-3.5 w-3.5 text-red-500" />;
    return <Minus className="h-3.5 w-3.5 text-gray-500" />;
  };

  const deltaColor = (delta: number) => delta > 0 ? "text-green-600" : delta < 0 ? "text-red-500" : "text-gray-500";

  const deltaText = (delta: number, suffix = "") => {
    if (delta === 0) return "±0" + suffix;
    return `${delta > 0 ? "+" : ""}${delta}${suffix}`;
  };

  const revenueCompareLabel = (() => {
    if (!customerRevenue) return "";
    if (customerRevenue.mode === "month") {
      const pm = customerRevenue.prevMonth!;
      const pmName = (MONTH_NAMES[pm - 1] || "").slice(0, 3);
      return customerRevenue.prevMonthYear !== customerRevenue.year
        ? `${pmName} ${customerRevenue.prevMonthYear}`
        : pmName;
    }
    return String(customerRevenue.prevYear || customerRevenue.year - 1);
  })();

  const revenueTitle = (() => {
    if (!customerRevenue) return "";
    if (customerRevenue.mode === "month" && customerRevenue.month) {
      return `${MONTH_NAMES[customerRevenue.month - 1]} ${customerRevenue.year}`;
    }
    return `Gesamt ${customerRevenue.year}`;
  })();

  const formatDeltaCents = (deltaCents: number) => {
    const euro = (Math.abs(deltaCents) / 100).toFixed(2).replace(".", ",");
    if (deltaCents === 0) return "±0,00 €";
    return `${deltaCents > 0 ? "+" : "-"}${euro} €`;
  };

  return (
    <>
      {customerRevenue && (
        <Card className="mb-4" data-testid="revenue-overview-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Euro className={iconSize.sm} />
              Kunden-Umsatz — {revenueTitle}
            </CardTitle>
            <div className="text-xs text-muted-foreground">
              Umsatz aus Budget-Verbräuchen · Vergleich {customerRevenue.mode === "month" ? "zum Vormonat" : "zum Vorjahr"} ({revenueCompareLabel})
              {customerRevenue.mode === "year" && <span> · Ø = Durchschnitt pro Kunde-Monat</span>}
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="flex items-center gap-3 p-3 bg-blue-50/50 rounded-lg border border-blue-100" data-testid="revenue-active-customers">
                <div className="p-2 bg-blue-100 rounded-lg">
                  <Users className="h-5 w-5 text-blue-600" />
                </div>
                <div>
                  <div className="text-2xl font-bold text-blue-700" data-testid="revenue-active-customers-value">{customerRevenue.activeCustomers}</div>
                  <div className="text-xs text-muted-foreground">Aktive Kunden</div>
                  <div className={`text-xs font-medium flex items-center gap-0.5 ${deltaColor(customerRevenue.activeCustomersDelta)}`}>
                    {deltaIcon(customerRevenue.activeCustomersDelta)}
                    {deltaText(customerRevenue.activeCustomersDelta)} vs. {revenueCompareLabel}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-3 p-3 bg-emerald-50/50 rounded-lg border border-emerald-100" data-testid="revenue-total">
                <div className="p-2 bg-emerald-100 rounded-lg">
                  <Euro className="h-5 w-5 text-emerald-600" />
                </div>
                <div>
                  <div className="text-2xl font-bold text-emerald-700" data-testid="revenue-total-value">{cents(customerRevenue.totalRevenueCents)}</div>
                  <div className="text-xs text-muted-foreground">Gesamtumsatz</div>
                  <div className={`text-xs font-medium flex items-center gap-0.5 ${deltaColor(customerRevenue.totalRevenueDeltaCents)}`}>
                    {deltaIcon(customerRevenue.totalRevenueDeltaCents)}
                    {formatDeltaCents(customerRevenue.totalRevenueDeltaCents)} vs. {revenueCompareLabel}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-3 p-3 bg-violet-50/50 rounded-lg border border-violet-100" data-testid="revenue-avg-per-customer">
                <div className="p-2 bg-violet-100 rounded-lg">
                  <TrendingUp className="h-5 w-5 text-violet-600" />
                </div>
                <div>
                  <div className="text-2xl font-bold text-violet-700" data-testid="revenue-avg-value">{cents(customerRevenue.avgRevenuePerCustomerCents)}</div>
                  <div className="text-xs text-muted-foreground">Ø pro Kunde{customerRevenue.mode === "year" ? "/Monat" : ""}</div>
                  <div className={`text-xs font-medium flex items-center gap-0.5 ${deltaColor(customerRevenue.avgRevenueDeltaCents)}`}>
                    {deltaIcon(customerRevenue.avgRevenueDeltaCents)}
                    {formatDeltaCents(customerRevenue.avgRevenueDeltaCents)} vs. {revenueCompareLabel}
                  </div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <StatCard label="Aktive Kunden" value={customerStats.activeCustomers || 0} icon={<Users className={iconSize.sm} />} color="text-green-600" testId="cust-active" />
        <StatCard label={`Gewonnen ${selectedYear}`} value={summary.gainedThisYear || 0} icon={<UserCheck className={iconSize.sm} />} color="text-green-600" testId="cust-gained" />
        <StatCard label={`Verloren ${selectedYear}`} value={summary.lostThisYear || 0} icon={<UserX className={iconSize.sm} />} color="text-red-600" testId="cust-lost" />
        <StatCard label="Netto-Wachstum" value={(summary.netGrowth || 0) > 0 ? `+${summary.netGrowth}` : String(summary.netGrowth || 0)} icon={<TrendingUp className={iconSize.sm} />} color={(summary.netGrowth || 0) >= 0 ? "text-green-600" : "text-red-600"} sub={yoyGrowthPct !== null ? `YoY: ${yoyGrowthPct > 0 ? "+" : ""}${yoyGrowthPct}%` : undefined} testId="cust-net-growth" />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-4">
        <StatCard label="Interessenten" value={customerStats.prospects || 0} color="text-blue-600" testId="cust-prospects" />
        <StatCard label="In Erstberatung" value={customerStats.consultation || 0} color="text-amber-600" testId="cust-consultation" />
        <Card data-testid="cust-planned-consultations">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="text-orange-600"><CalendarCheck className={iconSize.sm} /></div>
              <div className="min-w-0">
                <Link
                  href="/admin/planned-consultations?filter=upcoming"
                  className="text-xl font-bold text-orange-600 hover:underline"
                  data-testid="cust-planned-consultations-future"
                >
                  {customerStats.plannedConsultationsFuture || 0}
                </Link>
                <div className="text-xs text-muted-foreground truncate">
                  Erstbesuche geplant{" "}
                  <Link
                    href="/admin/planned-consultations?filter=all"
                    className="hover:underline"
                    data-testid="cust-planned-consultations-total"
                  >
                    (Σ {customerStats.plannedConsultations || 0})
                  </Link>
                </div>
                {(customerStats.plannedConsultationsPast || 0) > 0 ? (
                  <Link
                    href="/admin/planned-consultations?filter=overdue"
                    className="text-xs font-semibold text-red-600 hover:underline block"
                    data-testid="cust-planned-consultations-past"
                  >
                    {customerStats.plannedConsultationsPast} überfällig
                  </Link>
                ) : (
                  <div className="text-xs text-muted-foreground/70" data-testid="cust-planned-consultations-past">0 überfällig</div>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
        <StatCard label="Inaktiv" value={customerStats.inactiveCustomers || 0} color="text-gray-500" testId="cust-inactive" />
        <StatCard label="Gekündigt" value={customerStats.terminated || 0} color="text-red-600" testId="cust-terminated" />
        <StatCard label="Ø Termine/Kunde" value={Number(customerStats.avgAppointmentsPerCustomer || 0).toFixed(1).replace(".", ",")} color="text-teal-600" testId="cust-avg-appts" />
      </div>

      <Card className="mb-4">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Pflegegradverteilung (aktive Kunden)</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 md:grid-cols-6 gap-3">
            {pflegegrad.map((pg: PflegegradEntry) => {
              const total = pflegegrad.reduce((s: number, p: PflegegradEntry) => s + p.count, 0);
              return (
                <div key={pg.pflegegrad} className="text-center p-3 bg-gray-50 rounded-lg">
                  <div className="text-xl font-bold text-teal-700">{pg.count}</div>
                  <div className="text-xs text-muted-foreground mb-1">{pg.pflegegrad === 0 ? "Kein PG" : `PG ${pg.pflegegrad}`}</div>
                  <div className="text-xs text-muted-foreground/70">{pct(pg.count, total)}</div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <Card className="mb-4">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Budget gesamt (kumuliert) {selectedYear}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-3">
            <div>
              <div className="text-xs text-muted-foreground">Verfügbar (kumuliert)</div>
              <div className="text-lg font-bold text-blue-600">{cents(budget.totalAllocatedCents || 0)}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Verbraucht</div>
              <div className="text-lg font-bold text-emerald-600">{cents(budget.totalUsedCents || 0)}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Noch offen</div>
              <div className="text-lg font-bold text-amber-600">{cents(Math.max(0, Number(budget.totalAllocatedCents || 0) - Number(budget.totalUsedCents || 0)))}</div>
            </div>
          </div>
          <BarSimple value={Number(budget.totalUsedCents || 0)} max={Number(budget.totalAllocatedCents || 1)} color="bg-emerald-500" />
          <div className="text-xs text-muted-foreground mt-1 text-right">{pct(Number(budget.totalUsedCents || 0), Number(budget.totalAllocatedCents || 1))} genutzt</div>
        </CardContent>
      </Card>

      {(budgetPotential?.customers?.length ?? 0) > 0 && budgetPotential && (
        <Card className="mb-4">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Wallet className={iconSize.sm} />
              Budget-Potenzial
            </CardTitle>
            <div className="text-xs text-muted-foreground">Kunden mit dem meisten ungenutzten Budget (alle Töpfe, kumuliert {selectedYear})</div>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {budgetPotential!.customers.map((c: BudgetPotentialCustomer) => {
                const colorClass = c.percent < 30 ? "text-red-600" : c.percent < 50 ? "text-amber-600" : "text-emerald-600";
                const barColor = c.percent < 30 ? "bg-red-400" : c.percent < 50 ? "bg-amber-400" : "bg-emerald-500";
                const bgColor = c.percent < 30 ? "border-red-200 bg-red-50/30" : c.percent < 50 ? "border-amber-200 bg-amber-50/30" : "";
                return (
                  <div key={c.id} className={`flex items-center gap-3 p-2.5 rounded-lg border ${bgColor}`} data-testid={`budget-potential-${c.id}`}>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <Link href={`/admin/customers/${c.id}`} className="text-sm font-medium hover:underline truncate" data-testid={`budget-potential-link-${c.id}`}>
                          {c.name}
                        </Link>
                        {c.pflegegrad > 0 && (
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0 shrink-0">PG {c.pflegegrad}</Badge>
                        )}
                      </div>
                      <div className="mt-1.5 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                        <div className={`h-full rounded-full ${barColor} transition-all`} style={{ width: `${Math.min(100, c.percent)}%` }} />
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className={`text-sm font-bold ${colorClass}`}>{c.percent}%</div>
                      <div className="text-[10px] text-muted-foreground">{cents(c.unusedCents)} offen</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
        {(() => {
          const entryTypes = growth?.hoursByEntryType || [];
          const paidUnproductiveTypes = ['bueroarbeit', 'besprechung', 'vertrieb', 'sonstiges', 'weiterbildung'];

          const productiveMin = serviceSegments.reduce((sum: number, s: DonutSegment) => sum + s.value, 0);
          const paidUnproductiveMin = entryTypes
            .filter((e: HoursByType) => paidUnproductiveTypes.includes(e.entry_type || ""))
            .reduce((sum: number, e: HoursByType) => sum + Number(e.total_minutes || 0), 0);

          const segments = [
            ...serviceSegments,
            ...(paidUnproductiveMin > 0 ? [{
              label: "Büro/Vertrieb/Sonst.",
              value: paidUnproductiveMin,
              color: "#94a3b8",
            }] : []),
          ];

          return segments.length > 0 ? (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Clock className={iconSize.sm} />
                  Produktiv vs. Unproduktiv {selectedYear}
                </CardTitle>
                <div className="text-xs text-muted-foreground mt-1">
                  Ohne Fahrtzeiten · Produktiv: {Math.round(productiveMin / 60)}h · Bezahlt unproduktiv: {Math.round(paidUnproductiveMin / 60)}h
                  {(productiveMin + paidUnproductiveMin) > 0 && (
                    <span className="ml-1">
                      ({Math.round((productiveMin / (productiveMin + paidUnproductiveMin)) * 100)}% produktiv)
                    </span>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                <DonutChart segments={segments} />
              </CardContent>
            </Card>
          ) : null;
        })()}

        {lifecycle.length > 0 && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Heart className={iconSize.sm} />
                Kunden-Lifecycle {selectedYear}
              </CardTitle>
              <div className="flex items-center gap-4 mt-1">
                <div className="flex items-center gap-1.5">
                  <div className="w-2.5 h-2.5 rounded-full bg-green-500" />
                  <span className="text-xs text-muted-foreground">Gewonnen</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="w-2.5 h-2.5 rounded-full bg-red-400" />
                  <span className="text-xs text-muted-foreground">Verloren</span>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {lifecycle.map((m: CustomerLifecycleMonth) => {
                  const hasData = m.customersGained > 0 || m.customersLost > 0;
                  return (
                    <button
                      key={m.month}
                      type="button"
                      className={`flex items-center gap-3 w-full text-left rounded-lg px-2 py-1.5 transition-colors ${hasData ? "hover:bg-gray-50 cursor-pointer" : "cursor-default"}`}
                      onClick={() => hasData && setLifecycleMonth(m.month)}
                      disabled={!hasData}
                      data-testid={`lifecycle-month-${m.month}`}
                    >
                      <span className="text-xs text-muted-foreground w-8 text-right">{(MONTH_NAMES[m.month - 1] || "?").slice(0, 3)}</span>
                      <div className="flex-1 flex gap-1">
                        <div className="flex-1"><BarStacked segments={[{ value: m.customersGained, color: "bg-green-500" }]} max={maxLifecycle} /></div>
                        <div className="flex-1"><BarStacked segments={[{ value: m.customersLost, color: "bg-red-400" }]} max={maxLifecycle} /></div>
                      </div>
                      <div className="text-xs w-20 text-right">
                        <span className="font-medium text-green-600">+{m.customersGained}</span>
                        <span className="text-muted-foreground"> / </span>
                        <span className="font-medium text-red-500">-{m.customersLost}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      <Dialog open={lifecycleMonth !== null} onOpenChange={(open) => { if (!open) setLifecycleMonth(null); }}>
        <DialogContent className="max-w-md max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              Kunden-Lifecycle — {lifecycleMonth ? MONTH_NAMES[lifecycleMonth - 1] : ""} {selectedYear}
            </DialogTitle>
          </DialogHeader>
          {lifecycleLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 className={`${iconSize.lg} animate-spin text-primary`} />
            </div>
          ) : lifecycleDetails ? (
            <div className="space-y-4">
              {lifecycleDetails.gained.length > 0 && (
                <div>
                  <h3 className="text-sm font-semibold text-green-700 flex items-center gap-2 mb-2">
                    <UserCheck className={iconSize.sm} />
                    Gewonnen ({lifecycleDetails.gained.length})
                  </h3>
                  <div className="space-y-1.5">
                    {lifecycleDetails.gained.map((c) => (
                      <Link
                        key={c.id}
                        href={`/admin/customers/${c.id}`}
                        className="flex items-center justify-between p-2 rounded-lg hover:bg-green-50 transition-colors group"
                        data-testid={`lifecycle-gained-${c.id}`}
                      >
                        <span className="text-sm font-medium group-hover:underline">{c.name}</span>
                        <span className="text-xs text-muted-foreground">{formatDateForDisplay(c.date)}</span>
                      </Link>
                    ))}
                  </div>
                </div>
              )}
              {lifecycleDetails.lost.length > 0 && (
                <div>
                  <h3 className="text-sm font-semibold text-red-600 flex items-center gap-2 mb-2">
                    <UserX className={iconSize.sm} />
                    Verloren ({lifecycleDetails.lost.length})
                  </h3>
                  <div className="space-y-1.5">
                    {lifecycleDetails.lost.map((c) => (
                      <Link
                        key={c.id}
                        href={`/admin/customers/${c.id}`}
                        className="flex items-center justify-between p-2 rounded-lg hover:bg-red-50 transition-colors group"
                        data-testid={`lifecycle-lost-${c.id}`}
                      >
                        <div>
                          <span className="text-sm font-medium group-hover:underline">{c.name}</span>
                          {c.reason && (
                            <span className="text-xs text-muted-foreground ml-2">({c.reason})</span>
                          )}
                        </div>
                        <span className="text-xs text-muted-foreground shrink-0">{formatDateForDisplay(c.date)}</span>
                      </Link>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
