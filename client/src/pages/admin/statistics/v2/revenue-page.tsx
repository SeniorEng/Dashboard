import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { KpiTile } from "@/components/charts";
import { Euro, TrendingUp, Calendar, Receipt, FileCheck, Truck, AlertCircle, CalendarCheck } from "lucide-react";
import { api, unwrapResult } from "@/lib/api/client";
import { MONTH_NAMES } from "@/features/time-tracking/constants";
import type { RevenueStatsResponse, RevenueByDimensionRow, RevenueGapRow } from "@shared/statistics";
import { cents, hours } from "../helpers";
import { StatsPageShell, StatsLoading, StatsError, buildPeriodQs } from "./page-shell";
import { DrillDownTable } from "./drill-down-table";

type GapKind = "documented-without-proven" | "proven-without-invoiced";
const GAP_LABELS: Record<GapKind, { title: string; description: string; csv: string }> = {
  "documented-without-proven": {
    title: "Dokumentiert ohne Leistungsnachweis",
    description: "Termine mit Status dokumentiert/abgeschlossen, die noch keinem abgeschlossenen Leistungsnachweis zugeordnet sind.",
    csv: "luecke-dokumentiert-ohne-nachweis",
  },
  "proven-without-invoiced": {
    title: "Nachgewiesen ohne Rechnung",
    description: "Termine in einem abgeschlossenen Leistungsnachweis, die im gewählten Zeitraum noch nicht in einer Rechnung berechnet wurden.",
    csv: "luecke-nachgewiesen-ohne-rechnung",
  },
};

type ServiceTypeRow = RevenueStatsResponse["byServiceType"][number];
type TimeRow = RevenueStatsResponse["timeToDocumentDays"][number];
type TravelRow = RevenueStatsResponse["travelCostRatioByEmployee"][number];

const SERVICE_LABELS: Record<string, string> = {
  hauswirtschaft: "Hauswirtschaft",
  alltagsbegleitung: "Alltagsbegleitung",
  erstberatung: "Erstberatung",
  sonstige: "Sonstige",
};

export default function RevenuePage() {
  return (
    <StatsPageShell
      title="Umsatz-Dashboard"
      description="Stufen, Service-Mix, Top-Kunden, Lücken und Geschwindigkeit der Abrechnung."
      icon={<Euro className="w-6 h-6" />}
      testId="revenue-dashboard"
    >
      {({ qs, year }) => <RevenueContent qs={qs} year={year} />}
    </StatsPageShell>
  );
}

export function RevenueSection({ selectedYear, selectedMonth }: { selectedYear: number; selectedMonth: string }) {
  return (
    <div data-testid="revenue-dashboard">
      <RevenueContent qs={buildPeriodQs(selectedYear, selectedMonth)} year={selectedYear} />
    </div>
  );
}

