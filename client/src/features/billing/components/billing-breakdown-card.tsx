import { useMemo, useState } from "react";
import { Loader2, Table2 } from "lucide-react";
import { iconSize } from "@/design-system";
import type { BillingBreakdownResponse } from "@shared/api";
import {
  groupBillingBreakdown,
  summarizeBreakdownRows,
  type BreakdownDimension,
} from "@shared/domain/billing-breakdown";
import { formatAmount, formatHoursFromMinutes } from "../utils";
import { MONTH_NAMES } from "../constants";
import { useRowCap } from "../hooks/use-row-cap";
import { CollapsibleCard } from "./collapsible-card";

interface BillingBreakdownCardProps {
  breakdown: BillingBreakdownResponse | undefined;
  isLoading: boolean;
  selectedMonth: number;
  selectedYear: number;
}

// Deutsche Anzeige einer quantisierten km-Strecke (zwei Nachkommastellen,
// Komma-Trenner). Reine Darstellung — der Wert ist bereits in der Domäne
// (`groupBillingBreakdown`) via `quantizeKm` gerundet.
function formatKm(km: number): string {
  return `${km.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} km`;
}

// Task #1453 — Abrechnungs-Breakdown-Tabelle (Phase 1, READ-ONLY). Liest
// ausschließlich den neuen Breakdown-Reader (`GET /billing/breakdown`) und
// gruppiert dessen vor-aggregierte Einheiten clientseitig über dieselbe
// Domänen-Funktion (`groupBillingBreakdown`) nach Kunde ODER Kasse — kein
// Refetch beim Umschalten, keine eigene Geld-/Stunden-Mathematik.
export function BillingBreakdownCard({
  breakdown,
  isLoading,
  selectedMonth,
  selectedYear,
}: BillingBreakdownCardProps) {
  const [dimension, setDimension] = useState<BreakdownDimension>("kunde");

  const rows = useMemo(
    () => (breakdown ? groupBillingBreakdown(breakdown.units, dimension) : []),
    [breakdown, dimension],
  );
  const totals = useMemo(() => summarizeBreakdownRows(rows), [rows]);
  // Task #1465: lange Listen begrenzen — nur die DARSTELLUNG der Detailzeilen
  // wird gekappt; `totals` rechnet weiterhin über ALLE `rows`.
  const { visible, showAll, setShowAll, hiddenCount, capped, total } = useRowCap(rows);

  const dimensionToggle = (
    <div className="inline-flex rounded-md border border-gray-200 p-0.5" role="group">
      <button
        type="button"
        onClick={() => setDimension("kunde")}
        className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
          dimension === "kunde" ? "bg-teal-600 text-white" : "text-gray-600 hover:bg-gray-100"
        }`}
        data-testid="button-breakdown-by-kunde"
        aria-pressed={dimension === "kunde"}
      >
        Nach Kunde
      </button>
      <button
        type="button"
        onClick={() => setDimension("kasse")}
        className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
          dimension === "kasse" ? "bg-teal-600 text-white" : "text-gray-600 hover:bg-gray-100"
        }`}
        data-testid="button-breakdown-by-kasse"
        aria-pressed={dimension === "kasse"}
      >
        Nach Kasse
      </button>
    </div>
  );

  return (
    <CollapsibleCard
      storageKey="breakdown"
      testId="card-billing-breakdown"
      toggleTestId="button-toggle-breakdown"
      icon={<Table2 className={`${iconSize.md} text-teal-600`} />}
      title={`Leistungs-Aufschlüsselung — ${MONTH_NAMES[selectedMonth - 1]} ${selectedYear}`}
      headerRight={dimensionToggle}
    >
      <>
        {isLoading ? (
          <div className="flex items-center gap-2 py-4 text-sm text-gray-500">
            <Loader2 className={`${iconSize.sm} animate-spin text-teal-600`} />
            Aufschlüsselung wird geladen …
          </div>
        ) : rows.length === 0 ? (
          <div className="py-6 text-center text-sm text-gray-500" data-testid="text-breakdown-empty">
            Keine abrechenbaren Leistungen in diesem Monat.
          </div>
        ) : (
          <>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm" data-testid="table-billing-breakdown">
              <thead>
                <tr className="border-b border-gray-200 text-left text-xs text-gray-500">
                  <th className="py-2 pr-3 font-medium">
                    {dimension === "kunde" ? "Kunde" : "Kasse"}
                  </th>
                  <th className="py-2 px-3 text-right font-medium">Std. Hauswirtschaft</th>
                  <th className="py-2 px-3 text-right font-medium">Std. Alltagsbegleitung</th>
                  <th className="py-2 px-3 text-right font-medium">Summe km</th>
                  <th className="py-2 pl-3 text-right font-medium">€</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => (
                  <tr
                    key={row.key}
                    className="border-b border-gray-100 last:border-0"
                    data-testid={`row-breakdown-${row.key}`}
                  >
                    <td className="py-2 pr-3 text-gray-900" data-testid={`text-breakdown-label-${row.key}`}>
                      {row.label}
                    </td>
                    <td
                      className="py-2 px-3 text-right tabular-nums text-gray-900"
                      data-testid={`text-breakdown-hw-${row.key}`}
                    >
                      {formatHoursFromMinutes(row.hauswirtschaftMinutes)}
                    </td>
                    <td
                      className="py-2 px-3 text-right tabular-nums text-gray-900"
                      data-testid={`text-breakdown-ab-${row.key}`}
                    >
                      {formatHoursFromMinutes(row.alltagsbegleitungMinutes)}
                    </td>
                    <td
                      className="py-2 px-3 text-right tabular-nums text-gray-900"
                      data-testid={`text-breakdown-km-${row.key}`}
                    >
                      {formatKm(row.kmQuantized)}
                    </td>
                    <td
                      className={`py-2 pl-3 text-right tabular-nums font-medium ${
                        row.totalCents < 0 ? "text-red-600" : "text-gray-900"
                      }`}
                      data-testid={`text-breakdown-total-${row.key}`}
                    >
                      {formatAmount(row.totalCents)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-gray-300 font-semibold text-gray-900">
                  <td className="py-2 pr-3" data-testid="text-breakdown-total-label">
                    Gesamt
                  </td>
                  <td
                    className="py-2 px-3 text-right tabular-nums"
                    data-testid="text-breakdown-total-hw"
                  >
                    {formatHoursFromMinutes(totals.hauswirtschaftMinutes)}
                  </td>
                  <td
                    className="py-2 px-3 text-right tabular-nums"
                    data-testid="text-breakdown-total-ab"
                  >
                    {formatHoursFromMinutes(totals.alltagsbegleitungMinutes)}
                  </td>
                  <td
                    className="py-2 px-3 text-right tabular-nums"
                    data-testid="text-breakdown-total-km"
                  >
                    {formatKm(totals.kmQuantized)}
                  </td>
                  <td
                    className="py-2 pl-3 text-right tabular-nums"
                    data-testid="text-breakdown-total-cents"
                  >
                    {formatAmount(totals.totalCents)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
          {capped && (
            <div className="mt-3 flex justify-center">
              <button
                type="button"
                onClick={() => setShowAll(!showAll)}
                className="text-xs font-medium text-teal-700 hover:text-teal-800"
                data-testid="button-breakdown-show-more"
              >
                {showAll
                  ? "Weniger anzeigen"
                  : `Alle ${total} anzeigen (${hiddenCount} weitere)`}
              </button>
            </div>
          )}
          </>
        )}
      </>
    </CollapsibleCard>
  );
}
