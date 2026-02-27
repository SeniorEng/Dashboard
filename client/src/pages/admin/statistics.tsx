import { useState, useMemo } from "react";
import { Link } from "wouter";
import { formatKm } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ArrowLeft, Loader2, BarChart3, Users, TrendingUp, Activity,
  Euro, Car, Clock, UserCheck, Heart, CalendarDays, PiggyBank,
  CalendarCheck, UserX,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { iconSize, componentStyles } from "@/design-system";
import { api, unwrapResult } from "@/lib/api/client";

const MONTH_NAMES = [
  "", "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember",
];

function cents(value: number | string | bigint): string {
  const num = typeof value === "string" ? parseInt(value) : Number(value);
  return new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" }).format(num / 100);
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
  const [selectedYear, setSelectedYear] = useState(currentYear);
  const [selectedMonth, setSelectedMonth] = useState<string>("all");
  const [activeTab, setActiveTab] = useState("overview");

  const monthParam = selectedMonth !== "all" ? `&month=${selectedMonth}` : "";

  const { data, isLoading } = useQuery<any>({
    queryKey: ["statistics", selectedYear, selectedMonth],
    queryFn: async () => {
      const result = await api.get(`/statistics/overview?year=${selectedYear}${monthParam}`);
      return unwrapResult(result);
    },
    staleTime: 60000,
  });

  const { data: topCustomers } = useQuery<any[]>({
    queryKey: ["statistics-top-customers", selectedYear],
    queryFn: async () => {
      const result = await api.get<any[]>(`/statistics/top-customers?year=${selectedYear}`);
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

  const employees = data?.employees ?? [];
  const revenue = data?.revenue ?? {};
  const customerStats = data?.customers ?? {};
  const efficiency = data?.efficiency ?? {};
  const trends = data?.monthlyTrends ?? [];
  const pflegegrad = data?.pflegegradDistribution ?? [];
  const budget = data?.budgetUtilization ?? {};

  const maxAppointments = useMemo(() => {
    return Math.max(...trends.map((t: any) => Number(t.completedCount || 0)), 1);
  }, [trends]);

  const maxEmpAppts = useMemo(() => {
    return Math.max(...employees.map((e: any) => Number(e.appointments || 0)), 1);
  }, [employees]);

  const periodLabel = selectedMonth !== "all"
    ? `${MONTH_NAMES[parseInt(selectedMonth)]} ${selectedYear}`
    : `${selectedYear}`;

  return (
    <Layout variant="admin">
      <div className="max-w-6xl mx-auto">
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
          <span className="text-sm text-muted-foreground ml-auto">{periodLabel}</span>
        </div>

        {isLoading ? (
          <div className="flex justify-center py-16">
            <Loader2 className={`${iconSize.lg} animate-spin text-teal-600`} />
          </div>
        ) : (
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList className="mb-6 flex-wrap h-auto gap-1">
              <TabsTrigger value="overview" data-testid="tab-overview">Übersicht</TabsTrigger>
              <TabsTrigger value="profitability" data-testid="tab-profitability">Deckungsbeitrag</TabsTrigger>
              <TabsTrigger value="employees" data-testid="tab-employees">Mitarbeiter</TabsTrigger>
              <TabsTrigger value="customers" data-testid="tab-customers">Kunden</TabsTrigger>
              <TabsTrigger value="trends" data-testid="tab-trends">Trends</TabsTrigger>
              <TabsTrigger value="planning" data-testid="tab-planning">Planung</TabsTrigger>
            </TabsList>

            {/* OVERVIEW TAB */}
            <TabsContent value="overview">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
                <StatCard
                  label="Erlöse (kalk.)"
                  value={cents(profitability?.totals?.revenueCents || 0)}
                  sub={`DB: ${cents(profitability?.totals?.marginCents || 0)} (${profitability?.marginPercent || 0}%)`}
                  icon={<Euro className="w-5 h-5" />}
                  color="text-emerald-600"
                  testId="stat-revenue"
                />
                <StatCard
                  label="Termine abgeschlossen"
                  value={efficiency.completedAppointments || 0}
                  icon={<CalendarDays className="w-5 h-5" />}
                  color="text-blue-600"
                  testId="stat-appointments"
                />
                <StatCard
                  label="Aktive Kunden"
                  value={customerStats.activeCustomers || 0}
                  icon={<Users className="w-5 h-5" />}
                  color="text-purple-600"
                  testId="stat-customers"
                />
                <StatCard
                  label="Aktive Mitarbeiter"
                  value={employees.filter((e: any) => e.appointments > 0).length}
                  icon={<UserCheck className="w-5 h-5" />}
                  color="text-teal-600"
                  testId="stat-employees"
                />
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
                <StatCard
                  label="Stornoquote"
                  value={pct(efficiency.cancelledAppointments || 0, efficiency.totalAppointments || 1)}
                  sub={`${efficiency.cancelledAppointments || 0} storniert`}
                  color="text-red-600"
                  testId="stat-cancel-rate"
                />
                <StatCard
                  label="Gesamt-KM"
                  value={`${formatKm((efficiency.totalTravelKm || 0) + (efficiency.totalCustomerKm || 0))} km`}
                  sub={`${formatKm(efficiency.totalTravelKm)} Anfahrt + ${formatKm(efficiency.totalCustomerKm)} Kunden`}
                  icon={<Car className="w-5 h-5" />}
                  color="text-orange-600"
                  testId="stat-km"
                />
                <StatCard
                  label="Einsatzzeit"
                  value={hours(efficiency.totalServiceMinutes || 0)}
                  sub={`${efficiency.completedAppointments || 0} Termine`}
                  icon={<Clock className="w-5 h-5" />}
                  color="text-amber-600"
                  testId="stat-service-time"
                />
                <StatCard
                  label="§45b Nutzung"
                  value={pct(Number(budget.totalUsedCents || 0), Number(budget.totalAllocatedCents || 1))}
                  sub={`${cents(budget.totalUsedCents || 0)} / ${cents(budget.totalAllocatedCents || 0)}`}
                  icon={<Heart className="w-5 h-5" />}
                  color="text-pink-600"
                  testId="stat-budget"
                />
              </div>

              {/* Pflegegrad Distribution */}
              <Card className="mb-6">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Pflegegradverteilung</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex gap-3 flex-wrap">
                    {pflegegrad.map((pg: any) => (
                      <div key={pg.pflegegrad} className="text-center px-4 py-2 bg-gray-50 rounded-lg" data-testid={`pg-${pg.pflegegrad}`}>
                        <div className="text-lg font-bold text-teal-700">{pg.count}</div>
                        <div className="text-xs text-muted-foreground">
                          {pg.pflegegrad === 0 ? "Kein PG" : `PG ${pg.pflegegrad}`}
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>

              {/* Quick Monthly Trend */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Monatliche Termine {selectedYear}</CardTitle>
                  <div className="flex items-center gap-4 mt-1">
                    <div className="flex items-center gap-1.5">
                      <div className="w-2.5 h-2.5 rounded-full bg-blue-500" />
                      <span className="text-xs text-muted-foreground">Kundentermine</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <div className="w-2.5 h-2.5 rounded-full bg-amber-500" />
                      <span className="text-xs text-muted-foreground">Erstberatungen</span>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    {trends.map((t: any) => (
                      <div key={t.month} className="flex items-center gap-3">
                        <span className="text-xs text-muted-foreground w-8 text-right">{MONTH_NAMES[t.month].slice(0, 3)}</span>
                        <div className="flex-1">
                          <BarStacked
                            segments={[
                              { value: Number(t.completedKundentermine || 0), color: "bg-blue-500" },
                              { value: Number(t.completedErstberatungen || 0), color: "bg-amber-500" },
                            ]}
                            max={maxAppointments}
                          />
                        </div>
                        <span className="text-xs font-medium w-16 text-right">{t.completedCount} Termine</span>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            {/* EMPLOYEES TAB */}
            <TabsContent value="employees">
              <div className="space-y-3">
                {employees.filter((e: any) => e.appointments > 0 || e.sickDays > 0 || e.vacationDays > 0).map((emp: any) => (
                  <Card key={emp.id} data-testid={`employee-${emp.id}`}>
                    <CardContent className="p-4">
                      <div className="flex items-center justify-between mb-3">
                        <span className="font-semibold">{emp.name}</span>
                        {(() => {
                          const profEmp = profitability?.employees?.find((pe: any) => pe.employeeId === emp.id);
                          return profEmp ? (
                            <span className="text-sm font-medium text-emerald-600">{cents(profEmp.marginCents)} DB</span>
                          ) : null;
                        })()}
                      </div>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm mb-3">
                        <div>
                          <div className="text-muted-foreground text-xs">Termine</div>
                          <div className="font-medium">{emp.appointments}</div>
                        </div>
                        <div>
                          <div className="text-muted-foreground text-xs">Kunden</div>
                          <div className="font-medium">{emp.customers}</div>
                        </div>
                        <div>
                          <div className="text-muted-foreground text-xs">Arbeitszeit</div>
                          <div className="font-medium">{hours(emp.workMinutes)}</div>
                        </div>
                        <div>
                          <div className="text-muted-foreground text-xs">DB/Stunde</div>
                          <div className="font-medium">
                            {(() => {
                              const profEmp = profitability?.employees?.find((pe: any) => pe.employeeId === emp.id);
                              return profEmp && Number(profEmp.totalMinutes) > 0
                                ? cents(Math.round(Number(profEmp.marginCents) / (Number(profEmp.totalMinutes) / 60)))
                                : "–";
                            })()}
                          </div>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                        <div>
                          <div className="text-muted-foreground text-xs">Anfahrt-KM</div>
                          <div className="font-medium">{formatKm(emp.travelKm)} km</div>
                        </div>
                        <div>
                          <div className="text-muted-foreground text-xs">Kunden-KM</div>
                          <div className="font-medium">{formatKm(emp.customerKm)} km</div>
                        </div>
                        <div>
                          <div className="text-muted-foreground text-xs">Kranktage</div>
                          <div className={`font-medium ${emp.sickDays > 5 ? "text-red-600" : ""}`}>{emp.sickDays}</div>
                        </div>
                        <div>
                          <div className="text-muted-foreground text-xs">Urlaub</div>
                          <div className="font-medium">{emp.vacationDays} Tage</div>
                        </div>
                      </div>
                      <div className="mt-3">
                        <div className="text-xs text-muted-foreground mb-1">Termine-Anteil</div>
                        <BarSimple value={emp.appointments} max={maxEmpAppts} color="bg-blue-500" />
                      </div>
                    </CardContent>
                  </Card>
                ))}
                {employees.filter((e: any) => e.appointments > 0 || e.sickDays > 0 || e.vacationDays > 0).length === 0 && (
                  <Card>
                    <CardContent className="py-12 text-center text-muted-foreground">
                      Keine Mitarbeiterdaten für den gewählten Zeitraum.
                    </CardContent>
                  </Card>
                )}
              </div>
            </TabsContent>

            {/* PROFITABILITY TAB */}
            <TabsContent value="profitability">
              {profitability ? (() => {
                const t = profitability.totals;
                const empList = profitability.employees || [];
                const maxEmpMargin = Math.max(...empList.map((e: any) => Number(e.marginCents || 0)), 1);
                const prices = profitability.servicePrices || [];
                const hwPrice = prices.find((p: any) => p.code === 'hauswirtschaft');
                const abPrice = prices.find((p: any) => p.code === 'alltagsbegleitung');
                const kmPrice = prices.find((p: any) => p.code === 'travel_km');
                const ckmPrice = prices.find((p: any) => p.code === 'customer_km');
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
                      <StatCard
                        label="Kalkulierte Erlöse"
                        value={cents(t.revenueCents)}
                        sub={`${cents(t.revenueServiceCents)} Dienst + ${cents(t.revenueKmCents)} KM`}
                        icon={<Euro className="w-5 h-5" />}
                        color="text-emerald-600"
                        testId="profit-revenue"
                      />
                      <StatCard
                        label="Personalkosten"
                        value={cents(t.costCents)}
                        sub={`${cents(t.costServiceCents)} Dienst + ${cents(t.costKmCents)} KM`}
                        icon={<Users className="w-5 h-5" />}
                        color="text-red-600"
                        testId="profit-costs"
                      />
                      <StatCard
                        label="Einsatzstunden"
                        value={hours(t.totalMinutes)}
                        sub={`${t.appointments} Termine`}
                        icon={<Clock className="w-5 h-5" />}
                        color="text-blue-600"
                        testId="profit-hours"
                      />
                      <StatCard
                        label="Erlös/Stunde"
                        value={t.totalMinutes > 0 ? cents(Math.round(t.revenueCents / (t.totalMinutes / 60))) : "–"}
                        sub={t.totalMinutes > 0 ? `Kosten: ${cents(Math.round(t.costCents / (t.totalMinutes / 60)))}/h` : ""}
                        icon={<TrendingUp className="w-5 h-5" />}
                        color="text-teal-600"
                        testId="profit-per-hour"
                      />
                    </div>

                    <Card className="mb-4">
                      <CardHeader className="pb-3">
                        <CardTitle className="text-base">Kalkulationsgrundlage</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
                          {hwPrice && (
                            <div className="bg-gray-50 rounded-lg p-3">
                              <div className="font-medium mb-1">Hauswirtschaft</div>
                              <div className="text-muted-foreground">Erlös: {cents(hwPrice.priceCents)}/h</div>
                              <div className="text-muted-foreground">MA-Kosten: {cents(hwPrice.rateCents)}/h</div>
                              <div className="text-emerald-600 font-medium">Marge: {cents(hwPrice.priceCents - hwPrice.rateCents)}/h ({Math.round(((hwPrice.priceCents - hwPrice.rateCents) / hwPrice.priceCents) * 100)}%)</div>
                            </div>
                          )}
                          {abPrice && (
                            <div className="bg-gray-50 rounded-lg p-3">
                              <div className="font-medium mb-1">Alltagsbegleitung</div>
                              <div className="text-muted-foreground">Erlös: {cents(abPrice.priceCents)}/h</div>
                              <div className="text-muted-foreground">MA-Kosten: {cents(abPrice.rateCents)}/h</div>
                              <div className="text-emerald-600 font-medium">Marge: {cents(abPrice.priceCents - abPrice.rateCents)}/h ({Math.round(((abPrice.priceCents - abPrice.rateCents) / abPrice.priceCents) * 100)}%)</div>
                            </div>
                          )}
                          {kmPrice && (
                            <div className="bg-gray-50 rounded-lg p-3">
                              <div className="font-medium mb-1">Anfahrtskilometer</div>
                              <div className="text-muted-foreground">Erlös: {cents(kmPrice.priceCents)}/km</div>
                              <div className="text-muted-foreground">MA-Kosten: {cents(kmPrice.rateCents)}/km</div>
                              <div className="text-muted-foreground font-medium">Marge: {cents(kmPrice.priceCents - kmPrice.rateCents)}/km</div>
                            </div>
                          )}
                          {ckmPrice && (
                            <div className="bg-gray-50 rounded-lg p-3">
                              <div className="font-medium mb-1">Kundenkilometer</div>
                              <div className="text-muted-foreground">Erlös: {cents(ckmPrice.priceCents)}/km</div>
                              <div className="text-muted-foreground">MA-Kosten: {cents(ckmPrice.rateCents)}/km</div>
                              <div className="text-muted-foreground font-medium">Marge: {cents(ckmPrice.priceCents - ckmPrice.rateCents)}/km</div>
                            </div>
                          )}
                        </div>
                      </CardContent>
                    </Card>

                    <Card>
                      <CardHeader className="pb-3">
                        <CardTitle className="text-base">Deckungsbeitrag pro Mitarbeiter</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <div className="space-y-3">
                          {empList.map((emp: any, i: number) => {
                            const empMarginPct = Number(emp.revenueCents) > 0
                              ? Math.round((Number(emp.marginCents) / Number(emp.revenueCents)) * 100)
                              : 0;
                            return (
                              <div key={emp.employeeId} className="border rounded-lg p-3" data-testid={`profit-employee-${emp.employeeId}`}>
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
                                <BarSimple value={Number(emp.marginCents)} max={maxEmpMargin} color={Number(emp.marginCents) >= 0 ? "bg-emerald-500" : "bg-red-500"} />
                                <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mt-2 text-xs">
                                  <div>
                                    <span className="text-muted-foreground">Erlöse: </span>
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
                                    <span className="text-muted-foreground">Termine: </span>
                                    <span className="font-medium">{emp.appointments}</span>
                                  </div>
                                  <div>
                                    <span className="text-muted-foreground">KM: </span>
                                    <span className="font-medium">{formatKm(emp.totalTravelKm)}+{formatKm(emp.totalCustomerKm)} km</span>
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </CardContent>
                    </Card>
                  </>
                );
              })() : (
                <div className="flex justify-center py-16">
                  <Loader2 className={`${iconSize.lg} animate-spin text-teal-600`} />
                </div>
              )}
            </TabsContent>

            {/* CUSTOMERS TAB */}
            <TabsContent value="customers">
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-6">
                <StatCard label="Aktiv" value={customerStats.activeCustomers || 0} color="text-green-600" testId="cust-active" />
                <StatCard label="Interessenten" value={customerStats.prospects || 0} color="text-blue-600" testId="cust-prospects" />
                <StatCard label="Erstberatung" value={customerStats.consultation || 0} color="text-amber-600" testId="cust-consultation" />
                <StatCard label="Inaktiv" value={customerStats.inactiveCustomers || 0} color="text-gray-500" testId="cust-inactive" />
                <StatCard label="Gekündigt" value={customerStats.terminated || 0} color="text-red-600" testId="cust-terminated" />
                <StatCard
                  label="Ø Termine/Kunde"
                  value={Number(customerStats.avgAppointmentsPerCustomer || 0).toFixed(1).replace(".", ",")}
                  color="text-teal-600"
                  testId="cust-avg-appts"
                />
              </div>

              {/* Pflegegrad */}
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
                          <div className="text-xs text-muted-foreground mb-1">
                            {pg.pflegegrad === 0 ? "Kein PG" : `PG ${pg.pflegegrad}`}
                          </div>
                          <div className="text-xs text-muted-foreground/70">{pct(pg.count, total)}</div>
                        </div>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>

              {/* Budget */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">§45b Entlastungsbudget {selectedYear}</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-3 gap-4 mb-3">
                    <div>
                      <div className="text-xs text-muted-foreground">Zugewiesen</div>
                      <div className="text-lg font-bold text-blue-600">{cents(budget.totalAllocatedCents || 0)}</div>
                    </div>
                    <div>
                      <div className="text-xs text-muted-foreground">Verbraucht</div>
                      <div className="text-lg font-bold text-emerald-600">{cents(budget.totalUsedCents || 0)}</div>
                    </div>
                    <div>
                      <div className="text-xs text-muted-foreground">Verfügbar</div>
                      <div className="text-lg font-bold text-amber-600">
                        {cents(Math.max(0, Number(budget.totalAllocatedCents || 0) - Number(budget.totalUsedCents || 0)))}
                      </div>
                    </div>
                  </div>
                  <BarSimple
                    value={Number(budget.totalUsedCents || 0)}
                    max={Number(budget.totalAllocatedCents || 1)}
                    color="bg-emerald-500"
                  />
                  <div className="text-xs text-muted-foreground mt-1 text-right">
                    {pct(Number(budget.totalUsedCents || 0), Number(budget.totalAllocatedCents || 1))} genutzt
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            {/* TRENDS TAB */}
            <TabsContent value="trends">
              <Card className="mb-4">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Monatliche Termine {selectedYear}</CardTitle>
                  <div className="flex items-center gap-4 mt-1">
                    <div className="flex items-center gap-1.5">
                      <div className="w-2.5 h-2.5 rounded-full bg-blue-500" />
                      <span className="text-xs text-muted-foreground">Kundentermine</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <div className="w-2.5 h-2.5 rounded-full bg-amber-500" />
                      <span className="text-xs text-muted-foreground">Erstberatungen</span>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    {trends.map((t: any) => {
                      const kt = Number(t.completedKundentermine || 0);
                      const eb = Number(t.completedErstberatungen || 0);
                      return (
                        <div key={t.month} className="flex items-center gap-3">
                          <span className="text-xs text-muted-foreground w-8 text-right">{MONTH_NAMES[t.month].slice(0, 3)}</span>
                          <div className="flex-1">
                            <BarStacked
                              segments={[
                                { value: kt, color: "bg-blue-500" },
                                { value: eb, color: "bg-amber-500" },
                              ]}
                              max={maxAppointments}
                            />
                          </div>
                          <div className="text-xs w-32 text-right">
                            <span className="font-medium">{kt}</span>
                            <span className="text-muted-foreground"> + </span>
                            <span className="font-medium text-amber-600">{eb}</span>
                            <span className="text-muted-foreground"> EB</span>
                            {Number(t.cancelledCount) > 0 && (
                              <span className="text-red-500 ml-1">({t.cancelledCount} st.)</span>
                            )}
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
                            <div className="text-xs text-muted-foreground">{t.scheduledCount} offen · {t.completedCount} erledigt</div>
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
                                    <span className="text-muted-foreground ml-1">({emp.scheduledCount} offen)</span>
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

                    <Card>
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
      </div>
    </Layout>
  );
}
