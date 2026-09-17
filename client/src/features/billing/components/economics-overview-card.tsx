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
  splitEconomicsRows,
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

/**
 * Satz-Unterzeile für Zeilen ohne Erlös: nur der Kostensatz.
 *
 * `rateLabel` rendert „Erlös / Kosten pro km" — für „Kilometer
 * (Zeiterfassung)" stand dort „0,00 € / 0,35 € pro km", während die
 * Umsatz-Spalte derselben Zeile „—" zeigte („die Frage ist nicht gestellt").
 * Dieselbe Frage darf nicht zwei Zentimeter weiter mit 0,00 € beantwortet
 * werden.
 */
function costOnlyRateLabel(row: BillingEconomicsRow): string | null {
  if (row.unit === "hours") return `${formatRate(row.costRateCents)} pro Std`;
  if (row.unit === "km") return `${formatRate(row.costRateCents)} pro km`;
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

/**
 * Eine Zeile der Kosten-Tabelle.
 *
 * `kosten_ohne_umsatz`-Zeilen zeigen in den Spalten Umsatz / Marge / % bewusst
 * einen Gedankenstrich statt „0,00 €" und „0 %". Eine 0 läse sich wie eine
 * Messung („hier wurde nichts verdient"); tatsächlich ist die Frage für diese
 * Zeilen gar nicht gestellt — es GIBT keinen Umsatz, gegen den eine Marge
 * gerechnet werden könnte. „0 %" wäre besonders irreführend, weil die
 * Marge-Ampel es rot einfärbte und damit ein Problem behauptete, wo eine
 * Kategorie einfach Kosten trägt.
 */
function ServiceRow({ row }: { row: BillingEconomicsRow }) {
  // Der Gedankenstrich hängt NICHT allein am Block, sondern zusätzlich daran,
  // dass die Zeile wirklich keinen Erlös trägt. Sonst versteckte die Anzeige
  // Geld, sobald Block und Betrag auseinanderfallen — der Server bricht
  // dafür inzwischen ab (`buildRow`), aber die Anzeige soll den Fall nicht
  // ihrerseits unsichtbar machen. Zwei Riegel, unabhängig voneinander.
  const ohneUmsatz = row.group === "kosten_ohne_umsatz" && row.revenueCents === 0;
  // N-3: für eine Zeile ohne Erlös ist auch der Erlös-SATZ keine Aussage.
  const rate = ohneUmsatz ? costOnlyRateLabel(row) : rateLabel(row);
  return (
    <tr className="border-b border-gray-100" data-testid={`row-econ-service-${row.key}`}>
      <td className="py-2 pr-3">
        <div className={`font-medium ${ohneUmsatz ? "text-gray-600" : "text-gray-900"}`}>
          {row.label}
        </div>
        {rate && <div className="text-xs text-gray-400">{rate}</div>}
      </td>
      <td className="py-2 px-3 text-right tabular-nums text-gray-700">{quantityLabel(row)}</td>
      <td className="py-2 px-3 text-right tabular-nums text-gray-900">
        {ohneUmsatz ? "—" : formatAmount(row.revenueCents)}
      </td>
      <td className="py-2 px-3 text-right tabular-nums text-gray-700">
        {formatAmount(row.costCents)}
      </td>
      {/* Potenzial. `null` heisst „fuer diese Zeile nicht gestellt" — km und
          Overhead werden nicht geplant. Der Strich sagt das; eine 0 wuerde
          „nichts geplant" behaupten. */}
      <td
        className="py-2 px-3 text-right tabular-nums text-gray-500"
        data-testid={`text-econ-potential-revenue-${row.key}`}
      >
        {row.potentialRevenueCents === null ? "—" : formatAmount(row.potentialRevenueCents)}
      </td>
      <td
        className="py-2 px-3 text-right tabular-nums text-gray-500"
        data-testid={`text-econ-potential-cost-${row.key}`}
      >
        {row.potentialCostCents === null ? "—" : formatAmount(row.potentialCostCents)}
      </td>
      <td
        className={`py-2 px-3 text-right tabular-nums ${row.marginCents < 0 && !ohneUmsatz ? "text-rose-700" : "text-gray-900"}`}
      >
        {ohneUmsatz ? "—" : formatAmount(row.marginCents)}
      </td>
      <td
        className={`py-2 pl-3 text-right tabular-nums font-medium ${ohneUmsatz ? "text-gray-400" : marginHealthTextColor(row.marginPercent)}`}
        data-testid={`text-econ-service-margin-${row.key}`}
      >
        {ohneUmsatz ? "—" : `${row.marginPercent}%`}
      </td>
    </tr>
  );
}

function ServiceTable({
  rows,
  laborCostCents,
}: {
  rows: BillingEconomicsRow[];
  /**
   * Nur für den Selbsttest. Die Zeilen MÜSSEN sich auf die Lohnkosten-Kachel
   * summieren — dieselbe Zusage wie oben in der Kaskade, und dieselbe Art, sie
   * zu zeigen: sichtbar statt zugesichert.
   */
  laborCostCents?: number;
}) {
  // Aufteilung + „darf der untere Block überhaupt gezeigt werden?" liegen als
  // reine Funktion in `../utils` — sie tragen eine Aussage, die falsch sein
  // kann, und im JSX könnte sie niemand prüfen.
  const {
    leistung, ohneUmsatz, ohneUmsatzCents, ohneUmsatzMargeCents, summeCents, zeigeOhneUmsatz,
  } = splitEconomicsRows(rows);
  const stimmt = laborCostCents === undefined || summeCents === laborCostCents;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-gray-400">
            <th />
            <th />
            {/* „Ist" OHNE den Zusatz „(dokumentiert)".
                Der stand hier zuerst und galt fuer sieben der zehn Zeilen
                nicht: die Overhead-Zeilen und die Zeiterfassungs-km kommen aus
                `employee_time_entries` und haben KEIN Dokumentations-Gate — ein
                heute erfasster Urlaub fuer naechste Woche steht sofort drin.
                Eine Gruppen-Ueberschrift gilt fuer alle Zeilen darunter oder
                gar nicht; was nur fuer drei Zeilen stimmt, gehoert an die
                Zeile, nicht ueber die Spalte. */}
            <th colSpan={2} className="pt-1 pb-0.5 px-3 text-center font-medium uppercase tracking-wide">
              Ist
            </th>
            <th colSpan={2} className="pt-1 pb-0.5 px-3 text-center font-medium uppercase tracking-wide">
              Potenzial (ganzer Monat)
            </th>
            <th colSpan={2} />
          </tr>
          <tr className="border-b border-gray-200 text-left text-xs text-gray-500">
            <th className="py-2 pr-3 font-medium">Leistung</th>
            <th className="py-2 px-3 font-medium text-right">Menge</th>
            <th className="py-2 px-3 font-medium text-right">Umsatz</th>
            <th className="py-2 px-3 font-medium text-right">Lohnkosten</th>
            <th className="py-2 px-3 font-medium text-right">Umsatz</th>
            <th className="py-2 px-3 font-medium text-right">Lohnkosten</th>
            <th className="py-2 px-3 font-medium text-right">Marge</th>
            <th className="py-2 pl-3 font-medium text-right">%</th>
          </tr>
        </thead>
        <tbody>
          {leistung.map((row) => (
            <ServiceRow key={row.key} row={row} />
          ))}

          {zeigeOhneUmsatz && (
            <>
              {/* Der Block, den Alrik wörtlich gefragt hat: „wofür zahle ich,
                  ohne dafür Geld zu bekommen?" Bis hierher ERSETZTE eine
                  einzige „Gemeinkosten"-Zeile diese sechs Kategorien plus die
                  Zeiterfassungs-km — die Frage war damit nicht beantwortbar. */}
              <tr className="border-b border-gray-100">
                <td
                  colSpan={8}
                  className="pt-4 pb-1 text-xs font-semibold uppercase tracking-wide text-gray-400"
                >
                  Kosten ohne Umsatz
                </td>
              </tr>
              {ohneUmsatz.map((row) => (
                <ServiceRow key={row.key} row={row} />
              ))}
              <tr className="border-b border-gray-200">
                <td className="py-2 pr-3 text-xs text-gray-500">zusammen</td>
                <td />
                <td />
                <td
                  className="py-2 px-3 text-right text-sm font-semibold tabular-nums text-gray-900"
                  data-testid="text-econ-ohne-umsatz-summe"
                >
                  {formatAmount(ohneUmsatzCents)}
                </td>
                {/* Potenzial-Spalten: fuer Overhead nicht gestellt. */}
                <td />
                <td />
                {/* Der Betrag MUSS auch in der Marge-Spalte stehen. Die
                    Einzelzeilen darüber zeigen dort „—", weil für sie keine
                    Marge gerechnet werden kann — wer die Spalte von oben nach
                    unten addiert, landet sonst um genau diese Summe ÜBER dem
                    Deckungsbeitrag in der Kopfzeile. Hier schliesst sie sich.

                    Gebildet aus den echten Margen des Blocks, nicht als
                    `−ohneUmsatzCents`: die beiden sind nur gleich, solange
                    keine Block-Zeile Erlös trägt, und genau dafür gibt es pro
                    Zeile bereits einen Riegel. Das Vorzeichen kommt damit aus
                    der Zahl statt von Hand. */}
                <td
                  className={`py-2 px-3 text-right text-sm font-semibold tabular-nums ${
                    ohneUmsatzMargeCents < 0 ? "text-rose-700" : "text-gray-900"
                  }`}
                  data-testid="text-econ-ohne-umsatz-marge"
                >
                  {formatAmount(ohneUmsatzMargeCents)}
                </td>
                <td />
              </tr>
            </>
          )}
        </tbody>
        {laborCostCents !== undefined && (
          <tfoot>
            <tr>
              <td colSpan={3} className="pt-2 text-xs text-gray-400">
                {stimmt ? (
                  <span data-testid="text-econ-selbsttest">
                    Summe aller Zeilen = Lohnkosten
                  </span>
                ) : (
                  <span className="font-semibold text-rose-700" data-testid="text-econ-selbsttest">
                    Summe {formatAmount(summeCents)} ≠ Lohnkosten{" "}
                    {formatAmount(laborCostCents)}
                  </span>
                )}
              </td>
              <td className="pt-2 px-3 text-right text-xs tabular-nums text-gray-400">
                {formatAmount(summeCents)}
              </td>
              <td colSpan={4} />
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

/**
 * Marge-Farbe einer Mitarbeiter-Zeile.
 *
 * Eine Person mit NUR geplanter Arbeit steht seit den Potenzial-Spalten in
 * dieser Tabelle — mit lauter Nullen. `marginHealthTextColor(0)` faerbte das
 * ROT und behauptete damit ein Problem, wo schlicht noch nichts dokumentiert
 * ist. Das ist dieselbe Fehlerklasse, die in der Kosten-Tabelle daneben schon
 * abgeraeumt wurde („eine 0 laese sich wie eine Messung") — nur eine Tabelle
 * weiter, und dort erst durch diesen PR entstanden.
 *
 * Ohne Umsatz UND ohne Kosten ist die Marge keine Aussage, sondern eine
 * Leerstelle.
 */
function margeFarbe(emp: BillingEconomicsEmployeeRow): string {
  const nichtsGemessen = emp.revenueCents === 0 && emp.costCents === 0;
  return nichtsGemessen ? "text-gray-400" : marginHealthTextColor(emp.marginPercent);
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
                    className={`py-2 pl-3 text-right tabular-nums font-medium ${margeFarbe(emp)}`}
                    data-testid={`text-econ-employee-margin-${emp.employeeId}`}
                  >
                    {emp.marginPercent}%
                  </td>
                </tr>
                {isOpen && (
                  <tr key={`${emp.employeeId}-drill`} data-testid={`row-econ-employee-drill-${emp.employeeId}`}>
                    <td colSpan={7} className="bg-gray-50 px-3 py-2">
                      <ServiceTable rows={emp.services} laborCostCents={emp.costCents} />
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
              <ServiceTable rows={economics.byService} laborCostCents={economics.totals.laborCostCents} />
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
