import { Fragment, useState } from "react";
import { Loader2, TrendingUp, ChevronDown, ChevronRight } from "lucide-react";
import { iconSize } from "@/design-system";
import type {
  BillingEconomicsResponse,
  BillingEconomicsRow,
  BillingEconomicsEmployeeRow,
} from "@shared/api";
import {
  formatAmount,
  formatHoursFromMinutes,
  formatKm,
  formatRate,
  marginHealthTextColor,
} from "../utils";
import { MONTH_NAMES } from "../constants";
import { CollapsibleCard } from "./collapsible-card";

interface EconomicsOverviewCardProps {
  economics: BillingEconomicsResponse | undefined;
  isLoading: boolean;
  selectedMonth: number;
  selectedYear: number;
}

type EconView = "leistung" | "mitarbeiter";
type SortKey = "umsatz" | "marge";

// Mengen-Spalte je Einheit (reine Darstellung — die Mengen kommen fertig aus dem
// Reader: Minuten bei Stunden, km bei Kilometer, sonst „—").
function quantityLabel(row: BillingEconomicsRow): string {
  if (row.unit === "hours") return formatHoursFromMinutes(row.quantity);
  if (row.unit === "km") return formatKm(row.quantity);
  return "—";
}

function rateLabel(row: BillingEconomicsRow): string | null {
  if (row.unit === "hours") {
    return `${formatRate(row.revenueRateCents)} / ${formatRate(row.costRateCents)} pro Std`;
  }
  if (row.unit === "km") {
    return `${formatRate(row.revenueRateCents)} / ${formatRate(row.costRateCents)} pro km`;
  }
  return null;
}

function KpiTile({
  label,
  value,
  testId,
  valueClassName = "text-gray-900",
}: {
  label: string;
  value: string;
  testId: string;
  valueClassName?: string;
}) {
  return (
    <div className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2.5">
      <div className="text-xs text-gray-500">{label}</div>
      <div
        className={`text-lg font-semibold tabular-nums ${valueClassName}`}
        data-testid={testId}
      >
        {value}
      </div>
    </div>
  );
}

