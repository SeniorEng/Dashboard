import { useState } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Plus, AlertTriangle, ChevronDown, ChevronUp } from "lucide-react";
import type { CoverageData } from "@/features/appointments/hooks/use-appointment-coverage";
import { ROLE_LABELS } from "../constants";
import { getDefaultDateForMonth } from "../utils";

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

  const currentMonthShort = data.currentMonth.label.split(" ")[0];
  const nextMonthShort = data.nextMonth.label.split(" ")[0];

  return (
    <div className="rounded-lg border bg-amber-50 border-amber-200 overflow-hidden" data-testid="coverage-banner">
      <button
        className="w-full flex items-center gap-2 px-3 py-2 text-left text-amber-700"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        data-testid="button-toggle-coverage"
      >
        <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
        <span className="text-sm font-medium flex-1">
          Kunden ohne Termin · {currentMonthShort}: {currentCount} · {nextMonthShort}: {nextCount}
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
              {currentMonthShort} ({currentCount})
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
              {nextMonthShort} ({nextCount})
            </button>
          </div>
          {activeCount === 0 ? (
            <p className="text-xs text-amber-600 text-center py-2" data-testid="text-coverage-empty">
              Alle Kunden haben Termine im {activeTab === "current" ? currentMonthShort : nextMonthShort}
            </p>
          ) : (
            <div className="space-y-1">
              {[...activeData.uncoveredCustomers].sort((a, b) => {
                const order = { primary: 0, backup1: 1, backup2: 2 };
                const roleDiff = (order[a.role] ?? 3) - (order[b.role] ?? 3);
                if (roleDiff !== 0) return roleDiff;
                const hvA = a.primaryEmployeeName ?? "";
                const hvB = b.primaryEmployeeName ?? "";
                return hvA.localeCompare(hvB, "de");
              }).map((customer) => (
                <div
                  key={customer.id}
                  className="flex items-center justify-between py-1.5 px-2 rounded-md bg-white/60"
                  data-testid={`coverage-customer-${customer.id}`}
                >
                  <div className="min-w-0 flex-1">
                    <span className="text-sm text-gray-800 block truncate">{customer.name}</span>
                    <span className="text-[11px] text-gray-500">
                      {ROLE_LABELS[customer.role] || customer.role}
                      {customer.role !== "primary" && customer.primaryEmployeeName && (
                        <> · HV: {customer.primaryEmployeeName}</>
                      )}
                    </span>
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
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
