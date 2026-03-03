import { useState, useMemo } from "react";
import { Link, useSearch } from "wouter";
import { formatKm } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ArrowLeft, Loader2, BarChart3, Users, TrendingUp, Activity,
  Euro, Clock, UserCheck, Heart, PiggyBank,
  CalendarCheck, UserX, AlertTriangle, CheckCircle2, AlertCircle,
  ArrowUpRight, ArrowDownRight, Minus, Gauge, Wallet,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { iconSize, componentStyles } from "@/design-system";
import { api, unwrapResult } from "@/lib/api/client";
import { MONTH_NAMES } from "@/features/time-tracking/constants";
import { formatCurrency } from "@shared/utils/format";

function cents(value: number | string | bigint): string {
  const num = typeof value === "string" ? parseInt(value) : Number(value);
  return formatCurrency(num);
}

function pct(a: number, b: number): string {
  if (b === 0) return "0%";
  return `${Math.round((a / b) * 100)}%`;
}

function hours(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}min` : `${h}h`;
}

interface StatCardProps {
  label: string;
  value: string | number;
  sub?: string;
  icon?: React.ReactNode;
  color?: string;
  testId: string;
}

function StatCard({ label, value, sub, icon, color = "text-teal-600", testId }: StatCardProps) {
  return (
    <Card data-testid={testId}>
      <CardContent className="p-4">
        <div className="flex items-center gap-3">
          {icon && <div className={`${color}`}>{icon}</div>}
          <div className="min-w-0">
            <div className={`text-xl font-bold ${color}`} data-testid={`${testId}-value`}>{value}</div>
            <div className="text-xs text-muted-foreground truncate">{label}</div>
            {sub && <div className="text-xs text-muted-foreground/70">{sub}</div>}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function BarSimple({ value, max, color = "bg-teal-500" }: { value: number; max: number; color?: string }) {
  const width = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  return (
    <div className="w-full bg-gray-100 rounded-full h-2.5">
      <div className={`h-2.5 rounded-full ${color} transition-all`} style={{ width: `${width}%` }} />
    </div>
  );
}

function BarStacked({ segments, max }: { segments: { value: number; color: string }[]; max: number }) {
  return (
    <div className="w-full bg-gray-100 rounded-full h-2.5 flex overflow-hidden">
      {segments.map((seg, i) => {
        const width = max > 0 ? Math.min((seg.value / max) * 100, 100) : 0;
        if (width === 0) return null;
        return (
          <div
            key={i}
            className={`h-2.5 ${seg.color} transition-all ${i === 0 ? "rounded-l-full" : ""} ${i === segments.length - 1 || segments.slice(i + 1).every(s => s.value === 0) ? "rounded-r-full" : ""}`}
            style={{ width: `${width}%` }}
          />
        );
      })}
    </div>
  );
}

export default function AdminStatistics() {
  const currentYear = new Date().getFullYear();
  const currentMonth = new Date().getMonth() + 1;
  const searchString = useSearch();
  const urlTab = new URLSearchParams(searchString).get("tab");
  const [selectedYear, setSelectedYear] = useState(currentYear);
  const [selectedMonth, setSelectedMonth] = useState<string>("all");
  const [activeTab, setActiveTab] = useState(urlTab && ["cockpit", "team", "customers", "planning"].includes(urlTab) ? urlTab : "cockpit");

  const monthParam = selectedMonth !== "all" ? `&month=${selectedMonth}` : "";

  const { data, isLoading } = useQuery<any>({
    queryKey: ["statistics", selectedYear, selectedMonth],
    queryFn: async () => {
      const result = await api.get(`/statistics/overview?year=${selectedYear}${monthParam}`);
      return unwrapResult(result);
    },
    staleTime: 60000,
  });

  const { data: profitability } = useQuery<any>({
    queryKey: ["statistics-profitability", selectedYear, selectedMonth],
    queryFn: async () => {
      const result = await api.get(`/statistics/profitability?year=${selectedYear}${monthParam}`);
      return unwrapResult(result);
    },
    staleTime: 60000,
  });

  const { data: planning } = useQuery<any>({
    queryKey: ["statistics-planning", selectedYear, selectedMonth],
    queryFn: async () => {
      const result = await api.get(`/statistics/planning?year=${selectedYear}${monthParam}`);
      return unwrapResult(result);
    },
    staleTime: 60000,
  });

  const { data: growth } = useQuery<any>({
    queryKey: ["statistics-growth", selectedYear],
    queryFn: async () => {
      const result = await api.get(`/statistics/growth?year=${selectedYear}`);
      return unwrapResult(result);
    },
    staleTime: 60000,
  });

  const { data: budgetPotential } = useQuery<any>({
    queryKey: ["statistics-budget-potential", selectedYear],
    queryFn: async () => {
      const result = await api.get(`/statistics/budget-potential?year=${selectedYear}`);
      return unwrapResult(result);
    },
    staleTime: 60000,
  });

  const { data: alerts } = useQuery<any[]>({
    queryKey: ["statistics-alerts"],
    queryFn: async () => {
      const result = await api.get<any[]>(`/statistics/alerts`);
      return unwrapResult(result);
    },
    staleTime: 120000,
  });

  const cockpit = data?.cockpit;
  const employees = data?.employees ?? [];
  const customerStats = data?.customers ?? {};
  const trends = data?.monthlyTrends ?? [];
  const pflegegrad = data?.pflegegradDistribution ?? [];
  const budget = data?.budgetUtilization ?? {};

  const maxTrendMinutes = useMemo(() => {
    return Math.max(...trends.map((t: any) => {
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

  const periodLabel = selectedMonth !== "all"
    ? `${MONTH_NAMES[parseInt(selectedMonth)]} ${selectedYear}`
    : `${selectedYear}`;

  return (
    <Layout variant="wide">
        <div className="flex items-center gap-3 mb-6">
          <Link href="/admin" data-testid="link-back-admin">
            <Button variant="ghost" size="sm">
              <ArrowLeft className={iconSize.md} />
            </Button>
          </Link>
          <div className="flex-1">
            <h1 className={`${componentStyles.pageTitle} flex items-center gap-2`} data-testid="text-page-title">
              <BarChart3 className={iconSize.lg} />
              Statistiken
            </h1>
            <p className="text-sm text-muted-foreground">Unternehmens- und Mitarbeiter-Kennzahlen</p>
          </div>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-3 mb-6">
          <Select value={String(selectedYear)} onValueChange={v => setSelectedYear(Number(v))}>
            <SelectTrigger className="w-[100px]" data-testid="select-year">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[currentYear - 1, currentYear, currentYear + 1].map(y => (
                <SelectItem key={y} value={String(y)}>{y}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={selectedMonth} onValueChange={setSelectedMonth}>
            <SelectTrigger className="w-[140px]" data-testid="select-month">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Gesamtjahr</SelectItem>
              {Array.from({ length: 12 }, (_, i) => i + 1).map(m => (
                <SelectItem key={m} value={String(m)}>{MONTH_NAMES[m]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {isLoading ? (
          <div className="flex justify-center py-16">
            <Loader2 className={`${iconSize.lg} animate-spin text-teal-600`} />
          </div>
        ) : (
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList className="mb-6 flex-wrap h-auto gap-1">
              <TabsTrigger value="cockpit" data-testid="tab-cockpit">Cockpit</TabsTrigger>
              <TabsTrigger value="team" data-testid="tab-team">Team</TabsTrigger>
              <TabsTrigger value="customers" data-testid="tab-customers">Kunden</TabsTrigger>
              <TabsTrigger value="planning" data-testid="tab-planning">Planung</TabsTrigger>
            </TabsList>

            {/* COCKPIT TAB */}
            <TabsContent value="cockpit">
              {cockpit ? (
                <>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
                    <CockpitKPI
                      title="DB-Marge"
                      icon={<PiggyBank className="w-5 h-5" />}
                      value={`${cockpit.margin.marginPercent}%`}
                      percent={cockpit.margin.marginPercent}
                      thresholds={{ green: 45, yellow: 30 }}
                      prevValue={cockpit.marginPrev ? cockpit.marginPrev.marginPercent : null}
                      prevLabel="Vormonat"
                      metrics={[
                        { label: "Erlöse", value: cents(cockpit.margin.revenueCents) },
                        { label: "DB", value: cents(cockpit.margin.marginCents) },
                        { label: "Termine", value: String(cockpit.margin.appointments) },
                      ]}
                      testId="cockpit-margin"
                    />
                    <CockpitKPI
                      title="Auslastung"
                      icon={<Gauge className="w-5 h-5" />}
                      value={`${cockpit.utilization.percent}%`}
                      percent={cockpit.utilization.percent}
                      thresholds={{ green: 75, yellow: 60 }}
                      prevValue={cockpit.utilizationPrev ? cockpit.utilizationPrev.percent : null}
                      prevLabel="Vormonat"
                      metrics={[
                        { label: "Produktiv", value: hours(cockpit.utilization.productiveMinutes) },
                        { label: "Overhead", value: hours(cockpit.utilization.overheadMinutes) },
                        { label: "Termine", value: String(cockpit.utilization.appointments) },
                      ]}
                      testId="cockpit-utilization"
                    />
                    <CockpitKPI
                      title="Budget gesamt"
                      icon={<Wallet className="w-5 h-5" />}
                      value={`${cockpit.budget.percent}%`}
                      percent={cockpit.budget.percent}
                      thresholds={{ green: 70, yellow: 50 }}
                      prevValue={cockpit.budgetPrev ? cockpit.budgetPrev.percent : null}
                      prevLabel="Vormonat"
                      metrics={[
                        { label: "Verbraucht", value: cents(cockpit.budget.usedCents) },
                        { label: "Verfügbar", value: cents(cockpit.budget.allocatedCents) },
                        { label: "Kunden", value: String(cockpit.budget.customerCount) },
                      ]}
                      testId="cockpit-budget"
                    />
                  </div>

                  <AlertsSection alerts={alerts || []} />

                  <Card>
                    <CardHeader className="pb-3">
                      <CardTitle className="text-base">Monatliche Stunden {selectedYear}</CardTitle>
                      <div className="flex items-center gap-3 mt-1 flex-wrap">
                        {[
                          { color: "bg-blue-500", label: "HW" },
                          { color: "bg-teal-500", label: "AB" },
                          { color: "bg-amber-500", label: "EB" },
                          { color: "bg-slate-400", label: "Pause" },
                          { color: "bg-indigo-500", label: "Büro" },
                          { color: "bg-purple-500", label: "Sonst." },
                        ].map(l => (
                          <div key={l.label} className="flex items-center gap-1">
                            <div className={`w-2.5 h-2.5 rounded-full ${l.color}`} />
                            <span className="text-xs text-muted-foreground">{l.label}</span>
                          </div>
                        ))}
                      </div>
                    </CardHeader>
                    <CardContent>
                      <div className="space-y-2">
                        {trends.map((t: any) => {
                          const hw = Number(t.hwMinutes || 0);
                          const ab = Number(t.abMinutes || 0);
                          const eb = Number(t.ebMinutes || 0);
                          const pause = Number(t.pauseMinutes || 0);
                          const buero = Number(t.bueroarbeitMinutes || 0) + Number(t.besprechungMinutes || 0);
                          const sonst = Number(t.sonstigesMinutes || 0) + Number(t.weiterbildungMinutes || 0) + Number(t.krankMinutes || 0) + Number(t.urlaubMinutes || 0);
                          const totalMin = hw + ab + eb + pause + buero + sonst;
                          const totalHours = totalMin > 0 ? (totalMin / 60).toFixed(1) : "0";
                          const termine = Number(t.completedHauswirtschaft || 0) + Number(t.completedAlltagsbegleitung || 0) + Number(t.completedErstberatungen || 0);
                          return (
                            <div key={t.month} className="flex items-center gap-3">
                              <span className="text-xs text-muted-foreground w-8 text-right">{MONTH_NAMES[t.month].slice(0, 3)}</span>
                              <div className="flex-1">
                                <BarStacked
                                  segments={[
                                    { value: hw, color: "bg-blue-500" },
                                    { value: ab, color: "bg-teal-500" },
                                    { value: eb, color: "bg-amber-500" },
                                    { value: pause, color: "bg-slate-400" },
                                    { value: buero, color: "bg-indigo-500" },
                                    { value: sonst, color: "bg-purple-500" },
                                  ]}
                                  max={maxTrendMinutes}
                                />
                              </div>
                              <div className="text-xs w-28 text-right shrink-0">
                                <span className="font-medium">{totalHours}h</span>
                                <span className="text-muted-foreground"> · </span>
                                <span className="font-medium">{termine}</span>
                                <span className="text-muted-foreground"> Termine</span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </CardContent>
                  </Card>
                </>
              ) : (
                <div className="flex justify-center py-16">
                  <Loader2 className={`${iconSize.lg} animate-spin text-teal-600`} />
                </div>
              )}
            </TabsContent>

            {/* TEAM TAB (Mitarbeiter + Deckungsbeitrag + Zeiterfassung) */}
            <TabsContent value="team">
              {profitability ? (() => {
                const t = profitability.totals;
                const empList = profitability.employees || [];
                const maxEmpMargin = Math.max(...empList.map((e: any) => Number(e.marginCents || 0)), 1);
                const prices = profitability.servicePrices || [];
                const hwPrice = prices.find((p: any) => p.code === 'hauswirtschaft');
                const abPrice = prices.find((p: any) => p.code === 'alltagsbegleitung');

                const entrySegments = (growth?.hoursByEntryType || [])
                  .filter((s: any) => s.entry_type)
                  .map((s: any) => ({
                    label: ENTRY_TYPE_LABELS[s.entry_type] || s.entry_type,
                    value: Number(s.total_minutes || 0),
                    color: ENTRY_TYPE_COLORS[s.entry_type] || "#a3a3a3",
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
                            <div className={`text-xl font-bold ${profitability.marginPercent >= 50 ? 'text-emerald-600' : profitability.marginPercent >= 30 ? 'text-amber-600' : 'text-red-600'}`} data-testid="profit-margin-pct">
                              {profitability.marginPercent}%
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
                          {empList.map((emp: any, i: number) => {
                            const empMarginPct = Number(emp.revenueCents) > 0 ? Math.round((Number(emp.marginCents) / Number(emp.revenueCents)) * 100) : 0;
                            const empOverview = employees.find((e: any) => e.id === emp.employeeId);
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
              })() : (
                <div className="flex justify-center py-16">
                  <Loader2 className={`${iconSize.lg} animate-spin text-teal-600`} />
                </div>
              )}
            </TabsContent>

            {/* CUSTOMERS TAB (Kunden + Wachstum + Budget) */}
            <TabsContent value="customers">
              {(() => {
                const summary = growth?.summary || {};
                const lifecycle = growth?.customerLifecycle || [];
                const maxLifecycle = Math.max(...lifecycle.map((m: any) => Math.max(m.customersGained, m.customersLost)), 1);
                const yoyGrowthPct = summary.gainedPrevYear > 0
                  ? Math.round(((summary.gainedThisYear - summary.gainedPrevYear) / summary.gainedPrevYear) * 100)
                  : null;
                const serviceSegments = (growth?.hoursByServiceType || [])
                  .filter((s: any) => s.service_type)
                  .map((s: any) => ({
                    label: SERVICE_TYPE_LABELS[s.service_type] || s.service_type,
                    value: Number(s.total_minutes || 0),
                    color: SERVICE_TYPE_COLORS[s.service_type] || "#a3a3a3",
                  }));

                return (
                  <>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
                      <StatCard label="Aktive Kunden" value={customerStats.activeCustomers || 0} icon={<Users className={iconSize.sm} />} color="text-green-600" testId="cust-active" />
                      <StatCard label={`Gewonnen ${selectedYear}`} value={summary.gainedThisYear || 0} icon={<UserCheck className={iconSize.sm} />} color="text-green-600" testId="cust-gained" />
                      <StatCard label={`Verloren ${selectedYear}`} value={summary.lostThisYear || 0} icon={<UserX className={iconSize.sm} />} color="text-red-600" testId="cust-lost" />
                      <StatCard label="Netto-Wachstum" value={(summary.netGrowth || 0) > 0 ? `+${summary.netGrowth}` : String(summary.netGrowth || 0)} icon={<TrendingUp className={iconSize.sm} />} color={(summary.netGrowth || 0) >= 0 ? "text-green-600" : "text-red-600"} sub={yoyGrowthPct !== null ? `YoY: ${yoyGrowthPct > 0 ? "+" : ""}${yoyGrowthPct}%` : undefined} testId="cust-net-growth" />
                    </div>

                    <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
                      <StatCard label="Interessenten" value={customerStats.prospects || 0} color="text-blue-600" testId="cust-prospects" />
                      <StatCard label="Erstberatung" value={customerStats.consultation || 0} color="text-amber-600" testId="cust-consultation" />
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
                          {pflegegrad.map((pg: any) => {
                            const total = pflegegrad.reduce((s: number, p: any) => s + p.count, 0);
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

                    {budgetPotential?.customers?.length > 0 && (
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
                            {budgetPotential.customers.map((c: any) => {
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
                        const productiveTypes = ['hauswirtschaft', 'alltagsbegleitung', 'erstberatung'];
                        const paidUnproductiveTypes = ['bueroarbeit', 'besprechung', 'vertrieb', 'sonstiges', 'weiterbildung'];

                        const productiveMin = serviceSegments.reduce((sum: number, s: any) => sum + s.value, 0);
                        const paidUnproductiveMin = entryTypes
                          .filter((e: any) => paidUnproductiveTypes.includes(e.entry_type))
                          .reduce((sum: number, e: any) => sum + Number(e.total_minutes || 0), 0);

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
                              {lifecycle.map((m: any) => (
                                <div key={m.month} className="flex items-center gap-3">
                                  <span className="text-xs text-muted-foreground w-8 text-right">{MONTH_NAMES[m.month].slice(0, 3)}</span>
                                  <div className="flex-1 flex gap-1">
                                    <div className="flex-1"><BarStacked segments={[{ value: m.customersGained, color: "bg-green-500" }]} max={maxLifecycle} /></div>
                                    <div className="flex-1"><BarStacked segments={[{ value: m.customersLost, color: "bg-red-400" }]} max={maxLifecycle} /></div>
                                  </div>
                                  <div className="text-xs w-20 text-right">
                                    <span className="font-medium text-green-600">+{m.customersGained}</span>
                                    <span className="text-muted-foreground"> / </span>
                                    <span className="font-medium text-red-500">-{m.customersLost}</span>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </CardContent>
                        </Card>
                      )}
                    </div>
                  </>
                );
              })()}
            </TabsContent>

            {/* PLANNING TAB */}
            <TabsContent value="planning">
              {planning ? (() => {
                const t = planning.totals;
                const planEmpList = planning.employees || [];
                const maxPlanMargin = Math.max(...planEmpList.map((e: any) => Math.abs(Number(e.marginCents || 0))), 1);
                const noApptCustomers = planning.customersWithoutAppointments || [];

                return (
                  <>
                    <Card className="mb-4 border-blue-200 bg-blue-50/50">
                      <CardContent className="p-4">
                        <div className="flex items-center gap-3 mb-3">
                          <CalendarCheck className="w-6 h-6 text-blue-600" />
                          <div>
                            <div className="text-sm text-muted-foreground">Gesamtplanung ({periodLabel})</div>
                            <div className="text-2xl font-bold text-blue-700" data-testid="planning-total-appointments">{t.appointments} Termine</div>
                          </div>
                          <div className="ml-auto text-right">
                            <div className={`text-xl font-bold ${planning.marginPercent >= 50 ? 'text-emerald-600' : planning.marginPercent >= 30 ? 'text-amber-600' : 'text-red-600'}`} data-testid="planning-margin-pct">
                              {planning.marginPercent}% DB
                            </div>
                            <div className="text-xs text-muted-foreground">{t.scheduledCount} geplant · {t.completedCount} abgeschl. · {t.documentedCount} dokumentiert</div>
                          </div>
                        </div>
                      </CardContent>
                    </Card>

                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                      <StatCard
                        label="Erwarteter Umsatz"
                        value={cents(t.revenueCents)}
                        sub={`${cents(t.revenueServiceCents)} Dienst + ${cents(t.revenueKmCents)} KM`}
                        icon={<Euro className="w-5 h-5" />}
                        color="text-emerald-600"
                        testId="planning-revenue"
                      />
                      <StatCard
                        label="Erwartete Kosten"
                        value={cents(t.costCents)}
                        sub={`${cents(t.costServiceCents)} Dienst + ${cents(t.costKmCents)} KM`}
                        icon={<Users className="w-5 h-5" />}
                        color="text-red-600"
                        testId="planning-costs"
                      />
                      <StatCard
                        label="Deckungsbeitrag"
                        value={cents(t.marginCents)}
                        icon={<PiggyBank className="w-5 h-5" />}
                        color={Number(t.marginCents) >= 0 ? "text-emerald-600" : "text-red-600"}
                        testId="planning-margin"
                      />
                      <StatCard
                        label="Geplante Stunden"
                        value={hours(t.totalMinutes)}
                        sub={`${t.customers} Kunden`}
                        icon={<Clock className="w-5 h-5" />}
                        color="text-blue-600"
                        testId="planning-hours"
                      />
                    </div>

                    <Card className="mb-4">
                      <CardHeader className="pb-3">
                        <CardTitle className="text-base">Planung pro Mitarbeiter</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <div className="space-y-3">
                          {planEmpList.map((emp: any, i: number) => {
                            const empMarginPct = Number(emp.revenueCents) > 0
                              ? Math.round((Number(emp.marginCents) / Number(emp.revenueCents)) * 100)
                              : 0;
                            return (
                              <div key={emp.employeeId} className="border rounded-lg p-3" data-testid={`planning-employee-${emp.employeeId}`}>
                                <div className="flex items-center justify-between mb-2">
                                  <div className="flex items-center gap-2">
                                    <span className="text-xs text-muted-foreground">{i + 1}.</span>
                                    <span className="font-semibold text-sm">{emp.employeeName}</span>
                                  </div>
                                  <div className="text-right">
                                    <span className={`font-bold ${Number(emp.marginCents) >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                                      {cents(emp.marginCents)}
                                    </span>
                                    <span className={`text-xs ml-1.5 px-1.5 py-0.5 rounded ${empMarginPct >= 50 ? 'bg-emerald-100 text-emerald-700' : empMarginPct >= 30 ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700'}`}>
                                      {empMarginPct}%
                                    </span>
                                  </div>
                                </div>
                                <BarSimple value={Math.abs(Number(emp.marginCents))} max={maxPlanMargin} color={Number(emp.marginCents) >= 0 ? "bg-emerald-500" : "bg-red-500"} />
                                <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mt-2 text-xs">
                                  <div>
                                    <span className="text-muted-foreground">Termine: </span>
                                    <span className="font-medium">{emp.appointments}</span>
                                    <span className="text-muted-foreground ml-1">({emp.scheduledCount} gepl. · {emp.completedCount} abg. · {emp.documentedCount} dok.)</span>
                                  </div>
                                  <div>
                                    <span className="text-muted-foreground">Umsatz: </span>
                                    <span className="font-medium">{cents(emp.revenueCents)}</span>
                                  </div>
                                  <div>
                                    <span className="text-muted-foreground">Kosten: </span>
                                    <span className="font-medium">{cents(emp.costCents)}</span>
                                  </div>
                                  <div>
                                    <span className="text-muted-foreground">Stunden: </span>
                                    <span className="font-medium">{hours(emp.totalMinutes)}</span>
                                  </div>
                                  <div>
                                    <span className="text-muted-foreground">Kunden: </span>
                                    <span className="font-medium">{emp.customers}</span>
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                          {planEmpList.length === 0 && (
                            <div className="text-center py-8 text-muted-foreground">
                              Keine geplanten Termine im gewählten Zeitraum.
                            </div>
                          )}
                        </div>
                      </CardContent>
                    </Card>

                    <Card className="mb-4">
                      <CardHeader className="pb-3">
                        <CardTitle className="text-base flex items-center gap-2">
                          <UserX className="w-4 h-4 text-amber-600" />
                          Aktive Kunden ohne Termine ({noApptCustomers.length})
                        </CardTitle>
                      </CardHeader>
                      <CardContent>
                        {noApptCustomers.length > 0 ? (
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                            {noApptCustomers.map((c: any) => (
                              <Link
                                key={c.id}
                                href={`/admin/customers/${c.id}`}
                                className="flex items-center justify-between p-3 rounded-lg border hover:bg-gray-50 transition-colors"
                                data-testid={`planning-no-appt-customer-${c.id}`}
                              >
                                <div className="flex items-center gap-2 min-w-0">
                                  <span className="font-medium text-sm truncate">{c.name}</span>
                                  {c.pflegegrad && (
                                    <Badge variant="outline" className="shrink-0 text-xs">
                                      PG {c.pflegegrad}
                                    </Badge>
                                  )}
                                </div>
                                {c.primaryEmployeeName && (
                                  <span className="text-xs text-muted-foreground shrink-0 ml-2">{c.primaryEmployeeName}</span>
                                )}
                              </Link>
                            ))}
                          </div>
                        ) : (
                          <div className="text-center py-6 text-muted-foreground text-sm">
                            Alle aktiven Kunden haben Termine im gewählten Zeitraum.
                          </div>
                        )}
                      </CardContent>
                    </Card>

                    {trends.length > 0 && (
                      <>
                        <Card className="mb-4">
                          <CardHeader className="pb-3">
                            <CardTitle className="text-base">Monatliche Stunden {selectedYear}</CardTitle>
                            <div className="flex items-center gap-3 mt-1 flex-wrap">
                              {[["bg-blue-500","HW"],["bg-teal-500","AB"],["bg-amber-500","EB"],["bg-slate-400","Pause"],["bg-indigo-500","Büro"],["bg-sky-500","Vertrieb"],["bg-purple-500","Sonst."]].map(([c,l]) => (
                                <div key={l} className="flex items-center gap-1">
                                  <div className={`w-2.5 h-2.5 rounded-full ${c}`} />
                                  <span className="text-xs text-muted-foreground">{l}</span>
                                </div>
                              ))}
                            </div>
                          </CardHeader>
                          <CardContent>
                            <div className="space-y-2">
                              {trends.map((t: any) => {
                                const hw = Number(t.hwMinutes || 0);
                                const ab = Number(t.abMinutes || 0);
                                const eb = Number(t.ebMinutes || 0);
                                const pause = Number(t.pauseMinutes || 0);
                                const buero = Number(t.bueroarbeitMinutes || 0);
                                const bespr = Number(t.besprechungMinutes || 0);
                                const vertr = Number(t.vertriebMinutes || 0);
                                const sonst = Number(t.sonstigesMinutes || 0) + Number(t.weiterbildungMinutes || 0) + Number(t.krankMinutes || 0) + Number(t.urlaubMinutes || 0);
                                const totalMin = hw + ab + eb + pause + buero + bespr + vertr + sonst;
                                const totalHours = totalMin > 0 ? (totalMin / 60).toFixed(1) : "0";
                                const termine = Number(t.completedHauswirtschaft || 0) + Number(t.completedAlltagsbegleitung || 0) + Number(t.completedErstberatungen || 0);
                                return (
                                  <div key={t.month} className="flex items-center gap-3">
                                    <span className="text-xs text-muted-foreground w-8 text-right">{MONTH_NAMES[t.month].slice(0, 3)}</span>
                                    <div className="flex-1">
                                      <BarStacked
                                        segments={[
                                          { value: hw, color: "bg-blue-500" },
                                          { value: ab, color: "bg-teal-500" },
                                          { value: eb, color: "bg-amber-500" },
                                          { value: pause, color: "bg-slate-400" },
                                          { value: buero + bespr, color: "bg-indigo-500" },
                                          { value: vertr, color: "bg-sky-500" },
                                          { value: sonst, color: "bg-purple-500" },
                                        ]}
                                        max={maxTrendMinutes}
                                      />
                                    </div>
                                    <div className="text-xs w-28 text-right shrink-0">
                                      <span className="font-medium">{totalHours}h</span>
                                      <span className="text-muted-foreground"> · </span>
                                      <span className="font-medium">{termine}</span>
                                      <span className="text-muted-foreground"> Termine</span>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </CardContent>
                        </Card>

                        <Card>
                          <CardHeader className="pb-3">
                            <CardTitle className="text-base">Aktive Kunden pro Monat {selectedYear}</CardTitle>
                          </CardHeader>
                          <CardContent>
                            <div className="space-y-2">
                              {trends.map((t: any) => {
                                const maxCust = Math.max(...trends.map((tr: any) => Number(tr.activeCustomers || 0)), 1);
                                return (
                                  <div key={t.month} className="flex items-center gap-3">
                                    <span className="text-xs text-muted-foreground w-8 text-right">{MONTH_NAMES[t.month].slice(0, 3)}</span>
                                    <div className="flex-1">
                                      <BarSimple value={Number(t.activeCustomers)} max={maxCust} color="bg-purple-500" />
                                    </div>
                                    <span className="text-xs font-medium w-10 text-right">{t.activeCustomers}</span>
                                  </div>
                                );
                              })}
                            </div>
                          </CardContent>
                        </Card>
                      </>
                    )}
                  </>
                );
              })() : (
                <div className="flex justify-center py-16">
                  <Loader2 className={`${iconSize.lg} animate-spin text-teal-600`} />
                </div>
              )}
            </TabsContent>

          </Tabs>
        )}
    </Layout>
  );
}