function RevenueContent({ qs, year }: { qs: string; year: number }) {
  const [openGap, setOpenGap] = useState<GapKind | null>(null);
  const query = useQuery<RevenueStatsResponse>({
    queryKey: ["statistics-v2-revenue", qs],
    queryFn: async () => unwrapResult(await api.get<RevenueStatsResponse>(`/statistics/v2/revenue?${qs}`)),
    staleTime: 60_000,
  });

  if (query.isLoading) return <StatsLoading testId="revenue-loading" />;
  if (query.isError || !query.data) return <StatsError testId="revenue-error" />;

  const data = query.data;
  const stages = [
    { key: "planned", label: "Geplant", icon: <Calendar className="w-5 h-5" />, kpi: data.byStage.planned, color: "#0ea5e9" },
    { key: "documented", label: "Dokumentiert", icon: <FileCheck className="w-5 h-5" />, kpi: data.byStage.documented, color: "#0d9488" },
    { key: "proven", label: "Nachgewiesen", icon: <FileCheck className="w-5 h-5" />, kpi: data.byStage.proven, color: "#7c3aed" },
    { key: "invoiced", label: "Berechnet", icon: <Receipt className="w-5 h-5" />, kpi: data.byStage.invoiced, color: "#16a34a" },
  ] as const;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4" data-testid="revenue-stages">
        {stages.map((s) => (
          <KpiTile
            key={s.key}
            title={s.label}
            icon={s.icon}
            value={cents(s.kpi.current)}
            delta={{ abs: s.kpi.deltaAbs, pct: s.kpi.deltaPct }}
            deltaLabel="vs. Vormonat"
            higherIsBetter
            sparklineColor={s.color}
            testId={`kpi-stage-${s.key}`}
          />
        ))}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <KpiTile
          title="Monatsprognose"
          icon={<TrendingUp className="w-5 h-5" />}
          value={cents(data.monthForecastCents)}
          subValue="hochgerechnet auf den Monat"
          higherIsBetter
          testId="kpi-month-forecast"
        />
        <KpiTile
          title="Reisekosten-Anteil"
          icon={<Truck className="w-5 h-5" />}
          value={`${data.travelCostRatioPct}%`}
          subValue="vom Umsatz"
          higherIsBetter={false}
          testId="kpi-travel-ratio"
        />
        <Card data-testid="revenue-gaps">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2 text-amber-700">
              <AlertCircle className="w-4 h-4" />
              Lücken
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs space-y-1.5">
            <button
              type="button"
              onClick={() => setOpenGap("documented-without-proven")}
              disabled={data.gaps.documentedMinusProvenCount === 0}
              className="w-full flex items-center justify-between rounded-md px-2 py-1 -mx-2 hover:bg-amber-50 disabled:opacity-60 disabled:cursor-not-allowed text-left"
              data-testid="gap-doc-vs-proven"
            >
              <span className="text-muted-foreground">Dokumentiert ohne Nachweis</span>
              <span className="font-semibold tabular-nums">
                {cents(data.gaps.documentedMinusProvenCents)}{" "}
                <span className="text-amber-700 underline-offset-2 hover:underline">
                  ({data.gaps.documentedMinusProvenCount})
                </span>
              </span>
            </button>
            <button
              type="button"
              onClick={() => setOpenGap("proven-without-invoiced")}
              disabled={data.gaps.provenMinusInvoicedCount === 0}
              className="w-full flex items-center justify-between rounded-md px-2 py-1 -mx-2 hover:bg-amber-50 disabled:opacity-60 disabled:cursor-not-allowed text-left"
              data-testid="gap-proven-vs-invoiced"
            >
              <span className="text-muted-foreground">Nachgewiesen ohne Rechnung</span>
              <span className="font-semibold tabular-nums">
                {cents(data.gaps.provenMinusInvoicedCents)}{" "}
                <span className="text-amber-700 underline-offset-2 hover:underline">
                  ({data.gaps.provenMinusInvoicedCount})
                </span>
              </span>
            </button>
          </CardContent>
        </Card>
      </div>

      <RevenueGapDialog kind={openGap} qs={qs} year={year} onClose={() => setOpenGap(null)} />

      <Card data-testid="revenue-planned">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <CalendarCheck className="w-4 h-4 text-blue-600" />
            Geplante Erlöse &amp; Kosten (im gewählten Zeitraum)
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-4 text-sm">
            <div>
              <div className="text-muted-foreground">Geplante Erlöse</div>
              <div className="font-semibold text-emerald-700" data-testid="planned-revenue">{cents(data.planned.revenueCents)}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Geplante Kosten</div>
              <div className="font-semibold text-red-600" data-testid="planned-cost">{cents(data.planned.costCents)}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Deckungsbeitrag</div>
              <div className={`font-semibold ${data.planned.marginCents >= 0 ? "text-emerald-700" : "text-red-600"}`} data-testid="planned-margin">
                {cents(data.planned.marginCents)}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground">DB-Marge</div>
              <div className={`font-semibold ${data.planned.marginPercent >= 30 ? "text-emerald-700" : data.planned.marginPercent >= 0 ? "text-amber-600" : "text-red-600"}`} data-testid="planned-margin-pct">
                {data.planned.marginPercent}%
              </div>
            </div>
            <div>
              <div className="text-muted-foreground">Stunden</div>
              <div className="font-semibold" data-testid="planned-hours">{hours(data.planned.totalMinutes)}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Termine</div>
              <div className="font-semibold" data-testid="planned-appointments">{data.planned.appointments}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Kunden</div>
              <div className="font-semibold" data-testid="planned-customers">{data.planned.customers}</div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Umsatz nach Leistungsart</CardTitle>
        </CardHeader>
        <CardContent>
          <DrillDownTable<ServiceTypeRow>
            rows={data.byServiceType}
            columns={[
              { key: "type", label: "Leistungsart", render: (r) => SERVICE_LABELS[r.serviceType] ?? r.serviceType },
              { key: "planned", label: "Geplant", render: (r) => cents(r.planned), csvValue: (r) => r.planned, align: "right", sortBy: (r) => r.planned },
              { key: "documented", label: "Dokumentiert", render: (r) => cents(r.documented), csvValue: (r) => r.documented, align: "right", sortBy: (r) => r.documented },
              { key: "proven", label: "Nachgewiesen", render: (r) => cents(r.proven), csvValue: (r) => r.proven, align: "right", sortBy: (r) => r.proven, hideOnMobile: true },
              { key: "invoiced", label: "Berechnet", render: (r) => cents(r.invoiced), csvValue: (r) => r.invoiced, align: "right", sortBy: (r) => r.invoiced },
            ]}
            getRowId={(r) => r.serviceType}
            testId="revenue-by-service"
            csvFilename={`umsatz-leistungsart-${year}`}
          />
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Umsatz nach Mitarbeiter</CardTitle>
          </CardHeader>
          <CardContent>
            <DrillDownTable<RevenueByDimensionRow>
              rows={data.byEmployee}
              columns={dimColumns()}
              getRowId={(r) => r.id}
              testId="revenue-by-employee"
              csvFilename={`umsatz-mitarbeiter-${year}`}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Umsatz nach Kunde</CardTitle>
          </CardHeader>
          <CardContent>
            <DrillDownTable<RevenueByDimensionRow>
              rows={data.byCustomer}
              columns={dimColumns()}
              getRowId={(r) => r.id}
              getRowLink={(r) => `/admin/customers/${r.id}`}
              testId="revenue-by-customer"
              csvFilename={`umsatz-kunde-${year}`}
            />
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Tage bis Dokumentation</CardTitle>
          </CardHeader>
          <CardContent>
            <DrillDownTable<TimeRow>
              rows={data.timeToDocumentDays}
              columns={[
                { key: "month", label: "Monat", render: (r) => MONTH_NAMES[r.month - 1] ?? `M${r.month}`, sortBy: (r) => r.month },
                { key: "days", label: "Ø Tage", render: (r) => `${r.avgDays} d`, csvValue: (r) => r.avgDays, align: "right", sortBy: (r) => r.avgDays },
                { key: "median", label: "Median", render: (r) => `${r.medianDays} d`, csvValue: (r) => r.medianDays, align: "right", sortBy: (r) => r.medianDays },
                { key: "p90", label: "P90", render: (r) => `${r.p90Days} d`, csvValue: (r) => r.p90Days, align: "right", sortBy: (r) => r.p90Days, hideOnMobile: true },
              ]}
              getRowId={(r) => r.month}
              testId="revenue-time-to-document"
              csvFilename={`zeit-bis-dokumentation-${year}`}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Tage bis Rechnung</CardTitle>
          </CardHeader>
          <CardContent>
            <DrillDownTable<TimeRow>
              rows={data.timeToInvoiceDays}
              columns={[
                { key: "month", label: "Monat", render: (r) => MONTH_NAMES[r.month - 1] ?? `M${r.month}`, sortBy: (r) => r.month },
                { key: "days", label: "Ø Tage", render: (r) => `${r.avgDays} d`, csvValue: (r) => r.avgDays, align: "right", sortBy: (r) => r.avgDays },
                { key: "median", label: "Median", render: (r) => `${r.medianDays} d`, csvValue: (r) => r.medianDays, align: "right", sortBy: (r) => r.medianDays },
                { key: "p90", label: "P90", render: (r) => `${r.p90Days} d`, csvValue: (r) => r.p90Days, align: "right", sortBy: (r) => r.p90Days, hideOnMobile: true },
              ]}
              getRowId={(r) => r.month}
              testId="revenue-time-to-invoice"
              csvFilename={`zeit-bis-rechnung-${year}`}
            />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Truck className="w-4 h-4" />
            Reisekosten-Anteil je Mitarbeiter
          </CardTitle>
        </CardHeader>
        <CardContent>
          <DrillDownTable<TravelRow>
            rows={data.travelCostRatioByEmployee}
            columns={[
              { key: "name", label: "Mitarbeiter", render: (r) => r.employeeName },
              { key: "ratio", label: "Anteil", render: (r) => `${r.ratioPct}%`, csvValue: (r) => r.ratioPct, align: "right", sortBy: (r) => r.ratioPct },
            ]}
            getRowId={(r) => r.employeeId}
            testId="revenue-travel-by-employee"
            csvFilename={`reisekosten-anteil-${year}`}
          />
        </CardContent>
      </Card>
    </div>
  );
}

