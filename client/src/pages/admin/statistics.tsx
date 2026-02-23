import { useState, useMemo } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ArrowLeft, Loader2, BarChart3, Users, TrendingUp, Activity,
  Euro, Car, Clock, UserCheck, Heart, CalendarDays,
} from "lucide-react";
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
      const result = await api.get(`/statistics/top-customers?year=${selectedYear}`);
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

  const maxRevenue = useMemo(() => {
    return Math.max(...trends.map((t: any) => Number(t.revenueCents || 0)), 1);
  }, [trends]);

  const maxAppointments = useMemo(() => {
    return Math.max(...trends.map((t: any) => Number(t.completedCount || 0)), 1);
  }, [trends]);

  const maxEmpAppts = useMemo(() => {
    return Math.max(...employees.map((e: any) => Number(e.appointments || 0)), 1);
  }, [employees]);

  const maxEmpRevenue = useMemo(() => {
    return Math.max(...employees.map((e: any) => Number(e.revenueCents || 0)), 1);
  }, [employees]);

  const periodLabel = selectedMonth !== "all"
    ? `${MONTH_NAMES[parseInt(selectedMonth)]} ${selectedYear}`
    : `${selectedYear}`;

  return (
    <Layout variant="admin">
      <div className="container mx-auto px-4 py-6 max-w-6xl">
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
              <TabsTrigger value="employees" data-testid="tab-employees">Mitarbeiter</TabsTrigger>
              <TabsTrigger value="revenue" data-testid="tab-revenue">Umsatz</TabsTrigger>
              <TabsTrigger value="customers" data-testid="tab-customers">Kunden</TabsTrigger>
              <TabsTrigger value="trends" data-testid="tab-trends">Trends</TabsTrigger>
            </TabsList>

            {/* OVERVIEW TAB */}
            <TabsContent value="overview">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
                <StatCard
                  label="Umsatz"
                  value={cents(revenue.totalRevenueCents || 0)}
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
                  value={`${(efficiency.totalTravelKm || 0) + (efficiency.totalCustomerKm || 0)} km`}
                  sub={`${efficiency.totalTravelKm || 0} Anfahrt + ${efficiency.totalCustomerKm || 0} Kunden`}
                  icon={<Car className="w-5 h-5" />}
                  color="text-orange-600"
                  testId="stat-km"
                />
                <StatCard
                  label="Fahrzeitquote"
                  value={pct(efficiency.totalTravelMinutes || 0, (efficiency.totalServiceMinutes || 0) + (efficiency.totalTravelMinutes || 0))}
                  sub={`${hours(efficiency.totalTravelMinutes || 0)} von ${hours((efficiency.totalServiceMinutes || 0) + (efficiency.totalTravelMinutes || 0))}`}
                  icon={<Clock className="w-5 h-5" />}
                  color="text-amber-600"
                  testId="stat-travel-rate"
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
                  <CardTitle className="text-base">Monatlicher Umsatz {selectedYear}</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    {trends.map((t: any) => (
                      <div key={t.month} className="flex items-center gap-3">
                        <span className="text-xs text-muted-foreground w-8 text-right">{MONTH_NAMES[t.month].slice(0, 3)}</span>
                        <div className="flex-1">
                          <BarSimple value={Number(t.revenueCents)} max={maxRevenue} color="bg-emerald-500" />
                        </div>
                        <span className="text-xs font-medium w-20 text-right">{cents(t.revenueCents)}</span>
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
                        <span className="text-sm font-medium text-emerald-600">{cents(emp.revenueCents)}</span>
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
                          <div className="text-muted-foreground text-xs">Umsatz/Stunde</div>
                          <div className="font-medium">
                            {emp.workMinutes > 0 ? cents(Math.round(Number(emp.revenueCents) / (emp.workMinutes / 60))) : "–"}
                          </div>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                        <div>
                          <div className="text-muted-foreground text-xs">Anfahrt-KM</div>
                          <div className="font-medium">{emp.travelKm} km</div>
                        </div>
                        <div>
                          <div className="text-muted-foreground text-xs">Kunden-KM</div>
                          <div className="font-medium">{emp.customerKm} km</div>
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

            {/* REVENUE TAB */}
            <TabsContent value="revenue">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
                <StatCard label="Gesamtumsatz" value={cents(revenue.totalRevenueCents || 0)} color="text-emerald-600" testId="rev-total" />
                <StatCard label="Bezahlt" value={cents(revenue.paidRevenueCents || 0)} color="text-green-600" testId="rev-paid" />
                <StatCard label="Offen" value={cents(revenue.openRevenueCents || 0)} color="text-amber-600" testId="rev-open" />
                <StatCard label="Rechnungen" value={`${revenue.totalInvoices || 0}`} sub={`${revenue.paidInvoices || 0} bezahlt, ${revenue.openInvoices || 0} offen`} color="text-blue-600" testId="rev-invoices" />
              </div>

              {/* Top Customers */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Top-Kunden nach Umsatz</CardTitle>
                </CardHeader>
                <CardContent>
                  {topCustomers && topCustomers.length > 0 ? (
                    <div className="space-y-2">
                      {topCustomers.filter((c: any) => Number(c.revenueCents) > 0).map((c: any, i: number) => (
                        <div key={c.id} className="flex items-center gap-3" data-testid={`top-customer-${c.id}`}>
                          <span className="text-xs text-muted-foreground w-6 text-right">{i + 1}.</span>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium truncate">{c.name}</span>
                              {c.pflegegrad && (
                                <span className="text-xs px-1.5 py-0.5 rounded bg-teal-100 text-teal-700">PG {c.pflegegrad}</span>
                              )}
                            </div>
                            <BarSimple
                              value={Number(c.revenueCents)}
                              max={Number(topCustomers[0]?.revenueCents || 1)}
                              color="bg-emerald-400"
                            />
                          </div>
                          <div className="text-right shrink-0">
                            <div className="text-sm font-medium">{cents(c.revenueCents)}</div>
                            <div className="text-xs text-muted-foreground">{c.appointmentCount} Termine</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">Keine Umsatzdaten vorhanden.</p>
                  )}
                </CardContent>
              </Card>

              {/* Employee Revenue Ranking */}
              <Card className="mt-4">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Umsatz pro Mitarbeiter</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    {employees.filter((e: any) => Number(e.revenueCents) > 0).map((e: any, i: number) => (
                      <div key={e.id} className="flex items-center gap-3">
                        <span className="text-xs text-muted-foreground w-6 text-right">{i + 1}.</span>
                        <div className="flex-1">
                          <div className="text-sm font-medium mb-0.5">{e.name}</div>
                          <BarSimple value={Number(e.revenueCents)} max={maxEmpRevenue} color="bg-teal-500" />
                        </div>
                        <div className="text-right shrink-0">
                          <div className="text-sm font-medium">{cents(e.revenueCents)}</div>
                          <div className="text-xs text-muted-foreground">{e.appointments} Termine</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
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
                  value={Number(customerStats.avgAppointmentsPerCustomer || 0).toFixed(1)}
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
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    {trends.map((t: any) => (
                      <div key={t.month} className="flex items-center gap-3">
                        <span className="text-xs text-muted-foreground w-8 text-right">{MONTH_NAMES[t.month].slice(0, 3)}</span>
                        <div className="flex-1 flex gap-1">
                          <div className="flex-1">
                            <BarSimple value={Number(t.completedCount)} max={maxAppointments} color="bg-blue-500" />
                          </div>
                        </div>
                        <div className="text-xs w-28 text-right">
                          <span className="font-medium">{t.completedCount}</span>
                          <span className="text-muted-foreground"> erledigt</span>
                          {Number(t.cancelledCount) > 0 && (
                            <span className="text-red-500 ml-1">({t.cancelledCount} storn.)</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>

              <Card className="mb-4">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Monatlicher Umsatz {selectedYear}</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    {trends.map((t: any) => (
                      <div key={t.month} className="flex items-center gap-3">
                        <span className="text-xs text-muted-foreground w-8 text-right">{MONTH_NAMES[t.month].slice(0, 3)}</span>
                        <div className="flex-1">
                          <BarSimple value={Number(t.revenueCents)} max={maxRevenue} color="bg-emerald-500" />
                        </div>
                        <span className="text-xs font-medium w-20 text-right">{cents(t.revenueCents)}</span>
                      </div>
                    ))}
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
          </Tabs>
        )}
      </div>
    </Layout>
  );
}
