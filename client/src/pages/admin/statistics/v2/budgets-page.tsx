import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { KpiTile } from "@/components/charts";
import { PiggyBank, Wallet } from "lucide-react";
import { api, unwrapResult } from "@/lib/api/client";
import type { BudgetStatsResponse, BudgetPotRow } from "@shared/statistics";
import { cents, compareLabel, pickDelta, fmtCentsDelta } from "../helpers";
import { StatsPageShell, StatsLoading, StatsError, buildPeriodQs } from "./page-shell";
import { DrillDownTable } from "./drill-down-table";

type AggregateRow = BudgetStatsResponse["aggregateByStatus"][number];

const BUDGET_LABELS: Record<string, string> = {
  entlastungsbetrag_45b: "Entlastungsbetrag §45b",
  umwandlung_45a: "Umwandlung §45a",
  ersatzpflege_39_42a: "Ersatzpflege §39/§42a",
};

const STATUS_BADGE: Record<string, { label: string; className: string }> = {
  gruen: { label: "Im Plan", className: "bg-emerald-100 text-emerald-800" },
  gelb: { label: "Achtung", className: "bg-amber-100 text-amber-800" },
  rot: { label: "Über-/Unterausnutzung", className: "bg-red-100 text-red-800" },
};

export default function BudgetsPage() {
  return (
    <StatsPageShell
      title="Budget-Dashboard"
      description="Ausnutzung der Pflegekassenbudgets je Topf und Kunde."
      icon={<PiggyBank className="w-6 h-6" />}
      testId="budgets-dashboard"
    >
      {({ qs, year, month }) => <BudgetsContent qs={qs} year={year} month={month} />}
    </StatsPageShell>
  );
}

export function BudgetsSection({ selectedYear, selectedMonth }: { selectedYear: number; selectedMonth: string }) {
  return (
    <div data-testid="budgets-dashboard">
      <BudgetsContent qs={buildPeriodQs(selectedYear, selectedMonth)} year={selectedYear} month={selectedMonth} />
    </div>
  );
}

