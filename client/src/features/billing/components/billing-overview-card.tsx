import { Loader2, TrendingUp } from "lucide-react";
import { iconSize } from "@/design-system";
import type { BillingPipelineResponse } from "@shared/api";
import { formatAmount } from "../utils";
import { MONTH_NAMES } from "../constants";
import { CollapsibleCard } from "./collapsible-card";

interface BillingOverviewCardProps {
  pipeline: BillingPipelineResponse | undefined;
  isLoading: boolean;
  selectedMonth: number;
  selectedYear: number;
}

// Task #1434: EINE wirtschaftliche Überblick-Kachel ganz oben auf der
// Abrechnungsseite. Sie liest ausschließlich den bestehenden Pipeline-Reader
// (`GET /billing/pipeline`) und rendert dessen bereits berechnete Aggregate —
// KEINE eigene Geld-Mathematik (Beträge kommen fertig als Integer-Cents).
export function BillingOverviewCard({
  pipeline,
  isLoading,
  selectedMonth,
  selectedYear,
}: BillingOverviewCardProps) {
  return (
    <CollapsibleCard
      storageKey="overview"
      testId="card-billing-overview"
      toggleTestId="button-toggle-overview"
      icon={<TrendingUp className={`${iconSize.md} text-teal-600`} />}
      title={`Wirtschaftlicher Überblick — ${MONTH_NAMES[selectedMonth - 1]} ${selectedYear}`}
      headerRight={
        <div className="text-right">
          <div className="text-xs text-gray-500">Gesamt-Umsatz (Pipeline + Sonderfälle)</div>
          <div
            className="text-lg font-semibold tabular-nums text-gray-900"
            data-testid="text-overview-grand-total"
          >
            {isLoading || !pipeline ? "—" : formatAmount(pipeline.totals.grandTotalCents)}
          </div>
        </div>
      }
    >
      <>
        {isLoading ? (
          <div className="flex items-center gap-2 py-4 text-sm text-gray-500">
            <Loader2 className={`${iconSize.sm} animate-spin text-teal-600`} />
            Überblick wird geladen …
          </div>
        ) : pipeline ? (
          <div className="mt-3 space-y-3">
            {/* Stufen-Summen (Umsatz in der Pipeline) */}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
              {pipeline.stages.map((stage) => (
                <div
                  key={stage.stage}
                  className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2"
                  data-testid={`overview-stage-${stage.stage}`}
                >
                  <div className="flex items-center justify-between gap-1">
                    <span className="text-xs text-gray-600 truncate">{stage.label}</span>
                    <span className="rounded-full bg-gray-200 px-1.5 text-xs font-medium text-gray-700">
                      {stage.caseCount}
                    </span>
                  </div>
                  <div
                    className={`text-sm font-medium tabular-nums ${stage.totalCents < 0 ? "text-red-600" : "text-gray-900"}`}
                    data-testid={`overview-stage-sum-${stage.stage}`}
                  >
                    {formatAmount(stage.totalCents)}
                  </div>
                  {stage.overdueCount > 0 && (
                    <div
                      className="text-xs text-red-700"
                      data-testid={`overview-stage-overdue-${stage.stage}`}
                    >
                      {stage.overdueCount} überfällig
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* Side-Badges (nicht Teil der Stufen-Summe: Storno / nicht angetroffen / nicht abgerechnet) */}
            {pipeline.sides.some((side) => side.itemCount > 0) && (
              <div className="flex flex-wrap items-center gap-2">
                {pipeline.sides
                  .filter((side) => side.itemCount > 0)
                  .map((side) => (
                    <span
                      key={side.state}
                      className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-white px-2.5 py-1 text-xs text-gray-700"
                      data-testid={`overview-side-${side.state}`}
                    >
                      <span className="text-gray-500">{side.label}:</span>
                      <span className="font-medium tabular-nums">{formatAmount(side.totalCents)}</span>
                      <span className="text-gray-400">({side.itemCount})</span>
                    </span>
                  ))}
              </div>
            )}
          </div>
        ) : (
          <div className="py-4 text-sm text-gray-500" data-testid="text-overview-empty">
            Kein wirtschaftlicher Überblick verfügbar.
          </div>
        )}
      </>
    </CollapsibleCard>
  );
}
