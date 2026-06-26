import { useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Loader2, ClipboardCheck } from "lucide-react";
import { iconSize } from "@/design-system";
import type {
  BillingReviewClustersResponse,
  BillingReviewClusterItem,
  BillingReviewClusterGroup,
  BillingReviewDimension,
} from "@shared/api";
import { formatAmount, formatHoursFromMinutes } from "../utils";
import { MONTH_NAMES } from "../constants";

interface BillingReviewClusterCardProps {
  review: BillingReviewClustersResponse | undefined;
  isLoading: boolean;
  selectedMonth: number;
  selectedYear: number;
  /** Bestehender Einzel-Generate-Pfad pro markiertem Kunde (Loop). */
  onGenerate: (customerIds: number[], onDone: () => void) => void;
  isGenerating: boolean;
}

// Deutsche Anzeige einer quantisierten km-Strecke (zwei Nachkommastellen) —
// reine Darstellung, der Wert ist bereits in der Domäne gerundet.
function formatKm(km: number): string {
  return `${km.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} km`;
}

// Task #1456 — Pre-Commit-Review-Cluster (Phase 2). Liest AUSSCHLIESSLICH den
// neuen Review-Reader (`GET /billing/review-clusters`), der die abzurechnende
// Arbeit bereits server-seitig nach beiden Dimensionen (Kunde / Kasse) über die
// Breakdown-SSoT gruppiert + die Gesamtsumme mitliefert — der Umschalter wählt
// nur die vorberechnete Sicht (kein Refetch, keine eigene Mathematik). Der Admin
// markiert berechtigte Cluster (einzeln, je Cluster oder alle) und stößt
// „Rechnung(en) erstellen" an; blockierte Kunden sind ausgegraut + zeigen die
// wortgleiche Begründung. Erstellung läuft über den bestehenden Generate-Pfad.
export function BillingReviewClusterCard({
  review,
  isLoading,
  selectedMonth,
  selectedYear,
  onGenerate,
  isGenerating,
}: BillingReviewClusterCardProps) {
  const [dimension, setDimension] = useState<BillingReviewDimension>("kunde");
  const [marked, setMarked] = useState<Set<number>>(new Set());

  const items = review?.items ?? [];
  const clusters = review?.clusters[dimension] ?? [];
  const grandTotals = review?.grandTotals;

  const itemById = useMemo(
    () => new Map(items.map((i) => [i.customerId, i])),
    [items],
  );

  const allEligibleIds = useMemo(
    () => items.filter((i) => i.eligibility.status === "eligible").map((i) => i.customerId),
    [items],
  );
  const eligibleIdSet = useMemo(() => new Set(allEligibleIds), [allEligibleIds]);

  // Markierungen auf aktuell berechtigte Kunden einschränken (defensive Sicht,
  // falls sich die Liste nach einer Erstellung ändert).
  const effectiveMarked = useMemo(
    () => new Set([...marked].filter((id) => eligibleIdSet.has(id))),
    [marked, eligibleIdSet],
  );

  function setIds(ids: number[], on: boolean) {
    setMarked((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }

  function handleGenerate() {
    const ids = [...effectiveMarked];
    if (ids.length === 0) return;
    onGenerate(ids, () => setMarked(new Set()));
  }

  const markedCount = effectiveMarked.size;
  const eligibleCount = allEligibleIds.length;
  const blockedCount = items.length - eligibleCount;
  const allEligibleMarked = eligibleCount > 0 && allEligibleIds.every((id) => effectiveMarked.has(id));

  return (
    <Card className="mb-6" data-testid="card-billing-review">
      <CardContent className="p-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <ClipboardCheck className={`${iconSize.md} text-teal-600`} />
            <h2 className="text-sm font-semibold text-gray-900">
              Rechnungs-Review — {MONTH_NAMES[selectedMonth - 1]} {selectedYear}
            </h2>
          </div>
          <div className="inline-flex rounded-md border border-gray-200 p-0.5" role="group">
            <button
              type="button"
              onClick={() => setDimension("kunde")}
              className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
                dimension === "kunde" ? "bg-teal-600 text-white" : "text-gray-600 hover:bg-gray-100"
              }`}
              data-testid="button-review-by-kunde"
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
              data-testid="button-review-by-kasse"
              aria-pressed={dimension === "kasse"}
            >
              Nach Kasse
            </button>
          </div>
        </div>

        {isLoading ? (
          <div className="flex items-center gap-2 py-4 text-sm text-gray-500">
            <Loader2 className={`${iconSize.sm} animate-spin text-teal-600`} />
            Review wird geladen …
          </div>
        ) : items.length === 0 ? (
          <div className="py-6 text-center text-sm text-gray-500" data-testid="text-review-empty">
            Keine abrechenbaren Leistungen in diesem Monat.
          </div>
        ) : (
          <>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-sm" data-testid="table-billing-review">
                <thead>
                  <tr className="border-b border-gray-200 text-left text-xs text-gray-500">
                    <th className="py-2 pr-3 font-medium w-8">
                      <Checkbox
                        checked={allEligibleMarked}
                        disabled={eligibleCount === 0}
                        onCheckedChange={(v) => setIds(allEligibleIds, v === true)}
                        data-testid="checkbox-review-mark-all"
                        aria-label="Alle berechtigten Kunden markieren"
                      />
                    </th>
                    <th className="py-2 pr-3 font-medium">
                      {dimension === "kunde" ? "Kunde" : "Kasse / Kunde"}
                    </th>
                    <th className="py-2 px-3 text-right font-medium">Std. Hauswirtschaft</th>
                    <th className="py-2 px-3 text-right font-medium">Std. Alltagsbegleitung</th>
                    <th className="py-2 px-3 text-right font-medium">Summe km</th>
                    <th className="py-2 px-3 text-right font-medium">€</th>
                    <th className="py-2 pl-3 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {clusters.map((cluster) => (
                    <ReviewClusterRows
                      key={cluster.key}
                      cluster={cluster}
                      dimension={dimension}
                      itemById={itemById}
                      marked={effectiveMarked}
                      onSetIds={setIds}
                    />
                  ))}
                </tbody>
                {grandTotals && (
                  <tfoot>
                    <tr className="border-t border-gray-300 font-semibold text-gray-900">
                      <td className="py-2 pr-3" />
                      <td className="py-2 pr-3" data-testid="text-review-total-label">
                        Gesamt
                      </td>
                      <td className="py-2 px-3 text-right tabular-nums" data-testid="text-review-total-hw">
                        {formatHoursFromMinutes(grandTotals.hauswirtschaftMinutes)}
                      </td>
                      <td className="py-2 px-3 text-right tabular-nums" data-testid="text-review-total-ab">
                        {formatHoursFromMinutes(grandTotals.alltagsbegleitungMinutes)}
                      </td>
                      <td className="py-2 px-3 text-right tabular-nums" data-testid="text-review-total-km">
                        {formatKm(grandTotals.kmQuantized)}
                      </td>
                      <td className="py-2 px-3 text-right tabular-nums" data-testid="text-review-total-cents">
                        {formatAmount(grandTotals.totalCents)}
                      </td>
                      <td className="py-2 pl-3" />
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>

            <div className="mt-4 flex items-center justify-between gap-3 flex-wrap">
              <div className="text-xs text-gray-500" data-testid="text-review-summary">
                <span data-testid="text-review-eligible-count">{eligibleCount} abrechenbar</span>
                {" · "}
                <span data-testid="text-review-blocked-count">{blockedCount} blockiert</span>
              </div>
              <button
                type="button"
                onClick={handleGenerate}
                disabled={markedCount === 0 || isGenerating}
                className="inline-flex items-center gap-2 rounded-md bg-teal-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-teal-700 disabled:cursor-not-allowed disabled:opacity-50"
                data-testid="button-review-generate"
              >
                {isGenerating && <Loader2 className={`${iconSize.sm} animate-spin`} />}
                Rechnung(en) erstellen ({markedCount})
              </button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

interface ReviewClusterRowsProps {
  cluster: BillingReviewClusterGroup;
  dimension: BillingReviewDimension;
  itemById: Map<number, BillingReviewClusterItem>;
  marked: Set<number>;
  onSetIds: (ids: number[], on: boolean) => void;
}

function ReviewClusterRows({ cluster, dimension, itemById, marked, onSetIds }: ReviewClusterRowsProps) {
  const showClusterHeader = dimension === "kasse";
  const members = cluster.customerIds
    .map((id) => itemById.get(id))
    .filter((i): i is BillingReviewClusterItem => i != null);
  const allClusterMarked =
    cluster.eligibleCustomerIds.length > 0
    && cluster.eligibleCustomerIds.every((id) => marked.has(id));

  return (
    <>
      {showClusterHeader && (
        <tr className="border-b border-gray-200 bg-gray-50" data-testid={`row-review-group-${cluster.key}`}>
          <td className="py-2 pr-3">
            <Checkbox
              checked={allClusterMarked}
              disabled={cluster.eligibleCustomerIds.length === 0}
              onCheckedChange={(v) => onSetIds(cluster.eligibleCustomerIds, v === true)}
              data-testid={`checkbox-review-group-${cluster.key}`}
              aria-label={`Alle berechtigten Kunden von ${cluster.label} markieren`}
            />
          </td>
          <td className="py-2 pr-3 font-semibold text-gray-900" data-testid={`text-review-group-${cluster.key}`}>
            {cluster.label}
          </td>
          <td className="py-2 px-3 text-right tabular-nums font-semibold text-gray-900" data-testid={`text-review-group-hw-${cluster.key}`}>
            {formatHoursFromMinutes(cluster.hauswirtschaftMinutes)}
          </td>
          <td className="py-2 px-3 text-right tabular-nums font-semibold text-gray-900" data-testid={`text-review-group-ab-${cluster.key}`}>
            {formatHoursFromMinutes(cluster.alltagsbegleitungMinutes)}
          </td>
          <td className="py-2 px-3 text-right tabular-nums font-semibold text-gray-900" data-testid={`text-review-group-km-${cluster.key}`}>
            {formatKm(cluster.kmQuantized)}
          </td>
          <td
            className={`py-2 px-3 text-right tabular-nums font-semibold ${
              cluster.totalCents < 0 ? "text-red-600" : "text-gray-900"
            }`}
            data-testid={`text-review-group-total-${cluster.key}`}
          >
            {formatAmount(cluster.totalCents)}
          </td>
          <td className="py-2 pl-3" />
        </tr>
      )}
      {members.map((item) => {
        const isEligible = item.eligibility.status === "eligible";
        const isMarked = marked.has(item.customerId);
        return (
          <tr
            key={item.customerId}
            className={`border-b border-gray-100 last:border-0 ${isEligible ? "" : "bg-gray-50/50 text-gray-400"}`}
            data-testid={`row-review-${item.customerId}`}
          >
            <td className={`py-2 pr-3 ${showClusterHeader ? "pl-6" : ""}`}>
              {isEligible ? (
                <Checkbox
                  checked={isMarked}
                  onCheckedChange={(v) => onSetIds([item.customerId], v === true)}
                  data-testid={`checkbox-review-${item.customerId}`}
                  aria-label={`${item.customerName} markieren`}
                />
              ) : null}
            </td>
            <td
              className={`py-2 pr-3 ${isEligible ? "text-gray-900" : "text-gray-400"}`}
              data-testid={`text-review-name-${item.customerId}`}
            >
              {item.customerName}
            </td>
            <td className="py-2 px-3 text-right tabular-nums" data-testid={`text-review-hw-${item.customerId}`}>
              {formatHoursFromMinutes(item.hauswirtschaftMinutes)}
            </td>
            <td className="py-2 px-3 text-right tabular-nums" data-testid={`text-review-ab-${item.customerId}`}>
              {formatHoursFromMinutes(item.alltagsbegleitungMinutes)}
            </td>
            <td className="py-2 px-3 text-right tabular-nums" data-testid={`text-review-km-${item.customerId}`}>
              {formatKm(item.kmQuantized)}
            </td>
            <td
              className={`py-2 px-3 text-right tabular-nums font-medium ${
                !isEligible ? "" : item.totalCents < 0 ? "text-red-600" : "text-gray-900"
              }`}
              data-testid={`text-review-total-${item.customerId}`}
            >
              {formatAmount(item.totalCents)}
            </td>
            <td className="py-2 pl-3" data-testid={`text-review-status-${item.customerId}`}>
              {isEligible ? (
                <span className="text-xs font-medium text-teal-700">Abrechenbar</span>
              ) : (
                <span className="text-xs text-gray-500" data-testid={`text-review-reason-${item.customerId}`}>
                  {item.eligibility.message}
                </span>
              )}
            </td>
          </tr>
        );
      })}
    </>
  );
}
