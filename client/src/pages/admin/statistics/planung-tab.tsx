import { useMemo } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { StatCard, BarSimple, BarStacked } from "@/components/charts";
import {
  Loader2, Users, Euro, Clock, PiggyBank,
  CalendarCheck, UserX,
} from "lucide-react";
import { iconSize } from "@/design-system";
import { api, unwrapResult } from "@/lib/api/client";
import { MONTH_NAMES } from "@/features/time-tracking/constants";
import { cents, hours } from "./helpers";
import type {
  OverviewResponse,
  PlanningResponse,
  PlanningEmployee,
  MonthlyTrend,
  CustomerWithoutAppointment,
} from "./helpers";

interface PlanungTabProps {
  selectedYear: number;
  selectedMonth: string;
  periodLabel: string;
}

export function PlanungTab({ selectedYear, selectedMonth, periodLabel }: PlanungTabProps) {
  const monthParam = selectedMonth !== "all" ? `&month=${selectedMonth}` : "";

  const { data: statsData } = useQuery<OverviewResponse>({
    queryKey: ["statistics", selectedYear, selectedMonth],
    queryFn: async () => {
      const result = await api.get<OverviewResponse>(`/statistics/overview?year=${selectedYear}${monthParam}`);
      return unwrapResult(result);
    },
    staleTime: 60000,
  });

  const { data: planning } = useQuery<PlanningResponse>({
    queryKey: ["statistics-planning", selectedYear, selectedMonth],
    queryFn: async () => {
      const result = await api.get<PlanningResponse>(`/statistics/planning?year=${selectedYear}${monthParam}`);
      return unwrapResult(result);
    },
    staleTime: 60000,
  });

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
      const vertr = Number(t.vertriebMinutes || 0);
      const sonst = Number(t.sonstigesMinutes || 0);
      return hw + ab + eb + pause + urlaub + krank + buero + vertr + sonst;
    }), 1);
  }, [trends]);

  if (!planning) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className={`${iconSize.lg} animate-spin text-teal-600`} />
      </div>
    );
  }

  const t = planning.totals || {};
  const planEmpList = planning.employees || [];
  const maxPlanMargin = Math.max(...planEmpList.map((e: PlanningEmployee) => Math.abs(Number(e.marginCents || 0))), 1);
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
              <div className={`text-xl font-bold ${(planning.marginPercent || 0) >= 50 ? 'text-emerald-600' : (planning.marginPercent || 0) >= 30 ? 'text-amber-600' : 'text-red-600'}`} data-testid="planning-margin-pct">
                {planning.marginPercent || 0}% DB
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
            {planEmpList.map((emp: PlanningEmployee, i: number) => {
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
              {noApptCustomers.map((c: CustomerWithoutAppointment) => (
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
                {trends.map((t: MonthlyTrend) => {
                  const hw = Number(t.hwMinutes || 0);
                  const ab = Number(t.abMinutes || 0);
                  const eb = Number(t.ebMinutes || 0);
                  const pause = Number(t.pauseMinutes || 0);
                  const buero = Number(t.bueroarbeitMinutes || 0);
                  const vertr = Number(t.vertriebMinutes || 0);
                  const sonst = Number(t.sonstigesMinutes || 0) + Number(t.krankMinutes || 0) + Number(t.urlaubMinutes || 0);
                  const totalMin = hw + ab + eb + pause + buero + vertr + sonst;
                  const totalHours = totalMin > 0 ? (totalMin / 60).toFixed(1) : "0";
                  const termine = Number(t.completedHauswirtschaft || 0) + Number(t.completedAlltagsbegleitung || 0) + Number(t.completedErstberatungen || 0);
                  return (
                    <div key={t.month} className="flex items-center gap-3">
                      <span className="text-xs text-muted-foreground w-8 text-right">{(MONTH_NAMES[t.month - 1] || "?").slice(0, 3)}</span>
                      <div className="flex-1">
                        <BarStacked
                          segments={[
                            { value: hw, color: "bg-blue-500" },
                            { value: ab, color: "bg-teal-500" },
                            { value: eb, color: "bg-amber-500" },
                            { value: pause, color: "bg-slate-400" },
                            { value: buero, color: "bg-indigo-500" },
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
                {trends.map((t: MonthlyTrend) => {
                  const maxCust = Math.max(...trends.map((tr: MonthlyTrend) => Number(tr.activeCustomers || 0)), 1);
                  return (
                    <div key={t.month} className="flex items-center gap-3">
                      <span className="text-xs text-muted-foreground w-8 text-right">{(MONTH_NAMES[t.month - 1] || "?").slice(0, 3)}</span>
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
}
