import { useState } from "react";
import { Link, useSearch } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { KpiTile } from "@/components/charts";
import {
  ArrowLeft, Activity, AlertCircle, CheckCircle2, ChevronRight,
  UserX, CalendarOff, FileWarning, FileX, ReceiptText,
} from "lucide-react";
import { iconSize, componentStyles } from "@/design-system";
import { api, unwrapResult } from "@/lib/api/client";
import { MONTH_NAMES } from "@/features/time-tracking/constants";
import type { ProcessHealthSummary, SparklinePoint } from "@shared/statistics";

interface MetricConfig {
  key: string;
  title: string;
  description: string;
  icon: React.ReactNode;
  pickValue: (s: ProcessHealthSummary) => { current: number; deltaAbs: number | null; deltaPct: number | null };
  pickSparkline: (s: ProcessHealthSummary) => SparklinePoint[];
  detailPath: string;
  /** Pass period params to the drill-down (some are independent of period). */
  periodAware: boolean;
  sparklineColor: string;
}

const METRICS: MetricConfig[] = [
  {
    key: "customers-without-employee",
    title: "Kunden ohne zugeteilten Mitarbeiter",
    description: "Aktive Kunden, die noch keinen Hauptbetreuer haben.",
    icon: <UserX className="w-5 h-5" />,
    pickValue: (s) => ({ current: s.customersWithoutEmployee.current, deltaAbs: s.customersWithoutEmployee.deltaAbs, deltaPct: s.customersWithoutEmployee.deltaPct }),
    pickSparkline: (s) => s.sparklines.customersWithoutEmployee,
    detailPath: "/admin/statistics/process-health/customers-without-employee",
    periodAware: false,
    sparklineColor: "#dc2626",
  },
  {
    key: "customers-without-appointments",
    title: "Aktive Kunden ohne Termine",
    description: "Aktive Kunden ohne Termine im gewählten Zeitraum.",
    icon: <CalendarOff className="w-5 h-5" />,
    pickValue: (s) => ({ current: s.customersWithoutAppointments.current, deltaAbs: s.customersWithoutAppointments.deltaAbs, deltaPct: s.customersWithoutAppointments.deltaPct }),
    pickSparkline: (s) => s.sparklines.customersWithoutAppointments,
    detailPath: "/admin/statistics/process-health/customers-without-appointments",
    periodAware: true,
    sparklineColor: "#ea580c",
  },
  {
    key: "undocumented-appointments",
    title: "Nicht dokumentierte Termine",
    description: "Termine aus dem Vormonat oder älter ohne Dokumentation.",
    icon: <FileWarning className="w-5 h-5" />,
    pickValue: (s) => ({ current: s.undocumentedAppointments.current, deltaAbs: s.undocumentedAppointments.deltaAbs, deltaPct: s.undocumentedAppointments.deltaPct }),
    pickSparkline: (s) => s.sparklines.undocumentedAppointments,
    detailPath: "/admin/statistics/process-health/undocumented-appointments",
    periodAware: false,
    sparklineColor: "#d97706",
  },
  {
    key: "appointments-without-record",
    title: "Termine ohne Leistungsnachweis",
    description: "Dokumentierte Termine ohne Zuordnung zu einem Nachweis.",
    icon: <FileX className="w-5 h-5" />,
    pickValue: (s) => ({ current: s.appointmentsWithoutRecord.current, deltaAbs: s.appointmentsWithoutRecord.deltaAbs, deltaPct: s.appointmentsWithoutRecord.deltaPct }),
    pickSparkline: (s) => s.sparklines.appointmentsWithoutRecord,
    detailPath: "/admin/statistics/process-health/appointments-without-record",
    periodAware: true,
    sparklineColor: "#7c3aed",
  },
  {
    key: "records-without-invoice",
    title: "Leistungsnachweise ohne Rechnung",
    description: "Abgeschlossene Leistungsnachweise, die noch nicht abgerechnet wurden.",
    icon: <ReceiptText className="w-5 h-5" />,
    pickValue: (s) => ({ current: s.recordsWithoutInvoice.current, deltaAbs: s.recordsWithoutInvoice.deltaAbs, deltaPct: s.recordsWithoutInvoice.deltaPct }),
    pickSparkline: (s) => s.sparklines.recordsWithoutInvoice,
    detailPath: "/admin/statistics/process-health/records-without-invoice",
    periodAware: true,
    sparklineColor: "#0d9488",
  },
];

function buildQs(year: number, month: string): string {
  const p = new URLSearchParams({ year: String(year) });
  if (month !== "all") p.set("month", month);
  return p.toString();
}

interface ProcessHealthSectionProps {
  selectedYear: number;
  selectedMonth: string;
}

