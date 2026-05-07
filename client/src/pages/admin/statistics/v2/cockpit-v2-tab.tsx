import { useState, useMemo } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { KpiTile } from "@/components/charts";
import {
  Loader2, Euro, Users, Clock, CalendarCheck, TrendingUp, Activity,
  AlertTriangle, CheckCircle2, AlertCircle, ChevronRight,
} from "lucide-react";
import { iconSize } from "@/design-system";
import { api, unwrapResult } from "@/lib/api/client";
import { cents, hours } from "../helpers";
import type {
  CockpitResponse,
  ProcessHealthSummary,
  RevenueStage,
} from "@shared/statistics";
import type { AlertItem } from "../helpers";

interface CockpitV2TabProps {
  selectedYear: number;
  selectedMonth: string;
}

const STAGE_LABELS: Record<RevenueStage, string> = {
  planned: "Geplant",
  documented: "Dokumentiert",
  proven: "Nachgewiesen",
  invoiced: "Berechnet",
};
const STAGE_ORDER: RevenueStage[] = ["planned", "documented", "proven", "invoiced"];

function buildQueryString(year: number, month: string): string {
  const p = new URLSearchParams({ year: String(year) });
  if (month !== "all") p.set("month", month);
  return p.toString();
}

export function CockpitV2Tab({ selectedYear, selectedMonth }: CockpitV2TabProps) {
  const [stage, setStage] = useState<RevenueStage>("documented");
  const qs = buildQueryString(selectedYear, selectedMonth);

  const cockpitQuery = useQuery<CockpitResponse>({
    queryKey: ["statistics-v2-cockpit", selectedYear, selectedMonth],
    queryFn: async () => unwrapResult(await api.get<CockpitResponse>(`/statistics/v2/cockpit?${qs}`)),
    staleTime: 60_000,
  });

  const healthQuery = useQuery<ProcessHealthSummary>({
    queryKey: ["statistics-v2-process-health", selectedYear, selectedMonth],
    queryFn: async () => unwrapResult(await api.get<ProcessHealthSummary>(`/statistics/v2/process-health?${qs}`)),
    staleTime: 60_000,
  });

  const alertsQuery = useQuery<AlertItem[]>({
    queryKey: ["statistics-alerts"],
    queryFn: async () => unwrapResult(await api.get<AlertItem[]>(`/statistics/v2/alerts`)),
    staleTime: 120_000,
  });

  if (cockpitQuery.isLoading || healthQuery.isLoading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4" data-testid="cockpit-v2-loading">
        {Array.from({ length: 6 }).map((_, i) => (
          <Card key={i} className="animate-pulse h-44">
            <CardContent className="p-5 space-y-3">
              <div className="h-4 bg-muted rounded w-1/2" />
              <div className="h-8 bg-muted rounded w-2/3" />
              <div className="h-3 bg-muted rounded w-1/3" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  if (cockpitQuery.isError || !cockpitQuery.data) {
    return (
      <Card className="border-red-200 bg-red-50/50" data-testid="cockpit-v2-error">
        <CardContent className="p-4 flex items-center gap-3 text-red-700">
          <AlertCircle className={iconSize.md} />
          <span>Cockpit konnte nicht geladen werden. Bitte erneut versuchen.</span>
        </CardContent>
      </Card>
    );
  }

  if (healthQuery.isError || !healthQuery.data) {
    return (
      <Card className="border-red-200 bg-red-50/50" data-testid="cockpit-v2-health-error">
        <CardContent className="p-4 flex items-center gap-3 text-red-700">
          <AlertCircle className={iconSize.md} />
          <span>Prozess-Gesundheit konnte nicht geladen werden. Bitte erneut versuchen.</span>
        </CardContent>
      </Card>
    );
  }

  const cockpit = cockpitQuery.data;
  const health = healthQuery.data;
  const alerts = alertsQuery.data ?? [];

  const isYear = selectedMonth === "all";
  const compareLabel = isYear ? "vs. Vorjahr" : "vs. Vormonat";

  const pickDelta = (kpi: { deltaAbs: number | null; deltaPct: number | null; deltaYearAbs: number | null; deltaYearPct: number | null }) =>
    isYear
      ? { abs: kpi.deltaYearAbs, pct: kpi.deltaYearPct }
      : { abs: kpi.deltaAbs, pct: kpi.deltaPct };

  const fmtCentsDelta = (abs: number) => `${abs > 0 ? "+" : ""}${cents(abs)}`;
  const fmtHoursDelta = (abs: number) => {
    const sign = abs > 0 ? "+" : abs < 0 ? "-" : "";
    return `${sign}${hours(Math.abs(abs))}`;
  };
  const fmtIntDelta = (abs: number) => `${abs > 0 ? "+" : ""}${abs.toLocaleString("de-DE")}`;
  const fmtDecimalDelta = (abs: number) => `${abs > 0 ? "+" : ""}${abs.toLocaleString("de-DE", { maximumFractionDigits: 1 })}`;

  const stageKpi = cockpit.revenueByStage[stage];
  const sparkRev = cockpit.sparklines.revenueDocumented.map((p) => p.value);
  const sparkCust = cockpit.sparklines.activeCustomers.map((p) => p.value);
  const sparkMin = cockpit.sparklines.totalMinutes.map((p) => p.value);
  const sparkApptsPerCust = cockpit.sparklines.appointmentsPerCustomer.map((p) => p.value);
  const sparkRevPerCust = cockpit.sparklines.revenuePerCustomer.map((p) => p.value);
  // Process-health total per month: sum of the five per-metric series.
  const phSeries = health.sparklines;
  const sparkHealth = Array.from({ length: 12 }, (_, i) =>
    (phSeries.customersWithoutEmployee[i]?.value ?? 0) +
    (phSeries.customersWithoutAppointments[i]?.value ?? 0) +
    (phSeries.undocumentedAppointments[i]?.value ?? 0) +
    (phSeries.appointmentsWithoutRecord[i]?.value ?? 0) +
    (phSeries.recordsWithoutInvoice[i]?.value ?? 0)
  );

  const hbsBadge = health.healthScore === "rot"
    ? { label: "Kritisch", className: "bg-red-100 text-red-800" }
    : health.healthScore === "gelb"
    ? { label: "Achtung", className: "bg-amber-100 text-amber-800" }
    : { label: "Gut", className: "bg-emerald-100 text-emerald-800" };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4" data-testid="cockpit-v2-tiles">
        <KpiTile
          title="Gesamtumsatz"
          icon={<Euro className="w-5 h-5" />}
          value={cents(stageKpi.current)}
          delta={pickDelta(stageKpi)}
          formatDeltaAbs={fmtCentsDelta}
          deltaLabel={compareLabel}
          higherIsBetter
          sparkline={sparkRev}
          sparklineColor="#0d9488"
          href="/admin/statistics/revenue"
          testId="kpi-revenue"
        >
          <div className="flex flex-wrap gap-1" role="tablist" aria-label="Umsatz-Stufe">
            {STAGE_ORDER.map((s) => (
              <button
                key={s}
                type="button"
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); setStage(s); }}
                className={`text-xs px-2 py-1 rounded-md border transition-colors ${
                  stage === s
                    ? "bg-teal-600 border-teal-600 text-white"
                    : "bg-white border-border text-muted-foreground hover:border-teal-400"
                }`}
                data-testid={`stage-${s}`}
                aria-pressed={stage === s}
              >
                {STAGE_LABELS[s]}
              </button>
            ))}
          </div>
        </KpiTile>

        <KpiTile
          title="Aktive Kunden"
          icon={<Users className="w-5 h-5" />}
          value={cockpit.activeCustomers.current.toLocaleString("de-DE")}
          subValue={`Netto ${cockpit.netCustomerGrowth.current >= 0 ? "+" : ""}${cockpit.netCustomerGrowth.current.toLocaleString("de-DE")} ${isYear ? "im Jahr" : "im Monat"}`}
          delta={pickDelta(cockpit.activeCustomers)}
          formatDeltaAbs={fmtIntDelta}
          deltaLabel={compareLabel}
          higherIsBetter
          sparkline={sparkCust}
          sparklineColor="#2563eb"
          href="/admin/statistics/customers"
          testId="kpi-active-customers"
        />

        <KpiTile
          title="Geleistete Stunden"
          icon={<Clock className="w-5 h-5" />}
          value={hours(cockpit.totalMinutes.current)}
          delta={pickDelta(cockpit.totalMinutes)}
          formatDeltaAbs={fmtHoursDelta}
          deltaLabel={compareLabel}
          higherIsBetter
          sparkline={sparkMin}
          sparklineColor="#7c3aed"
          href="/admin/statistics/performance"
          testId="kpi-total-minutes"
        >
          <ServiceTypeBreakdown breakdown={cockpit.minutesByServiceType} />
        </KpiTile>

        <KpiTile
          title="Ø Termine je Kunde"
          icon={<CalendarCheck className="w-5 h-5" />}
          value={cockpit.appointmentsPerCustomer.current.toLocaleString("de-DE", { maximumFractionDigits: 1 })}
          delta={pickDelta(cockpit.appointmentsPerCustomer)}
          formatDeltaAbs={fmtDecimalDelta}
          deltaLabel={compareLabel}
          higherIsBetter
          sparkline={sparkApptsPerCust}
          sparklineColor="#0ea5e9"
          href="/admin/statistics/performance"
          testId="kpi-appointments-per-customer"
        />

        <KpiTile
          title="Ø Umsatz je Kunde"
          icon={<TrendingUp className="w-5 h-5" />}
          value={cents(cockpit.revenuePerCustomer.current)}
          delta={pickDelta(cockpit.revenuePerCustomer)}
          formatDeltaAbs={fmtCentsDelta}
          deltaLabel={compareLabel}
          higherIsBetter
          sparkline={sparkRevPerCust}
          sparklineColor="#16a34a"
          href="/admin/statistics/customers"
          testId="kpi-revenue-per-customer"
        />

        <KpiTile
          title="Prozess-Gesundheit"
          icon={<Activity className="w-5 h-5" />}
          value={health.total.current.toLocaleString("de-DE")}
          subValue="offene Punkte gesamt"
          delta={pickDelta(health.total)}
          formatDeltaAbs={fmtIntDelta}
          deltaLabel={compareLabel}
          higherIsBetter={false}
          badge={hbsBadge}
          sparkline={sparkHealth}
          sparklineColor="#dc2626"
          href="/admin/statistics/process-health"
          testId="kpi-process-health"
        >
          <ProcessHealthMini health={health} />
        </KpiTile>
      </div>

      <ActionBox health={health} alerts={alerts} />
    </div>
  );
}