function RevenueGapDialog({
  kind, qs, year, onClose,
}: { kind: GapKind | null; qs: string; year: number; onClose: () => void }) {
  const meta = kind ? GAP_LABELS[kind] : null;
  const query = useQuery<RevenueGapRow[]>({
    queryKey: ["statistics-v2-revenue-gap", kind, qs],
    queryFn: async () =>
      unwrapResult(await api.get<RevenueGapRow[]>(`/statistics/v2/revenue/gaps/${kind}?${qs}`)),
    enabled: kind !== null,
    staleTime: 60_000,
  });

  return (
    <Dialog open={kind !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-4xl" data-testid={`revenue-gap-dialog-${kind ?? "none"}`}>
        <DialogHeader>
          <DialogTitle>{meta?.title}</DialogTitle>
          <DialogDescription>{meta?.description}</DialogDescription>
        </DialogHeader>
        {query.isLoading ? (
          <StatsLoading testId="revenue-gap-loading" />
        ) : query.isError ? (
          <StatsError testId="revenue-gap-error" />
        ) : (
          <DrillDownTable<RevenueGapRow>
            rows={query.data ?? []}
            columns={[
              { key: "date", label: "Datum", render: (r) => r.date, sortBy: (r) => r.date },
              { key: "customer", label: "Kunde", render: (r) => r.customerName },
              { key: "employee", label: "Mitarbeiter", render: (r) => r.employeeName ?? "—", hideOnMobile: true },
              { key: "service", label: "Leistung", render: (r) => r.serviceType, hideOnMobile: true },
              { key: "revenue", label: "Umsatz", render: (r) => cents(r.revenueCents), csvValue: (r) => r.revenueCents, align: "right", sortBy: (r) => r.revenueCents },
            ]}
            getRowId={(r) => r.appointmentId}
            getRowLink={(r) => `/admin/calendar?appointment=${r.appointmentId}`}
            testId={`revenue-gap-table-${kind ?? "none"}`}
            csvFilename={meta ? `${meta.csv}-${year}` : undefined}
            emptyMessage="Keine Lücken im gewählten Zeitraum."
          />
        )}
        <div className="flex justify-end pt-2">
          <Button variant="outline" size="sm" onClick={onClose} data-testid="revenue-gap-close">
            Schließen
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function dimColumns() {
  const cols: import("./drill-down-table").DrillDownColumn<RevenueByDimensionRow>[] = [
    { key: "name", label: "Name", render: (r) => r.name },
    { key: "documented", label: "Dokumentiert", render: (r) => cents(r.documented), csvValue: (r) => r.documented, align: "right", sortBy: (r) => r.documented },
    { key: "proven", label: "Nachgewiesen", render: (r) => cents(r.proven), csvValue: (r) => r.proven, align: "right", sortBy: (r) => r.proven, hideOnMobile: true },
    { key: "invoiced", label: "Berechnet", render: (r) => cents(r.invoiced), csvValue: (r) => r.invoiced, align: "right", sortBy: (r) => r.invoiced },
  ];
  return cols;
}