const SERVICE_TYPE_LABELS: Record<string, string> = {
  hauswirtschaft: "Hauswirtschaft",
  alltagsbegleitung: "Alltagsbegleitung",
  erstberatung: "Erstberatung",
};

const SERVICE_TYPE_COLORS: Record<string, string> = {
  hauswirtschaft: "#3b82f6",
  alltagsbegleitung: "#14b8a6",
  erstberatung: "#f59e0b",
};

const ENTRY_TYPE_LABELS: Record<string, string> = {
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

const ENTRY_TYPE_COLORS: Record<string, string> = {
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

function DonutChart({ segments, size = 160 }: { segments: { label: string; value: number; color: string }[]; size?: number }) {
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  if (total === 0) return <div className="text-sm text-muted-foreground text-center py-8">Keine Daten</div>;

  const strokeW = 22;
  const radius = size / 2 - strokeW / 2 - 2;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  return (
    <div className="flex flex-col items-center gap-4">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Zeitverteilung Diagramm">
        {segments.filter(s => s.value > 0).map((seg, i) => {
          const pct = seg.value / total;
          const dashLength = pct * circumference;
          const dashOffset = -offset * circumference;
          offset += pct;
          return (
            <circle
              key={i}
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke={seg.color}
              strokeWidth={strokeW}
              strokeDasharray={`${dashLength} ${circumference - dashLength}`}
              strokeDashoffset={dashOffset}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
            />
          );
        })}
        <text x={size / 2} y={size / 2 - 8} textAnchor="middle" className="text-xl font-bold fill-current">{Math.round(total / 60)}h</text>
        <text x={size / 2} y={size / 2 + 12} textAnchor="middle" className="text-xs fill-muted-foreground">gesamt</text>
      </svg>
      <div className="flex flex-wrap justify-center gap-x-4 gap-y-1">
        {segments.filter(s => s.value > 0).map((seg, i) => (
          <div key={i} className="flex items-center gap-1.5 text-xs">
            <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: seg.color }} />
            <span className="text-muted-foreground">{seg.label}</span>
            <span className="font-medium">{Math.round(seg.value / 60)}h</span>
            <span className="text-muted-foreground">({Math.round((seg.value / total) * 100)}%)</span>
          </div>
        ))}
      </div>
    </div>
  );
}

