import { useState } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Plus, AlertTriangle, ChevronDown, ChevronUp } from "lucide-react";
import type { CoverageData, CoverageMonthData, CoverageUncoveredCustomer } from "@/features/appointments/hooks/use-appointment-coverage";
import { ROLE_LABELS } from "../constants";
import { getDefaultDateForMonth } from "../utils";

/** "August 2026" → "Aug" — Header und Tabs müssen mobil auf eine Zeile passen. */
function monthShort(label: string): string {
  return monthFull(label).slice(0, 3);
}

/** "August 2026" → "August" — im Fließtext liest der volle Name besser. */
function monthFull(label: string): string {
  return label.split(" ")[0];
}

/**
 * Ein Monat als "Aug 6 (+3)": fette Leitzahl = Kunden in Hauptverantwortung,
 * gedämpftes (+N) = zusätzlich als Vertretung. Die Zahlen sind `shrink-0`,
 * damit bei Platzmangel die Überschrift truncatet und nicht der Zählerstand.
 */
function MonthCount({ data, testId }: { data: CoverageMonthData; testId: string }) {
  return (
    <span className="shrink-0" data-testid={testId}>
      {monthShort(data.label)} <span className="font-semibold">{data.hvCount}</span>
      {data.vertretungCount > 0 && (
        <span className="text-amber-600/70"> (+{data.vertretungCount})</span>
      )}
    </span>
  );
}

function CustomerRow({
  customer,
  prefillDate,
  showRoleLabel,
}: {
  customer: CoverageUncoveredCustomer;
  prefillDate: string;
  showRoleLabel: boolean;
}) {
  const hasMeta = showRoleLabel || !!customer.primaryEmployeeName;
  return (
    <div
      className="flex items-center justify-between py-1.5 px-2 rounded-md bg-white/60"
      data-testid={`coverage-customer-${customer.id}`}
    >
      <div className="min-w-0 flex-1">
        <span className="text-sm text-gray-800 block truncate">{customer.name}</span>
        {hasMeta && (
          <span className="text-[11px] text-gray-500">
            {showRoleLabel && (ROLE_LABELS[customer.role] || customer.role)}
            {customer.role !== "primary" && customer.primaryEmployeeName && (
              <>{showRoleLabel && " · "}HV: {customer.primaryEmployeeName}</>
            )}
          </span>
        )}
      </div>
      <Link href={`/new-appointment?date=${prefillDate}&customerId=${customer.id}`}>
        <Button
          variant="ghost"
          size="sm"
          className="min-h-[44px] min-w-[44px] px-2 text-xs shrink-0"
          data-testid={`button-create-appointment-${customer.id}`}
        >
          <Plus className="h-3 w-3 mr-1" />
          Termin
        </Button>
      </Link>
    </div>
  );
}