/**
 * Inner content of the Prozess-Gesundheit view (cards + empty state).
 * Reused by the standalone page and by the statistics tab.
 */
export function ProcessHealthSection({ selectedYear, selectedMonth }: ProcessHealthSectionProps) {
  const qs = buildQs(selectedYear, selectedMonth);
  const summary = useQuery<ProcessHealthSummary>({
    queryKey: ["statistics-v2-process-health", selectedYear, selectedMonth],
    queryFn: async () => unwrapResult(await api.get<ProcessHealthSummary>(`/statistics/v2/process-health?${qs}`)),
    staleTime: 60_000,
  });

  if (summary.isLoading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4" data-testid="process-health-loading">
        {Array.from({ length: 5 }).map((_, i) => (
          <Card key={i} className="animate-pulse h-44">
            <CardContent className="p-5 space-y-3">
              <div className="h-4 bg-muted rounded w-1/2" />
              <div className="h-8 bg-muted rounded w-1/3" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  if (summary.isError || !summary.data) {
    return (
      <Card className="border-red-200 bg-red-50/50" data-testid="process-health-error">
        <CardContent className="p-4 flex items-center gap-3 text-red-700">
          <AlertCircle className={iconSize.md} />
          <span>Daten konnten nicht geladen werden. Bitte erneut versuchen.</span>
        </CardContent>
      </Card>
    );
  }

  const data = summary.data;

  return (
    <>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-6" data-testid="process-health-cards">
        {METRICS.map((m) => {
          const v = m.pickValue(data);
          const detailHref = m.periodAware ? `${m.detailPath}?${qs}` : m.detailPath;
          const isClean = v.current === 0;
          const sparkValues = m.pickSparkline(data).map((p) => p.value);
          return (
            <KpiTile
              key={m.key}
              title={m.title}
              icon={m.icon}
              value={String(v.current)}
              delta={{ abs: v.deltaAbs, pct: v.deltaPct }}
              deltaLabel="vs. Vormonat"
              higherIsBetter={false}
              sparkline={sparkValues}
              sparklineColor={m.sparklineColor}
              testId={`ph-card-${m.key}`}
              badge={isClean ? { label: "Sauber", className: "bg-emerald-100 text-emerald-800" } : { label: "Offen", className: "bg-amber-100 text-amber-800" }}
              footer={
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground flex-1 min-w-0">{m.description}</span>
                  <Link href={detailHref} data-testid={`ph-card-${m.key}-open`}>
                    <Button variant="outline" size="sm" className="h-8 text-xs shrink-0">
                      Öffnen <ChevronRight className="w-3 h-3 ml-0.5" />
                    </Button>
                  </Link>
                </div>
              }
            />
          );
        })}
      </div>

      {data.total.current === 0 && (
        <Card className="border-emerald-200 bg-emerald-50/50" data-testid="process-health-all-clear">
          <CardContent className="p-4 flex items-center gap-3">
            <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
            <span className="text-sm text-emerald-700 font-medium">
              Alles sauber — keine offenen Punkte in der Prozess-Gesundheit.
            </span>
          </CardContent>
        </Card>
      )}
    </>
  );
}

export default function ProcessHealthPage() {
  const currentYear = new Date().getFullYear();
  const search = useSearch();
  const params = new URLSearchParams(search);
  const initialYear = parseInt(params.get("year") || "") || currentYear;
  const initialMonth = params.get("month") || "all";

  const [year, setYear] = useState(initialYear);
  const [month, setMonth] = useState(initialMonth);

  const back = `/admin/statistics?tab=cockpit-v2`;

  return (
    <Layout variant="wide">
      <div className="flex items-center gap-3 mb-6">
        <Link href={back} data-testid="link-back-statistics">
          <Button variant="ghost" size="sm">
            <ArrowLeft className={iconSize.md} />
          </Button>
        </Link>
        <div className="flex-1">
          <h1 className={`${componentStyles.pageTitle} flex items-center gap-2`} data-testid="text-page-title">
            <Activity className={iconSize.lg} />
            Prozess-Gesundheit
          </h1>
          <p className="text-sm text-muted-foreground">
            Fünf Kennzahlen, die zeigen, wo der Betrieb gerade hakt.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-6">
        <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
          <SelectTrigger className="w-[100px]" data-testid="select-year">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[currentYear - 1, currentYear, currentYear + 1].map((y) => (
              <SelectItem key={y} value={String(y)}>{y}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={month} onValueChange={setMonth}>
          <SelectTrigger className="w-[140px]" data-testid="select-month">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Gesamtjahr</SelectItem>
            {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
              <SelectItem key={m} value={String(m)}>{MONTH_NAMES[m - 1]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <ProcessHealthSection selectedYear={year} selectedMonth={month} />
    </Layout>
  );
}