interface CockpitKPIProps {
  title: string;
  icon: React.ReactNode;
  value: string;
  percent: number;
  thresholds: { green: number; yellow: number };
  prevValue: number | null;
  prevLabel: string;
  metrics: { label: string; value: string }[];
  testId: string;
}

function CockpitKPI({ title, icon, value, percent, thresholds, prevValue, prevLabel, metrics, testId }: CockpitKPIProps) {
  const color = percent >= thresholds.green
    ? { bg: "bg-emerald-50", border: "border-emerald-200", text: "text-emerald-700", bar: "bg-emerald-500", badge: "bg-emerald-100 text-emerald-800" }
    : percent >= thresholds.yellow
    ? { bg: "bg-amber-50", border: "border-amber-200", text: "text-amber-700", bar: "bg-amber-500", badge: "bg-amber-100 text-amber-800" }
    : { bg: "bg-red-50", border: "border-red-200", text: "text-red-700", bar: "bg-red-500", badge: "bg-red-100 text-red-800" };

  const trend = prevValue !== null ? percent - prevValue : null;

  return (
    <Card className={`${color.border} ${color.bg}`} data-testid={testId}>
      <CardContent className="p-5">
        <div className="flex items-center gap-2 mb-3">
          <div className={color.text}>{icon}</div>
          <span className="font-semibold text-sm">{title}</span>
          <span className={`ml-auto text-xs px-2 py-0.5 rounded-full font-medium ${color.badge}`}>
            {percent >= thresholds.green ? "Gut" : percent >= thresholds.yellow ? "Achtung" : "Kritisch"}
          </span>
        </div>

        <div className="flex items-end gap-3 mb-3">
          <span className={`text-2xl sm:text-3xl font-bold ${color.text}`} data-testid={`${testId}-value`}>{value}</span>
          {trend !== null && (
            <div className={`flex items-center gap-0.5 text-sm mb-1 ${trend > 0 ? "text-emerald-600" : trend < 0 ? "text-red-600" : "text-gray-500"}`} data-testid={`${testId}-trend`}>
              {trend > 0 ? <ArrowUpRight className="w-4 h-4" /> : trend < 0 ? <ArrowDownRight className="w-4 h-4" /> : <Minus className="w-4 h-4" />}
              <span className="font-medium">{trend > 0 ? "+" : ""}{trend}%</span>
              <span className="text-xs text-muted-foreground ml-0.5">{prevLabel}</span>
            </div>
          )}
        </div>

        <div className="w-full bg-white/60 rounded-full h-2 mb-3">
          <div className={`h-2 rounded-full ${color.bar} transition-all`} style={{ width: `${Math.min(percent, 100)}%` }} />
        </div>

        <div className="grid grid-cols-3 gap-2">
          {metrics.map(m => (
            <div key={m.label} className="text-center">
              <div className="text-xs text-muted-foreground">{m.label}</div>
              <div className="text-sm font-semibold">{m.value}</div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function AlertsSection({ alerts }: { alerts: any[] }) {
  const activeAlerts = alerts.filter(a => a.count > 0);

  if (activeAlerts.length === 0) {
    return (
      <Card className="mb-6 border-emerald-200 bg-emerald-50/50">
        <CardContent className="p-4 flex items-center gap-3">
          <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
          <span className="text-sm text-emerald-700 font-medium" data-testid="alerts-all-clear">Alles im grünen Bereich — kein Handlungsbedarf.</span>
        </CardContent>
      </Card>
    );
  }

  const severityOrder = { rot: 0, gelb: 1, gruen: 2 };
  const sorted = [...activeAlerts].sort((a, b) => (severityOrder[a.severity as keyof typeof severityOrder] ?? 9) - (severityOrder[b.severity as keyof typeof severityOrder] ?? 9));

  const severityConfig = {
    rot: { border: "border-l-red-500", bg: "bg-red-50/50", icon: <AlertCircle className="w-5 h-5 text-red-600 shrink-0" />, badge: "bg-red-100 text-red-800" },
    gelb: { border: "border-l-amber-500", bg: "bg-amber-50/50", icon: <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0" />, badge: "bg-amber-100 text-amber-800" },
    gruen: { border: "border-l-emerald-500", bg: "bg-emerald-50/50", icon: <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />, badge: "bg-emerald-100 text-emerald-800" },
  };

  return (
    <div className="space-y-2 mb-6" data-testid="alerts-section">
      <h3 className="text-sm font-semibold text-muted-foreground mb-2">Handlungsbedarf</h3>
      {sorted.map((alert, i) => {
        const cfg = severityConfig[alert.severity as keyof typeof severityConfig] || severityConfig.gelb;
        return (
          <Card key={i} className={`border-l-4 ${cfg.border} ${cfg.bg}`} data-testid={`alert-${i}`}>
            <CardContent className="p-4 flex items-start gap-3">
              {cfg.icon}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="font-semibold text-sm">{alert.title}</span>
                  <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${cfg.badge}`}>{alert.count}</span>
                </div>
                <p className="text-xs text-muted-foreground">{alert.description}</p>
              </div>
              {alert.link && (
                <Link href={alert.link}>
                  <Button variant="ghost" size="sm" className="shrink-0 text-xs" data-testid={`alert-${i}-link`}>
                    Anzeigen
                  </Button>
                </Link>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

