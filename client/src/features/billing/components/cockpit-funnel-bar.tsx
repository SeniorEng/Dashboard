import { Card, CardContent } from "@/components/ui/card";
import type {
  CockpitStageSummary,
  CockpitFunnelStage,
  CockpitAmpel,
  LohnReadinessSummary,
} from "@shared/api";
import { formatAmount, formatHoursFromMinutes } from "../utils";

const AMPEL_STYLE: Record<CockpitAmpel, { dot: string; label: string }> = {
  gruen: { dot: "bg-green-500", label: "Alles im Plan" },
  gelb: { dot: "bg-amber-500", label: "Offene Prüfungen" },
  rot: { dot: "bg-red-500", label: "Rückstände" },
};

interface CockpitFunnelBarProps {
  funnel: CockpitStageSummary[];
  ampel: CockpitAmpel;
  lohnReadiness: LohnReadinessSummary;
  activeStage: CockpitFunnelStage | null;
  onStageClick: (stage: CockpitFunnelStage) => void;
}

// Task #1444 — Zone A: READ-ONLY Trichterleiste. Rendert die fertig berechneten
// Aggregate des Cockpit-Readers (counts + Σ Stunden/€ als Integer-Cents) —
// KEINE eigene Berechnung. Ein Klick auf eine Stufe filtert die Drill-down-
// Tabelle (Zone B).
export function CockpitFunnelBar({
  funnel,
  ampel,
  lohnReadiness,
  activeStage,
  onStageClick,
}: CockpitFunnelBarProps) {
  const ampelStyle = AMPEL_STYLE[ampel];
  return (
    <Card className="mb-6" data-testid="card-cockpit-funnel">
      <CardContent className="p-4">
        <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
          <div className="flex items-center gap-2" data-testid="status-cockpit-ampel">
            <span className={`inline-block h-3 w-3 rounded-full ${ampelStyle.dot}`} aria-hidden="true" />
            <span className="text-sm font-medium text-gray-900">{ampelStyle.label}</span>
          </div>
          <div className="text-sm text-gray-600" data-testid="text-lohn-readiness">
            Lohn:{" "}
            <span className="font-semibold text-gray-900" data-testid="text-lohn-lohnreif">
              {lohnReadiness.lohnreif} lohnreif
            </span>
            {", "}
            <span className="font-semibold text-gray-900" data-testid="text-lohn-in-pruefung">
              {lohnReadiness.inPruefung} in Prüfung
            </span>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          {funnel.map((stage) => {
            const isActive = activeStage === stage.stage;
            return (
              <button
                key={stage.stage}
                type="button"
                onClick={() => onStageClick(stage.stage)}
                aria-pressed={isActive}
                className={`flex flex-col items-start rounded-lg border p-3 text-left transition-colors ${
                  isActive
                    ? "border-teal-500 bg-teal-50"
                    : "border-gray-200 bg-white hover:bg-gray-50"
                }`}
                data-testid={`button-funnel-stage-${stage.stage}`}
              >
                <span className="text-xs font-medium text-gray-500">{stage.label}</span>
                <span
                  className="mt-1 text-2xl font-semibold tabular-nums text-gray-900"
                  data-testid={`text-funnel-count-${stage.stage}`}
                >
                  {stage.itemCount}
                </span>
                <span
                  className="mt-1 text-xs tabular-nums text-gray-600"
                  data-testid={`text-funnel-amount-${stage.stage}`}
                >
                  {formatAmount(stage.totalCents)}
                </span>
                <span
                  className="text-xs tabular-nums text-gray-500"
                  data-testid={`text-funnel-hours-${stage.stage}`}
                >
                  {formatHoursFromMinutes(stage.totalMinutes)}
                </span>
              </button>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
