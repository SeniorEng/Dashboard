import { useState } from "react";
import { Link, useRoute, useSearch } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ArrowLeft, AlertCircle, Loader2 } from "lucide-react";
import { iconSize, componentStyles } from "@/design-system";
import { api, unwrapResult } from "@/lib/api/client";
import { MONTH_NAMES } from "@/features/time-tracking/constants";
import type { ProcessHealthRow } from "@shared/statistics";
import { DrillDownTable, type DrillDownColumn } from "./drill-down-table";

interface MetricMeta {
  endpoint: string;
  title: string;
  description: string;
  /** Whether the period filter affects this drill-down. */
  periodAware: boolean;
  columns: DrillDownColumn<ProcessHealthRow>[];
  emptyMessage: string;
  csvFilename: string;
}

const NAME_COL: DrillDownColumn<ProcessHealthRow> = {
  key: "label",
  label: "Name",
  render: (r) => r.label,
};
const DATE_COL: DrillDownColumn<ProcessHealthRow> = {
  key: "date",
  label: "Datum",
  render: (r) => r.date ? formatDate(r.date) : null,
  sortBy: (r) => r.date ?? "",
  className: "whitespace-nowrap",
};
const EMPLOYEE_COL: DrillDownColumn<ProcessHealthRow> = {
  key: "employeeName",
  label: "Mitarbeiter",
  render: (r) => r.employeeName ?? null,
  hideOnMobile: true,
};
const PERIOD_COL: DrillDownColumn<ProcessHealthRow> = {
  key: "date",
  label: "Zeitraum",
  render: (r) => r.date ?? null,
  sortBy: (r) => r.date ?? "",
  className: "whitespace-nowrap",
};

function formatDate(d: string): string {
  // Accept "YYYY-MM-DD" or any string Date can parse.
  if (/^\d{4}-\d{2}-\d{2}/.test(d)) {
    const [y, m, day] = d.slice(0, 10).split("-");
    return `${day}.${m}.${y}`;
  }
  return d;
}

const METRICS: Record<string, MetricMeta> = {
  "customers-without-employee": {
    endpoint: "/statistics/v2/process-health/customers-without-employee",
    title: "Kunden ohne zugeteilten Mitarbeiter",
    description: "Aktive Kunden, die noch keinem Hauptbetreuer zugewiesen sind.",
    periodAware: false,
    columns: [NAME_COL],
    emptyMessage: "Alle aktiven Kunden haben einen zugeteilten Mitarbeiter.",
    csvFilename: "kunden-ohne-mitarbeiter",
  },
  "customers-without-appointments": {
    endpoint: "/statistics/v2/process-health/customers-without-appointments",
    title: "Aktive Kunden ohne Termine",
    description: "Aktive Kunden, die im gewählten Zeitraum keinen geplanten Termin haben.",
    periodAware: true,
    columns: [NAME_COL, EMPLOYEE_COL, PERIOD_COL],
    emptyMessage: "Alle aktiven Kunden haben mindestens einen Termin im Zeitraum.",
    csvFilename: "kunden-ohne-termine",
  },
  "undocumented-appointments": {
    endpoint: "/statistics/v2/process-health/undocumented-appointments",
    title: "Nicht dokumentierte Termine",
    description: "Termine aus dem Vormonat oder älter, die noch nicht abgeschlossen wurden.",
    periodAware: false,
    columns: [NAME_COL, DATE_COL, EMPLOYEE_COL],
    emptyMessage: "Keine offenen Termine aus dem Vormonat oder davor.",
    csvFilename: "nicht-dokumentierte-termine",
  },
  "appointments-without-record": {
    endpoint: "/statistics/v2/process-health/appointments-without-record",
    title: "Termine ohne Leistungsnachweis",
    description: "Dokumentierte Termine im gewählten Zeitraum ohne Zuordnung zu einem Nachweis.",
    periodAware: true,
    columns: [NAME_COL, DATE_COL, EMPLOYEE_COL],
    emptyMessage: "Alle dokumentierten Termine sind einem Leistungsnachweis zugeordnet.",
    csvFilename: "termine-ohne-leistungsnachweis",
  },
  "records-without-invoice": {
    endpoint: "/statistics/v2/process-health/records-without-invoice",
    title: "Leistungsnachweise ohne Rechnung",
    description: "Abgeschlossene Leistungsnachweise im Zeitraum, die noch nicht abgerechnet wurden.",
    periodAware: true,
    columns: [NAME_COL, EMPLOYEE_COL, PERIOD_COL],
    emptyMessage: "Alle abgeschlossenen Nachweise sind abgerechnet.",
    csvFilename: "leistungsnachweise-ohne-rechnung",
  },
};

