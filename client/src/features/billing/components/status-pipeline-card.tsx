import { Loader2, GitBranch } from "lucide-react";
import { iconSize } from "@/design-system";
import type { BillingPipelineResponse } from "@shared/api";
import type { PipelineStage } from "@shared/domain/billing-pipeline";
import { PIPELINE_CASCADE_ORDER } from "@shared/domain/billing-pipeline";
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
// `avis_erhalten` ist als Stufe entfallen: der Avis ist eine
// Zuordnungs-Mechanik, kein Zustand. Bis zur Zahlung steht `versendet`.
const RECHNUNGEN_STAGES: PipelineStage[] = [
  "rechnung_erstellt",
  "versendet",
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

  /**
   * „19 Rechnungen" vs. „61 Termine" — die Kaskade mischt beide Seiten der
   * Hybrid-Kante, und ohne die Einheit läse sich eine Zahl wie die andere.
   */
  const einheitFuer = (stage: PipelineStage, n: number): string => {
    const istRechnung = RECHNUNGEN_STAGES.includes(stage);
    if (istRechnung) return n === 1 ? "Rechnung" : "Rechnungen";
    return n === 1 ? "Termin" : "Termine";
  };

  /**
   * „Leistungsnachweis fehlt" gehört in die Kaskade, nicht zu den Verlusten.
   *
   * Der Zustand zählt über `EXPECTED_REVENUE_SIDE_STATES` bereits zum
   * erwarteten Umsatz — er steckt also in der Schlagzeile. Ließe man ihn
   * unten bei den Badges, summierten sich die sichtbaren Stufen NICHT auf die
   * Schlagzeile, und der Selbsttest oben wäre eine Lüge.
   *
   * Er steht als eigene Zeile und nicht in „Nachweis zu erstellen", weil er
   * eine ANDERE Handlung auslöst: dort muss ein Nachweis entstehen, hier fehlt
   * nur noch die Kundenunterschrift auf einem vorhandenen.
   */
  const renderWartetAufUnterschrift = () => {
    const side = (pipeline?.sides ?? []).find(
      (x) => x.state === "wartet_auf_kundenunterschrift",
    );
    if (!side || side.itemCount === 0) return null;
    return (
      <div
        className="flex items-baseline gap-3 rounded-md border border-transparent bg-gray-50 px-3 py-1.5"
        data-testid="pipeline-stage-wartet_auf_kundenunterschrift"
      >
        <span className="w-44 shrink-0 truncate text-xs text-gray-600">{side.label}</span>
        <span className="w-28 shrink-0 text-right text-sm font-medium tabular-nums text-gray-900">
          {formatAmount(side.totalCents)}
        </span>
        <span className="text-xs text-gray-400">
          {side.itemCount} {side.itemCount === 1 ? "Termin" : "Termine"}
        </span>
      </div>
    );
  };

  /**
   * Die drei Verlust-Arten in einer Liste — Beträge aus zwei verschiedenen
   * Quellen, weil `cancelled` kein Side-Zustand ist, sondern `excluded`.
   */
  const verlustZeilen: Array<{
    key: string;
    label: string;
    cents: number;
    count: number | null;
    lohnHinweis: string;
  }> = [];
  if (pipeline) {
    if (pipeline.totals.cancelledCents > 0) {
      verlustZeilen.push({
        key: "abgesagt",
        label: "abgesagt",
        cents: pipeline.totals.cancelledCents,
        // `excluded`-Einheiten tragen keine Fall-Zählung durch den Vertrag;
        // die Zahl hier zu erfinden wäre schlimmer als sie wegzulassen.
        count: null,
        lohnHinweis: "kein Lohn",
      });
    }
    for (const side of pipeline.sides) {
      if (side.itemCount === 0) continue;
      if (side.state === "kunde_nicht_angetroffen") {
        verlustZeilen.push({
          key: side.state,
          label: side.label,
          cents: side.totalCents,
          count: side.itemCount,
          lohnHinweis: "Lohn fällt an",
        });
      } else if (side.state === "nicht_abgerechnet") {
        verlustZeilen.push({
          key: side.state,
          label: side.label,
          cents: side.totalCents,
          count: side.itemCount,
          lohnHinweis: "Lohn fällt an",
        });
      }
    }
  }

  const renderStage = (stage: PipelineStage) => {
    const group = stageByKey.get(stage);
    if (!group) return null;
    const isActive = activeStatus === stageToStatus(stage);
    return (
      <button
        key={stage}
        type="button"
        onClick={() => onStageSelect(selectionForStage(stage))}
        className={`flex items-baseline gap-3 rounded-md border px-3 py-1.5 text-left transition-colors ${
          isActive
            ? "border-teal-400 bg-teal-50"
            : "border-transparent bg-gray-50 hover:bg-gray-100"
        }`}
        data-testid={`pipeline-stage-${stage}`}
      >
        <span className="w-44 shrink-0 truncate text-xs text-gray-600">{group.label}</span>
        <span
          className={`w-28 shrink-0 text-right text-sm font-medium tabular-nums ${
            group.totalCents < 0 ? "text-rose-700" : "text-gray-900"
          }`}
          data-testid={`pipeline-stage-sum-${stage}`}
        >
          {formatAmount(group.totalCents)}
        </span>
        <span className="text-xs text-gray-400">
          {group.caseCount} {einheitFuer(stage, group.caseCount)}
        </span>
        {group.overdueCount > 0 && (
          <span className="text-xs text-rose-700" data-testid={`pipeline-stage-overdue-${stage}`}>
            {group.overdueCount} überfällig
          </span>
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
      title={`${MONTH_NAMES[selectedMonth - 1]} ${selectedYear}`}
      headerRight={
        <div className="text-right">
          {/* „(Leistungen)" ist kein Beiwerk: die Zahl enthält KEINE km und
              keinen Overhead (`unit_type = 'hours'`). Ohne den Zusatz
              verspricht die Schlagzeile den vollen Kontoeingang und liefert
              die Stunden-Hälfte. */}
          <div className="text-xs text-gray-500">Erwarteter Kontoeingang (Leistungen)</div>
          <div
            className="text-lg font-semibold tabular-nums text-gray-900"
            data-testid="text-pipeline-grand-total"
          >
            {isLoading || !pipeline
              ? "—"
              : formatAmount(pipeline.totals.expectedRevenueTotalCents)}
          </div>
          {!isLoading && pipeline && (
            <div className="text-xs text-gray-500" data-testid="text-pipeline-received">
              davon bereits eingegangen{" "}
              <span className="font-medium tabular-nums text-gray-700">
                {formatAmount(pipeline.totals.receivedCents)}
              </span>
            </div>
          )}
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
              <div className="mb-1.5 flex items-baseline justify-between gap-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-gray-400">
                  Wo das Geld gerade steht
                </span>
                {/* Der Selbsttest der Darstellung, sichtbar statt zugesichert:
                    die Stufen MÜSSEN sich auf die Schlagzeile summieren. Geht
                    es nicht auf, sieht man es hier — nicht erst, wenn jemand
                    nachrechnet. */}
                <span className="text-xs text-gray-400 tabular-nums">
                  Summe = {formatAmount(pipeline.totals.expectedRevenueTotalCents)}
                </span>
              </div>
              <div className="flex flex-col gap-1.5">
                {PIPELINE_CASCADE_ORDER.map(renderStage)}
                {renderWartetAufUnterschrift()}
              </div>
            </div>

            {/* „abgesagt / nicht erbracht" — NEBEN der Summe, nicht davon
                abgezogen.

                Das ist der Kern der Kaskaden-Entscheidung: diese € waren NIE
                Teil des erwarteten Kontoeingangs (`assignAppointmentStage`
                gibt `cancelled` als `excluded` zurück, die beiden anderen als
                Side-Zustände ausserhalb von `EXPECTED_REVENUE_SIDE_STATES`).
                Ein Abzug würde sie ein zweites Mal entfernen.

                `wartet_auf_kundenunterschrift` gehört ausdrücklich NICHT
                hierher — es ist erwarteter Umsatz und steht oben in der
                Kaskade. Die Storno-Zustände der Rechnungsseite ebenfalls
                nicht: sie tragen keine Forderung. */}
            {verlustZeilen.length > 0 && (
              <div className="border-t border-gray-100 pt-3">
                <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-400">
                  Abgesagt / nicht erbracht
                  <span className="ml-2 font-normal normal-case tracking-normal text-gray-400">
                    nicht oben enthalten
                  </span>
                </div>
                <div className="flex flex-col gap-1.5">
                  {verlustZeilen.map((z) => (
                    <div
                      key={z.key}
                      className="flex items-baseline gap-3 px-3 py-1"
                      data-testid={`pipeline-verlust-${z.key}`}
                    >
                      <span className="w-44 shrink-0 truncate text-xs text-gray-600">
                        {z.label}
                      </span>
                      <span className="w-28 shrink-0 text-right text-sm font-medium tabular-nums text-gray-700">
                        {formatAmount(z.cents)}
                      </span>
                      {z.count != null && (
                        <span className="text-xs text-gray-400">
                          {z.count} {z.count === 1 ? "Termin" : "Termine"}
                        </span>
                      )}
                      {/* Storno kostet den freien Termin, ein nicht
                          angetroffener Kunde kostet zusätzlich den Lohn. Bei
                          9,50 € gegen 1.881 € ist das heute gleichgültig — in
                          einem Monat mit vielen No-Shows ist es die teurere
                          Zeile, und dann darf die Kachel sie nicht als
                          dasselbe zeigen. */}
                      <span className="text-xs text-gray-400">{z.lohnHinweis}</span>
                    </div>
                  ))}
                </div>
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