function BudgetsContent({ qs, year, month }: { qs: string; year: number; month: string }) {
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [potFilter, setPotFilter] = useState<string>("all");

  const query = useQuery<BudgetStatsResponse>({
    queryKey: ["statistics-v2-budgets", qs],
    queryFn: async () => unwrapResult(await api.get<BudgetStatsResponse>(`/statistics/v2/budgets?${qs}`)),
    staleTime: 60_000,
  });

  const filteredRows = useMemo(() => {
    const rows = query.data?.rows ?? [];
    return rows.filter((r) =>
      (statusFilter === "all" || r.status === statusFilter) &&
      (potFilter === "all" || r.budgetType === potFilter)
    );
  }, [query.data?.rows, statusFilter, potFilter]);

  if (query.isLoading) return <StatsLoading testId="budgets-loading" />;
  if (query.isError || !query.data) return <StatsError testId="budgets-error" />;

  const data = query.data;
  const usedPct = data.totalAllocatedCents.current > 0
    ? Math.round((data.totalUsedCents.current / data.totalAllocatedCents.current) * 100)
    : 0;
  const potOptions = Array.from(new Set(data.rows.map((r) => r.budgetType)));

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4" data-testid="budgets-kpis">
        <KpiTile
          title="Bewilligt gesamt"
          icon={<Wallet className="w-5 h-5" />}
          value={cents(data.totalAllocatedCents.current)}
          delta={pickDelta(month, data.totalAllocatedCents)}
          formatDeltaAbs={fmtCentsDelta}
          deltaLabel={compareLabel(month)}
          higherIsBetter
          testId="kpi-budget-allocated"
        />
        <KpiTile
          title="Genutzt gesamt"
          icon={<PiggyBank className="w-5 h-5" />}
          value={cents(data.totalUsedCents.current)}
          delta={pickDelta(month, data.totalUsedCents)}
          formatDeltaAbs={fmtCentsDelta}
          deltaLabel={compareLabel(month)}
          higherIsBetter
          testId="kpi-budget-used"
        />
        <KpiTile
          title="Ausnutzung"
          icon={<PiggyBank className="w-5 h-5" />}
          value={`${usedPct}%`}
          subValue={cents(data.totalAllocatedCents.current - data.totalUsedCents.current) + " offen"}
          higherIsBetter
          testId="kpi-budget-utilization"
        />
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Status je Budget-Topf</CardTitle>
        </CardHeader>
        <CardContent>
          <DrillDownTable<AggregateRow>
            rows={data.aggregateByStatus}
            columns={[
              { key: "type", label: "Budget-Topf", render: (r) => BUDGET_LABELS[r.budgetType] ?? r.budgetType },
              { key: "gruen", label: "Im Plan", render: (r) => r.gruen, align: "right", sortBy: (r) => r.gruen },
              { key: "gelb", label: "Achtung", render: (r) => r.gelb, align: "right", sortBy: (r) => r.gelb },
              { key: "rot", label: "Risiko", render: (r) => r.rot, align: "right", sortBy: (r) => r.rot },
            ]}
            getRowId={(r) => r.budgetType}
            testId="budgets-aggregate"
            csvFilename={`budget-status-${year}`}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Kunden-Budgets</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2" data-testid="budgets-filters">
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-[180px] h-9" data-testid="select-budget-status">
                <SelectValue placeholder="Ampelstatus" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Alle Status</SelectItem>
                <SelectItem value="gruen">Im Plan (grün)</SelectItem>
                <SelectItem value="gelb">Achtung (gelb)</SelectItem>
                <SelectItem value="rot">Risiko (rot)</SelectItem>
              </SelectContent>
            </Select>
            <Select value={potFilter} onValueChange={setPotFilter}>
              <SelectTrigger className="w-[240px] h-9" data-testid="select-budget-pot">
                <SelectValue placeholder="Budget-Topf" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Alle Töpfe</SelectItem>
                {potOptions.map((p) => (
                  <SelectItem key={p} value={p}>{BUDGET_LABELS[p] ?? p}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-xs text-muted-foreground" data-testid="budgets-filter-count">
              {filteredRows.length} von {data.rows.length}
            </span>
          </div>
          <DrillDownTable<BudgetPotRow>
            rows={filteredRows}
            columns={[
              { key: "customer", label: "Kunde", render: (r) => r.customerName },
              { key: "type", label: "Topf", render: (r) => BUDGET_LABELS[r.budgetType] ?? r.budgetType, hideOnMobile: true },
              { key: "yearly", label: "Jahresbudget", render: (r) => cents(r.yearlyBudgetCents), csvValue: (r) => r.yearlyBudgetCents, align: "right", sortBy: (r) => r.yearlyBudgetCents, hideOnMobile: true },
              { key: "used", label: "Genutzt", render: (r) => cents(r.usedCents), csvValue: (r) => r.usedCents, align: "right", sortBy: (r) => r.usedCents },
              { key: "expected", label: "Soll-Anteil", render: (r) => `${r.expectedProRataPct}%`, csvValue: (r) => r.expectedProRataPct, align: "right", sortBy: (r) => r.expectedProRataPct, hideOnMobile: true },
              { key: "forecast", label: "Prognose Jahr", render: (r) => `${cents(r.forecastYearEndCents)} (${r.forecastPct}%)`, csvValue: (r) => r.forecastYearEndCents, align: "right", sortBy: (r) => r.forecastPct },
              {
                key: "status",
                label: "Status",
                render: (r) => {
                  const b = STATUS_BADGE[r.status];
                  return b ? `[${b.label}]` : r.status;
                },
                csvValue: (r) => r.status,
                sortBy: (r) => ({ rot: 0, gelb: 1, gruen: 2 } as Record<string, number>)[r.status] ?? 9,
              },
            ]}
            getRowId={(r) => `${r.customerId}-${r.budgetType}`}
            getRowLink={(r) => `/admin/customers/${r.customerId}`}
            testId="budgets-rows"
            csvFilename={`budgets-detail-${year}`}
            emptyMessage="Keine Budget-Daten im gewählten Zeitraum."
          />
        </CardContent>
      </Card>
    </div>
  );
}