function ServiceTable({ rows }: { rows: BillingEconomicsRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-200 text-left text-xs text-gray-500">
            <th className="py-2 pr-3 font-medium">Leistung</th>
            <th className="py-2 px-3 font-medium text-right">Menge</th>
            <th className="py-2 px-3 font-medium text-right">Umsatz</th>
            <th className="py-2 px-3 font-medium text-right">Lohnkosten</th>
            <th className="py-2 px-3 font-medium text-right">Marge</th>
            <th className="py-2 pl-3 font-medium text-right">%</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const rate = rateLabel(row);
            return (
              <tr
                key={row.key}
                className="border-b border-gray-100"
                data-testid={`row-econ-service-${row.key}`}
              >
                <td className="py-2 pr-3">
                  <div className="font-medium text-gray-900">{row.label}</div>
                  {rate && <div className="text-xs text-gray-400">{rate}</div>}
                </td>
                <td className="py-2 px-3 text-right tabular-nums text-gray-700">
                  {quantityLabel(row)}
                </td>
                <td className="py-2 px-3 text-right tabular-nums text-gray-900">
                  {formatAmount(row.revenueCents)}
                </td>
                <td className="py-2 px-3 text-right tabular-nums text-gray-700">
                  {formatAmount(row.costCents)}
                </td>
                <td
                  className={`py-2 px-3 text-right tabular-nums ${row.marginCents < 0 ? "text-rose-700" : "text-gray-900"}`}
                >
                  {formatAmount(row.marginCents)}
                </td>
                <td
                  className={`py-2 pl-3 text-right tabular-nums font-medium ${marginHealthTextColor(row.marginPercent)}`}
                  data-testid={`text-econ-service-margin-${row.key}`}
                >
                  {row.marginPercent}%
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function EmployeeTable({
  employees,
  sortKey,
  sortDesc,
  onSort,
  expandedId,
  onToggleExpand,
}: {
  employees: BillingEconomicsEmployeeRow[];
  sortKey: SortKey;
  sortDesc: boolean;
  onSort: (key: SortKey) => void;
  expandedId: number | null;
  onToggleExpand: (id: number) => void;
}) {
  const sorted = [...employees].sort((a, b) => {
    const av = sortKey === "umsatz" ? a.revenueCents : a.marginPercent;
    const bv = sortKey === "umsatz" ? b.revenueCents : b.marginPercent;
    return sortDesc ? bv - av : av - bv;
  });

  const SortHeader = ({ label, k }: { label: string; k: SortKey }) => (
    <button
      type="button"
      onClick={() => onSort(k)}
      className="inline-flex items-center gap-1 hover:text-gray-700"
      data-testid={`button-econ-sort-${k}`}
    >
      {label}
      {sortKey === k && (
        <span className="text-gray-400">{sortDesc ? "▼" : "▲"}</span>
      )}
    </button>
  );

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-200 text-left text-xs text-gray-500">
            <th className="py-2 pr-3 font-medium">Mitarbeiter:in</th>
            <th className="py-2 px-3 font-medium text-right">Stunden</th>
            <th className="py-2 px-3 font-medium text-right">km</th>
            <th className="py-2 px-3 font-medium text-right">
              <SortHeader label="Umsatz" k="umsatz" />
            </th>
            <th className="py-2 px-3 font-medium text-right">Lohnkosten</th>
            <th className="py-2 px-3 font-medium text-right">Marge</th>
            <th className="py-2 pl-3 font-medium text-right">
              <SortHeader label="%" k="marge" />
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((emp) => {
            const isOpen = expandedId === emp.employeeId;
            return (
              <Fragment key={emp.employeeId}>
                <tr
                  className="border-b border-gray-100 cursor-pointer hover:bg-gray-50"
                  onClick={() => onToggleExpand(emp.employeeId)}
                  data-testid={`row-econ-employee-${emp.employeeId}`}
                >
                  <td className="py-2 pr-3">
                    <span className="inline-flex items-center gap-1.5 font-medium text-gray-900">
                      {isOpen ? (
                        <ChevronDown className={`${iconSize.sm} text-gray-400`} />
                      ) : (
                        <ChevronRight className={`${iconSize.sm} text-gray-400`} />
                      )}
                      {emp.employeeName}
                    </span>
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums text-gray-700">
                    {formatHoursFromMinutes(emp.serviceMinutes)}
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums text-gray-700">
                    {formatKm(emp.km)}
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums text-gray-900">
                    {formatAmount(emp.revenueCents)}
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums text-gray-700">
                    {formatAmount(emp.costCents)}
                  </td>
                  <td
                    className={`py-2 px-3 text-right tabular-nums ${emp.marginCents < 0 ? "text-rose-700" : "text-gray-900"}`}
                  >
                    {formatAmount(emp.marginCents)}
                  </td>
                  <td
                    className={`py-2 pl-3 text-right tabular-nums font-medium ${marginHealthTextColor(emp.marginPercent)}`}
                    data-testid={`text-econ-employee-margin-${emp.employeeId}`}
                  >
                    {emp.marginPercent}%
                  </td>
                </tr>
                {isOpen && (
                  <tr key={`${emp.employeeId}-drill`} data-testid={`row-econ-employee-drill-${emp.employeeId}`}>
                    <td colSpan={7} className="bg-gray-50 px-3 py-2">
                      <ServiceTable rows={emp.services} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// Task #1473: „Wirtschaftlicher Überblick" der Abrechnungsseite. Liest
// AUSSCHLIESSLICH den Economics-Reader (`GET /billing/economics`) und rendert
// dessen fertige Aggregate — KEINE eigene Geld-/Margen-Mathematik. 4 KPI-Kacheln
// (Umsatz / Lohnkosten / Deckungsbeitrag / Marge) + Umschalter „Nach Leistung" /
// „Nach Mitarbeiter" mit Drilldown und Sortierung (Umsatz / Marge).
export function EconomicsOverviewCard({
  economics,
  isLoading,
  selectedMonth,
  selectedYear,
}: EconomicsOverviewCardProps) {
  const [view, setView] = useState<EconView>("leistung");
  const [expandedEmp, setExpandedEmp] = useState<number | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("umsatz");
  const [sortDesc, setSortDesc] = useState(true);

  const handleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDesc((d) => !d);
    } else {
      setSortKey(key);
      setSortDesc(true);
    }
  };

  return (
    <CollapsibleCard
      storageKey="economics"
      testId="card-billing-economics"
      toggleTestId="button-toggle-economics"
      icon={<TrendingUp className={`${iconSize.md} text-teal-600`} />}
      title={`Wirtschaftlicher Überblick — ${MONTH_NAMES[selectedMonth - 1]} ${selectedYear}`}
      headerRight={
        <div className="text-right">
          <div className="text-xs text-gray-500">Deckungsbeitrag</div>
          <div
            className={`text-lg font-semibold tabular-nums ${
              !economics ? "text-gray-900" : marginHealthTextColor(economics.totals.marginPercent)
            }`}
            data-testid="text-economics-margin"
          >
            {isLoading || !economics
              ? "—"
              : `${formatAmount(economics.totals.marginCents)} · ${economics.totals.marginPercent}%`}
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
        ) : economics ? (
          <div className="mt-3 space-y-4">
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
              <KpiTile
                label="Umsatz"
                value={formatAmount(economics.totals.revenueCents)}
                testId="text-kpi-revenue"
              />
              <KpiTile
                label="Lohnkosten"
                value={formatAmount(economics.totals.laborCostCents)}
                testId="text-kpi-labor"
              />
              <KpiTile
                label="Deckungsbeitrag"
                value={formatAmount(economics.totals.marginCents)}
                testId="text-kpi-margin"
                valueClassName={economics.totals.marginCents < 0 ? "text-rose-700" : "text-gray-900"}
              />
              <KpiTile
                label="Marge"
                value={`${economics.totals.marginPercent}%`}
                testId="text-kpi-margin-percent"
                valueClassName={marginHealthTextColor(economics.totals.marginPercent)}
              />
            </div>

            <div className="inline-flex rounded-md border border-gray-200 bg-gray-50 p-0.5">
              <button
                type="button"
                onClick={() => setView("leistung")}
                className={`rounded px-3 py-1 text-sm font-medium ${
                  view === "leistung" ? "bg-white text-gray-900 shadow-sm" : "text-gray-500"
                }`}
                data-testid="button-econ-view-leistung"
              >
                Nach Leistung
              </button>
              <button
                type="button"
                onClick={() => setView("mitarbeiter")}
                className={`rounded px-3 py-1 text-sm font-medium ${
                  view === "mitarbeiter" ? "bg-white text-gray-900 shadow-sm" : "text-gray-500"
                }`}
                data-testid="button-econ-view-mitarbeiter"
              >
                Nach Mitarbeiter
              </button>
            </div>

            {view === "leistung" ? (
              <ServiceTable rows={economics.byService} />
            ) : economics.byEmployee.length > 0 ? (
              <EmployeeTable
                employees={economics.byEmployee}
                sortKey={sortKey}
                sortDesc={sortDesc}
                onSort={handleSort}
                expandedId={expandedEmp}
                onToggleExpand={(id) => setExpandedEmp((cur) => (cur === id ? null : id))}
              />
            ) : (
              <div className="py-4 text-sm text-gray-500" data-testid="text-econ-employee-empty">
                Keine Mitarbeiter-Daten für diesen Zeitraum.
              </div>
            )}
          </div>
        ) : (
          <div className="py-4 text-sm text-gray-500" data-testid="text-economics-empty">
            Kein wirtschaftlicher Überblick verfügbar.
          </div>
        )}
      </>
    </CollapsibleCard>
  );
}