export function CoverageBanner({ data }: { data: CoverageData }) {
  const [expanded, setExpanded] = useState(false);
  const [activeTab, setActiveTab] = useState<"current" | "next">("current");

  const currentCount = data.currentMonth.uncoveredCustomers.length;
  const nextCount = data.nextMonth.uncoveredCustomers.length;
  const totalCount = currentCount + nextCount;

  if (totalCount === 0) return null;

  const activeData = activeTab === "current" ? data.currentMonth : data.nextMonth;
  const activeCount = activeTab === "current" ? currentCount : nextCount;
  const prefillDate = getDefaultDateForMonth(activeData.year, activeData.month);

  // Zwei Gruppen statt einer gemischten Liste: Hauptverantwortung zuerst,
  // Vertretungen bleiben sichtbar, aber sauber darunter (Entscheidung 10.08.).
  const hauptverantwortlich = activeData.uncoveredCustomers
    .filter((c) => c.role === "primary")
    .sort((a, b) => a.name.localeCompare(b.name, "de"));
  const vertretung = activeData.uncoveredCustomers
    .filter((c) => c.role !== "primary")
    .sort((a, b) => {
      const roleDiff = (a.role === "backup1" ? 0 : 1) - (b.role === "backup1" ? 0 : 1);
      if (roleDiff !== 0) return roleDiff;
      const hvDiff = (a.primaryEmployeeName ?? "").localeCompare(b.primaryEmployeeName ?? "", "de");
      if (hvDiff !== 0) return hvDiff;
      return a.name.localeCompare(b.name, "de");
    });

  return (
    <div className="rounded-lg border bg-amber-50 border-amber-200 overflow-hidden" data-testid="coverage-banner">
      <button
        className="w-full flex items-center gap-2 px-3 py-2 text-left text-amber-700"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        title="Fette Zahl = Kunden in Hauptverantwortung, (+N) = zusätzlich als Vertretung"
        data-testid="button-toggle-coverage"
      >
        <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
        <span className="text-sm font-medium flex items-center gap-1.5 min-w-0 flex-1">
          <span className="truncate">Kunden ohne Termin</span>
          <span aria-hidden="true">·</span>
          <MonthCount data={data.currentMonth} testId="coverage-count-current" />
          <span aria-hidden="true">·</span>
          <MonthCount data={data.nextMonth} testId="coverage-count-next" />
        </span>
        {expanded ? <ChevronUp className="h-4 w-4 shrink-0" /> : <ChevronDown className="h-4 w-4 shrink-0" />}
      </button>
      {expanded && (
        <div className="px-3 pb-2" data-testid="coverage-list">
          <div className="flex gap-1 mb-2" data-testid="coverage-tabs">
            <button
              className={`flex-1 text-xs font-medium py-1.5 px-2 rounded-md transition-colors ${
                activeTab === "current"
                  ? "bg-amber-200/70 text-amber-800"
                  : "text-amber-600 hover:bg-amber-100"
              }`}
              onClick={() => setActiveTab("current")}
              data-testid="button-coverage-current"
            >
              {monthShort(data.currentMonth.label)} ({currentCount})
            </button>
            <button
              className={`flex-1 text-xs font-medium py-1.5 px-2 rounded-md transition-colors ${
                activeTab === "next"
                  ? "bg-amber-200/70 text-amber-800"
                  : "text-amber-600 hover:bg-amber-100"
              }`}
              onClick={() => setActiveTab("next")}
              data-testid="button-coverage-next"
            >
              {monthShort(data.nextMonth.label)} ({nextCount})
            </button>
          </div>
          <p className="text-[11px] text-amber-600/80 mb-2" data-testid="text-coverage-legend">
            (+N) = als Vertretung
          </p>
          {activeCount === 0 ? (
            <p className="text-xs text-amber-600 text-center py-2" data-testid="text-coverage-empty">
              Alle Kunden haben Termine im {monthFull(activeData.label)}
            </p>
          ) : (
            <div className="space-y-3">
              {hauptverantwortlich.length > 0 && (
                <div data-testid="coverage-group-primary">
                  <p className="text-[11px] font-medium text-amber-700 mb-1">
                    Hauptverantwortlich ({hauptverantwortlich.length})
                  </p>
                  <div className="space-y-1">
                    {hauptverantwortlich.map((customer) => (
                      <CustomerRow
                        key={customer.id}
                        customer={customer}
                        prefillDate={prefillDate}
                        showRoleLabel={false}
                      />
                    ))}
                  </div>
                </div>
              )}
              {vertretung.length > 0 && (
                <div data-testid="coverage-group-backup">
                  <p className="text-[11px] font-medium text-amber-700 mb-1">
                    Als Vertretung ({vertretung.length})
                  </p>
                  <div className="space-y-1">
                    {vertretung.map((customer) => (
                      <CustomerRow
                        key={customer.id}
                        customer={customer}
                        prefillDate={prefillDate}
                        showRoleLabel
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