function buildQs(year: number, month: string): string {
  const p = new URLSearchParams({ year: String(year) });
  if (month !== "all") p.set("month", month);
  return p.toString();
}

export default function ProcessHealthDetail() {
  const [match, params] = useRoute<{ metric: string }>("/admin/statistics/process-health/:metric");
  const search = useSearch();
  const sp = new URLSearchParams(search);
  const currentYear = new Date().getFullYear();
  const initialYear = parseInt(sp.get("year") || "") || currentYear;
  const initialMonth = sp.get("month") || "all";

  const [year, setYear] = useState(initialYear);
  const [month, setMonth] = useState(initialMonth);

  const metricKey = match ? params!.metric : "";
  const meta = METRICS[metricKey];

  const qs = meta?.periodAware ? `?${buildQs(year, month)}` : "";
  const query = useQuery<ProcessHealthRow[]>({
    queryKey: ["process-health-drill", metricKey, meta?.periodAware ? year : null, meta?.periodAware ? month : null],
    queryFn: async () => unwrapResult(await api.get<ProcessHealthRow[]>(`${meta.endpoint}${qs}`)),
    enabled: !!meta,
    staleTime: 30_000,
  });

  if (!meta) {
    return (
      <Layout variant="wide">
        <Card className="border-amber-200 bg-amber-50/50" data-testid="metric-not-found">
          <CardContent className="p-6">
            <h2 className="font-semibold mb-2">Unbekannte Kennzahl</h2>
            <p className="text-sm text-muted-foreground mb-4">Die angeforderte Drill-Down-Ansicht existiert nicht.</p>
            <Link href="/admin/statistics/process-health">
              <Button variant="outline" size="sm">Zurück zur Prozess-Gesundheit</Button>
            </Link>
          </CardContent>
        </Card>
      </Layout>
    );
  }

  const back = `/admin/statistics/process-health${meta.periodAware ? `?${buildQs(year, month)}` : ""}`;

  return (
    <Layout variant="wide">
      <div className="flex items-center gap-3 mb-6">
        <Link href={back} data-testid="link-back-process-health">
          <Button variant="ghost" size="sm">
            <ArrowLeft className={iconSize.md} />
          </Button>
        </Link>
        <div className="flex-1">
          <h1 className={componentStyles.pageTitle} data-testid="text-page-title">{meta.title}</h1>
          <p className="text-sm text-muted-foreground">{meta.description}</p>
        </div>
      </div>

      {meta.periodAware && (
        <div className="flex flex-wrap items-center gap-3 mb-4">
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
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Betroffene Datensätze</CardTitle>
        </CardHeader>
        <CardContent>
          {query.isLoading && (
            <div className="flex justify-center py-12" data-testid="drill-down-loading">
              <Loader2 className={`${iconSize.lg} animate-spin text-teal-600`} />
            </div>
          )}
          {query.isError && (
            <div className="flex items-center gap-2 p-4 rounded-md bg-red-50 border border-red-200 text-red-700" data-testid="drill-down-error">
              <AlertCircle className={iconSize.md} />
              <span className="text-sm">Daten konnten nicht geladen werden. Bitte erneut versuchen.</span>
            </div>
          )}
          {query.data && (
            <DrillDownTable<ProcessHealthRow>
              rows={query.data}
              columns={meta.columns}
              getRowId={(r) => r.id}
              getRowLink={(r) => r.link}
              emptyMessage={meta.emptyMessage}
              testId={`drill-${metricKey}`}
              csvFilename={meta.csvFilename}
            />
          )}
        </CardContent>
      </Card>
    </Layout>
  );
}
