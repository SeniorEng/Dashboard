import { useMemo } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CockpitKPI, BarStacked } from "@/components/charts";
import {
  Loader2, PiggyBank, Gauge, Wallet,
  AlertTriangle, CheckCircle2, AlertCircle,
} from "lucide-react";
import { iconSize } from "@/design-system";
import { api, unwrapResult } from "@/lib/api/client";
import { MONTH_NAMES } from "@/features/time-tracking/constants";
import { cents, hours } from "./helpers";

interface CockpitTabProps {
  selectedYear: number;
  selectedMonth: string;
}

export function CockpitTab({ selectedYear, selectedMonth }: CockpitTabProps) {
  const monthParam = selectedMonth !== "all" ? `&month=${selectedMonth}` : "";

  const { data, isLoading } = useQuery<any>({
    queryKey: ["statistics", selectedYear, selectedMonth],
    queryFn: async () => {
      const result = await api.get(`/statistics/overview?year=${selectedYear}${monthParam}`);
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
  const cockpitMargin = cockpit?.margin || { revenueCents: 0, costCents: 0, marginCents: 0, marginPercent: 0, appointments: 0, totalMinutes: 0 };
  const cockpitUtil = cockpit?.utilization || { productiveMinutes: 0, overheadMinutes: 0, percent: 0, appointments: 0 };
  const cockpitBudget = cockpit?.budget || { allocatedCents: 0, usedCents: 0, percent: 0, customerCount: 0 };
  const trends = data?.monthlyTrends ?? [];

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

  if (isLoading || !cockpit) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className={`${iconSize.lg} animate-spin text-teal-600`} />
      </div>
    );
  }

  return (
    <>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <CockpitKPI
          title="DB-Marge"
          icon={<PiggyBank className="w-5 h-5" />}
          value={`${cockpitMargin.marginPercent}%`}
          percent={cockpitMargin.marginPercent}
          thresholds={{ green: 45, yellow: 30 }}
          prevValue={cockpit?.marginPrev ? cockpit.marginPrev.marginPercent : null}
          prevLabel="Vormonat"
          metrics={[
            { label: "Erlöse", value: cents(cockpitMargin.revenueCents) },
            { label: "DB", value: cents(cockpitMargin.marginCents) },
            { label: "Termine", value: String(cockpitMargin.appointments) },
          ]}
          testId="cockpit-margin"
        />
        <CockpitKPI
          title="Auslastung"
          icon={<Gauge className="w-5 h-5" />}
          value={`${cockpitUtil.percent}%`}
          percent={cockpitUtil.percent}
          thresholds={{ green: 75, yellow: 60 }}
          prevValue={cockpit?.utilizationPrev ? cockpit.utilizationPrev.percent : null}
          prevLabel="Vormonat"
          metrics={[
            { label: "Produktiv", value: hours(cockpitUtil.productiveMinutes) },
            { label: "Overhead", value: hours(cockpitUtil.overheadMinutes) },
            { label: "Termine", value: String(cockpitUtil.appointments) },
          ]}
          testId="cockpit-utilization"
        />
        <CockpitKPI
          title="Budget gesamt"
          icon={<Wallet className="w-5 h-5" />}
          value={`${cockpitBudget.percent}%`}
          percent={cockpitBudget.percent}
          thresholds={{ green: 70, yellow: 50 }}
          prevValue={cockpit?.budgetPrev ? cockpit.budgetPrev.percent : null}
          prevLabel="Vormonat"
          metrics={[
            { label: "Verbraucht", value: cents(cockpitBudget.usedCents) },
            { label: "Verfügbar", value: cents(cockpitBudget.allocatedCents) },
            { label: "Kunden", value: String(cockpitBudget.customerCount) },
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
                  <span className="text-xs text-muted-foreground w-8 text-right">{(MONTH_NAMES[t.month - 1] || "?").slice(0, 3)}</span>
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
