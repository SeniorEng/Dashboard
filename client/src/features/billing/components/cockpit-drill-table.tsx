import { useState } from "react";
import { Link } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { iconSize } from "@/design-system";
import type { CockpitDrillRow, CockpitFunnelStage } from "@shared/api";
import {
  groupCockpitRows,
  COCKPIT_GROUP_DIMENSION_LABELS,
  COCKPIT_FUNNEL_STAGE_LABELS,
  type CockpitGroupDimension,
} from "@shared/domain/billing-cockpit";
import { formatAmount, formatHoursFromMinutes, formatDate } from "../utils";

const GROUP_DIMENSIONS: CockpitGroupDimension[] = ["mitarbeiter", "rechnung", "kunde"];

interface CockpitDrillTableProps {
  rows: CockpitDrillRow[];
  activeStage: CockpitFunnelStage | null;
  dimension: CockpitGroupDimension;
  onDimensionChange: (dimension: CockpitGroupDimension) => void;
  onClearStage: () => void;
  // Task #1450 — lazy/paginierte Drill-Daten (pro aktiver Stufe nachgeladen).
  isLoading: boolean;
  isError: boolean;
  total: number;
  hasMore: boolean;
  onLoadMore: () => void;
  onRetry: () => void;
}

// Task #1444 — Zone B: READ-ONLY Drill-down-Tabelle. Gruppiert die vom Reader
// gelieferten Zeilen rein clientseitig über die SSoT `groupCockpitRows`
// (Mitarbeiter/Rechnung/Kunde). Kein Bulk-Action-Bar (Phase 2). Zeilen-Klick →
// Termin-Detail.
// Task #1450 — Die Zeilen werden NICHT mehr inline mit der Übersicht geladen,
// sondern erst beim Klick auf eine Trichter-Stufe lazy nachgeholt (`GET
// /billing/cockpit/drill`) und über „mehr laden" paginiert. Ohne aktive Stufe
// zeigt die Tabelle nur einen Hinweis (Standard: nur Trichter + Buckets).
export function CockpitDrillTable({
  rows,
  activeStage,
  dimension,
  onDimensionChange,
  onClearStage,
  isLoading,
  isError,
  total,
  hasMore,
  onLoadMore,
  onRetry,
}: CockpitDrillTableProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const groups = groupCockpitRows(rows, dimension);

  const toggle = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Ohne ausgewählte Stufe werden bewusst keine Zeilen geladen.
  if (!activeStage) {
    return (
      <Card className="mb-6" data-testid="card-cockpit-drill">
        <CardContent className="p-4">
          <p className="text-sm text-gray-500 py-6 text-center" data-testid="text-drill-pick-stage">
            Wähle oben eine Trichter-Stufe, um die Detailzeilen zu laden.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="mb-6" data-testid="card-cockpit-drill">
      <CardContent className="p-4">
        <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-sm font-semibold text-gray-900">
              Detailansicht: {COCKPIT_FUNNEL_STAGE_LABELS[activeStage]}
            </h2>
            {total > 0 && (
              <span className="text-xs text-gray-500" data-testid="text-drill-total">
                {rows.length} von {total}
              </span>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={onClearStage}
              data-testid="button-clear-stage-filter"
            >
              Filter aufheben
            </Button>
          </div>
          <div className="flex items-center gap-1" role="group" aria-label="Gruppierung">
            {GROUP_DIMENSIONS.map((dim) => (
              <Button
                key={dim}
                variant={dimension === dim ? "default" : "outline"}
                size="sm"
                onClick={() => onDimensionChange(dim)}
                aria-pressed={dimension === dim}
                data-testid={`button-group-${dim}`}
              >
                {COCKPIT_GROUP_DIMENSION_LABELS[dim]}
              </Button>
            ))}
          </div>
        </div>

        {isError ? (
          <div className="py-8 text-center" data-testid="status-drill-error">
            <p className="text-sm text-gray-600 mb-3">
              Die Detailzeilen konnten nicht geladen werden.
            </p>
            <Button variant="outline" size="sm" onClick={onRetry} data-testid="button-drill-retry">
              Erneut versuchen
            </Button>
          </div>
        ) : isLoading && rows.length === 0 ? (
          <div className="flex items-center justify-center py-10" data-testid="status-drill-loading">
            <Loader2 className={`${iconSize.lg} animate-spin text-gray-400`} />
          </div>
        ) : groups.length === 0 ? (
          <p className="text-sm text-gray-500 py-6 text-center" data-testid="text-drill-empty">
            Keine Einträge in dieser Auswahl.
          </p>
        ) : (
          <div className="space-y-2">
            {groups.map((group) => {
              const isOpen = expanded.has(group.key);
              return (
                <div key={group.key} className="rounded-lg border border-gray-200">
                  <button
                    type="button"
                    onClick={() => toggle(group.key)}
                    aria-expanded={isOpen}
                    className="flex w-full items-center justify-between gap-3 p-3 text-left hover:bg-gray-50"
                    data-testid={`button-group-toggle-${group.key}`}
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      {isOpen ? (
                        <ChevronDown className={iconSize.sm} />
                      ) : (
                        <ChevronRight className={iconSize.sm} />
                      )}
                      <span className="truncate font-medium text-gray-900" data-testid={`text-group-label-${group.key}`}>
                        {group.label}
                      </span>
                      <span className="text-xs text-gray-500">({group.rowCount})</span>
                    </span>
                    <span className="flex items-center gap-4 shrink-0 text-sm tabular-nums">
                      <span className="text-gray-500" data-testid={`text-group-hours-${group.key}`}>
                        {formatHoursFromMinutes(group.totalMinutes)}
                      </span>
                      <span className="font-semibold text-gray-900" data-testid={`text-group-amount-${group.key}`}>
                        {formatAmount(group.totalCents)}
                      </span>
                    </span>
                  </button>

                  {isOpen && (
                    <ul className="divide-y divide-gray-100 border-t border-gray-100">
                      {group.rows.map((row) => {
                        const inner = (
                          <div className="flex items-center justify-between gap-3 p-3 text-sm">
                            <span className="min-w-0 truncate">
                              <span className="text-gray-900">{row.customerName || "—"}</span>
                              {row.kind === "appointment" && row.date && (
                                <span className="ml-2 text-gray-500">{formatDate(row.date.slice(0, 10))}</span>
                              )}
                              {row.kind === "invoice" && row.invoiceNumber && (
                                <span className="ml-2 text-gray-500">{row.invoiceNumber}</span>
                              )}
                            </span>
                            <span className="shrink-0 font-medium tabular-nums text-gray-900">
                              {formatAmount(row.cents)}
                            </span>
                          </div>
                        );
                        return (
                          <li key={row.id} data-testid={`row-drill-${row.id}`}>
                            {row.appointmentId != null ? (
                              <Link
                                href={`/appointment/${row.appointmentId}`}
                                className="block hover:bg-gray-50"
                                data-testid={`link-drill-${row.id}`}
                              >
                                {inner}
                              </Link>
                            ) : (
                              inner
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              );
            })}

            {hasMore && (
              <div className="pt-2 text-center">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onLoadMore}
                  disabled={isLoading}
                  data-testid="button-drill-load-more"
                >
                  {isLoading ? (
                    <Loader2 className={`${iconSize.sm} animate-spin`} />
                  ) : (
                    "Mehr laden"
                  )}
                </Button>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