function ServiceTypeBreakdown({ breakdown }: { breakdown: { hauswirtschaft: number; alltagsbegleitung: number; erstberatung: number; sonstige: number } }) {
  const total = breakdown.hauswirtschaft + breakdown.alltagsbegleitung + breakdown.erstberatung + breakdown.sonstige;
  const items = [
    { label: "HW", value: breakdown.hauswirtschaft, color: "bg-blue-500" },
    { label: "AB", value: breakdown.alltagsbegleitung, color: "bg-teal-500" },
    { label: "EB", value: breakdown.erstberatung, color: "bg-amber-500" },
    { label: "Sonst.", value: breakdown.sonstige, color: "bg-slate-400" },
  ];
  return (
    <div className="space-y-2">
      <div className="w-full bg-gray-100 rounded-full h-2 flex overflow-hidden" data-testid="hours-stack-bar">
        {items.map((it) => {
          const w = total > 0 ? (it.value / total) * 100 : 0;
          if (w === 0) return null;
          return <div key={it.label} className={`h-2 ${it.color}`} style={{ width: `${w}%` }} />;
        })}
      </div>
      <div className="grid grid-cols-4 gap-1 text-[10px]">
        {items.map((it) => (
          <div key={it.label} className="flex items-center gap-1" data-testid={`hours-segment-${it.label.toLowerCase().replace(".", "")}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${it.color}`} />
            <span className="text-muted-foreground">{it.label}</span>
            <span className="font-medium ml-auto">{Math.round(it.value / 60)}h</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ProcessHealthMini({ health }: { health: ProcessHealthSummary }) {
  const items = [
    { label: "Kunden ohne MA", value: health.customersWithoutEmployee.current },
    { label: "Kunden o. Termin", value: health.customersWithoutAppointments.current },
    { label: "Undokumentiert", value: health.undocumentedAppointments.current },
    { label: "Ohne Nachweis", value: health.appointmentsWithoutRecord.current },
    { label: "Ohne Rechnung", value: health.recordsWithoutInvoice.current },
  ];
  return (
    <ul className="space-y-1 text-xs" data-testid="process-health-mini">
      {items.map((it) => (
        <li key={it.label} className="flex items-center justify-between">
          <span className="text-muted-foreground">{it.label}</span>
          <span className={`font-semibold ${it.value === 0 ? "text-emerald-700" : "text-amber-700"}`}>{it.value}</span>
        </li>
      ))}
    </ul>
  );
}

function ActionBox({ health, alerts }: { health: ProcessHealthSummary; alerts: AlertItem[] }) {
  const items = useMemo(() => {
    type Item = {
      key: string;
      severity: "rot" | "gelb" | "gruen";
      title: string;
      description: string;
      count: number;
      link?: string;
    };
    const list: Item[] = [];

    const ph = [
      { key: "ph-without-employee", count: health.customersWithoutEmployee.current, title: "Kunden ohne zugeteilten Mitarbeiter", desc: "Aktive Kunden brauchen eine Hauptbetreuung.", link: "/admin/statistics/process-health/customers-without-employee" },
      { key: "ph-without-appointments", count: health.customersWithoutAppointments.current, title: "Aktive Kunden ohne Termine", desc: "Im gewählten Zeitraum sind keine Termine geplant.", link: "/admin/statistics/process-health/customers-without-appointments" },
      { key: "ph-undocumented", count: health.undocumentedAppointments.current, title: "Nicht dokumentierte Termine", desc: "Vormonat und älter — bitte schließen.", link: "/admin/statistics/process-health/undocumented-appointments" },
      { key: "ph-without-record", count: health.appointmentsWithoutRecord.current, title: "Termine ohne Leistungsnachweis", desc: "Termine sind dokumentiert, aber keinem Nachweis zugeordnet.", link: "/admin/statistics/process-health/appointments-without-record" },
      { key: "ph-without-invoice", count: health.recordsWithoutInvoice.current, title: "Leistungsnachweise ohne Rechnung", desc: "Abrechnung steht noch aus.", link: "/admin/statistics/process-health/records-without-invoice" },
    ];
    for (const e of ph) {
      if (e.count <= 0) continue;
      list.push({
        key: e.key,
        severity: e.count >= health.thresholds.red ? "rot" : e.count >= health.thresholds.yellow ? "gelb" : "gelb",
        title: e.title,
        description: e.desc,
        count: e.count,
        link: e.link,
      });
    }

    for (const a of alerts) {
      if (a.count <= 0) continue;
      // Skip alerts that overlap with process-health metrics (we already include those above).
      if (a.title.toLowerCase().includes("undokumentiert")) continue;
      if (a.title.toLowerCase().includes("kunden ohne termine")) continue;
      if (a.title.toLowerCase().includes("fehlende leistungsnachweise")) continue;
      list.push({
        key: `alert-${a.title}`,
        severity: a.severity,
        title: a.title,
        description: a.description,
        count: a.count,
        link: a.link,
      });
    }

    const order = { rot: 0, gelb: 1, gruen: 2 };
    list.sort((a, b) => (order[a.severity] - order[b.severity]) || (b.count - a.count));
    return list.slice(0, 7);
  }, [health, alerts]);

  if (items.length === 0) {
    return (
      <Card className="border-emerald-200 bg-emerald-50/50" data-testid="action-box-empty">
        <CardContent className="p-4 flex items-center gap-3">
          <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
          <span className="text-sm text-emerald-700 font-medium">Alles sauber — kein Handlungsbedarf heute.</span>
        </CardContent>
      </Card>
    );
  }

  const cfg = {
    rot: { border: "border-l-red-500", bg: "bg-red-50/40", icon: <AlertCircle className="w-4 h-4 text-red-600 shrink-0" />, badge: "bg-red-100 text-red-800" },
    gelb: { border: "border-l-amber-500", bg: "bg-amber-50/40", icon: <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />, badge: "bg-amber-100 text-amber-800" },
    gruen: { border: "border-l-emerald-500", bg: "bg-emerald-50/40", icon: <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />, badge: "bg-emerald-100 text-emerald-800" },
  };

  return (
    <Card data-testid="action-box">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-600" />
          Handlungsbedarf heute
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0 space-y-2">
        {items.map((it) => {
          const c = cfg[it.severity];
          return (
            <div
              key={it.key}
              className={`flex items-start gap-3 p-3 rounded-md border-l-4 ${c.border} ${c.bg}`}
              data-testid={`action-item-${it.key}`}
            >
              {c.icon}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                  <span className="font-medium text-sm">{it.title}</span>
                  <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${c.badge}`}>{it.count}</span>
                </div>
                <p className="text-xs text-muted-foreground">{it.description}</p>
              </div>
              {it.link && (
                <Link href={it.link} data-testid={`action-item-${it.key}-link`}>
                  <Button variant="ghost" size="sm" className="shrink-0 text-xs h-8">
                    Öffnen <ChevronRight className="w-3 h-3 ml-0.5" />
                  </Button>
                </Link>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
