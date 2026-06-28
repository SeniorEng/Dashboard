import { Loader2, GitBranch } from "lucide-react";
import { iconSize } from "@/design-system";
import type { BillingPipelineResponse } from "@shared/api";
import type { PipelineStage } from "@shared/domain/billing-pipeline";
import type { BillingTermineStage } from "@shared/api";
import { formatAmount } from "../utils";
import { MONTH_NAMES } from "../constants";
import { CollapsibleCard } from "./collapsible-card";

// Status-Filter der Termine-/Pipeline-Sicht (geteilt mit der Termine-Liste).
export type BillingStatusFilter = "alle" | BillingTermineStage;

export interface PipelineStageSelection {
  tab: "termine" | "rechnungen";
  status: BillingStatusFilter;
}

interface StatusPipelineCardProps {
  pipeline: BillingPipelineResponse | undefined;
  isLoading: boolean;
  selectedMonth: number;
  selectedYear: number;
  activeStatus: BillingStatusFilter;
  onStageSelect: (selection: PipelineStageSelection) => void;
}

// Frühe Stufen (vor Rechnung) → Termine-Tab; späte Stufen → Rechnungen-Tab.
const TERMINE_STAGES: PipelineStage[] = ["offen", "dokumentiert", "unterschrieben"];
const RECHNUNGEN_STAGES: PipelineStage[] = [
  "rechnung_erstellt",
  "versendet",
  "avis_erhalten",
  "bezahlt",
];

// Pipeline-Stufe → geteilter Status-Filter. „unterschrieben" heißt in der
// Termine-Liste „nachgewiesen" (Leistungsnachweis), sonst identisch.
function stageToStatus(stage: PipelineStage): BillingTermineStage {
  return stage === "unterschrieben" ? "nachgewiesen" : (stage as BillingTermineStage);
}

function selectionForStage(stage: PipelineStage): PipelineStageSelection {
  return {
    tab: TERMINE_STAGES.includes(stage) ? "termine" : "rechnungen",
    status: stageToStatus(stage),
  };
}

export function StatusPipelineCard({
  pipeline,
  isLoading,
  selectedMonth,
  selectedYear,
  activeStatus,
  onStageSelect,
}: StatusPipelineCardProps) {
  const stageByKey = new Map(
    (pipeline?.stages ?? []).map((s) => [s.stage, s] as const),
  );

  const renderStage = (stage: PipelineStage) => {
    const group = stageByKey.get(stage);
    if (!group) return null;
    const isActive = activeStatus === stageToStatus(stage);
    return (
      <button
        key={stage}
        type="button"
        onClick={() => onStageSelect(selectionForStage(stage))}
        className={`flex min-w-[8.5rem] flex-1 flex-col gap-0.5 rounded-md border px-3 py-2 text-left transition-colors ${
          isActive
            ? "border-teal-400 bg-teal-50"
            : "border-gray-200 bg-gray-50 hover:bg-gray-100"
        }`}
        data-testid={`pipeline-stage-${stage}`}
      >
        <div className="flex items-center justify-between gap-1">
          <span className="truncate text-xs text-gray-600">{group.label}</span>
          <span className="rounded-full bg-gray-200 px-1.5 text-xs font-medium text-gray-700">
            {group.caseCount}
          </span>
        </div>
        <div
          className={`text-sm font-medium tabular-nums ${group.totalCents < 0 ? "text-rose-700" : "text-gray-900"}`}
          data-testid={`pipeline-stage-sum-${stage}`}
        >
          {formatAmount(group.totalCents)}
        </div>
        {group.overdueCount > 0 && (
          <div className="text-xs text-rose-700" data-testid={`pipeline-stage-overdue-${stage}`}>
            {group.overdueCount} überfällig
          </div>
        )}
      </button>
    );
  };

  return (
    <CollapsibleCard
      storageKey="pipeline"
      testId="card-billing-pipeline"
      toggleTestId="button-toggle-pipeline"
      icon={<GitBranch className={`${iconSize.md} text-teal-600`} />}
      title={`Status-Pipeline — ${MONTH_NAMES[selectedMonth - 1]} ${selectedYear}`}
      headerRight={
        <div className="text-right">
          <div className="text-xs text-gray-500">Gesamt-Umsatz</div>
          <div
            className="text-lg font-semibold tabular-nums text-gray-900"
            data-testid="text-pipeline-grand-total"
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
            Pipeline wird geladen …
          </div>
        ) : pipeline ? (
          <div className="mt-3 space-y-3">
            <div>
              <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-400">
                Termine
              </div>
              <div className="flex flex-wrap gap-2">{TERMINE_STAGES.map(renderStage)}</div>
            </div>
            <div>
              <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-400">
                Rechnungen
              </div>
              <div className="flex flex-wrap gap-2">{RECHNUNGEN_STAGES.map(renderStage)}</div>
            </div>

            {pipeline.sides.some((side) => side.itemCount > 0) && (
              <div className="flex flex-wrap items-center gap-2 border-t border-gray-100 pt-3">
                {pipeline.sides
                  .filter((side) => side.itemCount > 0)
                  .map((side) => (
                    <span
                      key={side.state}
                      className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-white px-2.5 py-1 text-xs text-gray-700"
                      data-testid={`pipeline-side-${side.state}`}
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
          <div className="py-4 text-sm text-gray-500" data-testid="text-pipeline-empty">
            Keine Pipeline-Daten verfügbar.
          </div>
        )}
      </>
    </CollapsibleCard>
  );
}
