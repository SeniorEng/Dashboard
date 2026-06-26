import { Loader2, FileWarning, Wallet } from "lucide-react";
import { iconSize } from "@/design-system";
import type {
  BillingBlockersResponse,
  DocumentationBlockerItem,
  BudgetBlockerItem,
} from "@shared/api";
import { formatAmount } from "../utils";
import { MONTH_NAMES } from "../constants";
import { CollapsibleCard } from "./collapsible-card";

interface BillingBlockersCardProps {
  blockers: BillingBlockersResponse | undefined;
  isLoading: boolean;
  selectedMonth: number;
  selectedYear: number;
}

// Lesbare Topf-Bezeichnung (reine Anzeige; die Schlüssel kommen aus der Domäne).
const BUDGET_TYPE_LABELS: Record<string, string> = {
  entlastungsbetrag_45b: "§45b Entlastungsbetrag",
  umwandlung_45a: "§45a Umwandlung",
  ersatzpflege_39_42a: "§39/§42a Ersatzpflege",
};

function formatBudgetType(type: string): string {
  return BUDGET_TYPE_LABELS[type] ?? type;
}

// Deutsches Datum (dd.mm.) — reine Darstellung.
function formatShortDate(iso: string): string {
  const [, m, d] = iso.split("-");
  return d && m ? `${d}.${m}.` : iso;
}

// Task #1462 — „Was hängt"-Panel (Phase 4, Teil A). READ-ONLY: liest
// ausschließlich den neuen Blocker-Reader (`GET /billing/blockers`), der genau
// ZWEI bestehende SSoTs komponiert (Doku-Readiness + Budget-Konservierung).
// Keine Mutation, keine eigene Berechnung — nur Anzeige von Anzahl + Posten je
// Gruppe.
export function BillingBlockersCard({
  blockers,
  isLoading,
  selectedMonth,
  selectedYear,
}: BillingBlockersCardProps) {
  const documentation = blockers?.documentation;
  const budget = blockers?.budget;

  return (
    <CollapsibleCard
      storageKey="blockers"
      testId="card-billing-blockers"
      toggleTestId="button-toggle-blockers"
      icon={<FileWarning className={`${iconSize.md} text-amber-600`} />}
      title={`Was hängt — ${MONTH_NAMES[selectedMonth - 1]} ${selectedYear}`}
    >
      <>
        {isLoading ? (
          <div className="flex items-center gap-2 py-4 text-sm text-gray-500">
            <Loader2 className={`${iconSize.sm} animate-spin text-amber-600`} />
            Blocker werden geladen …
          </div>
        ) : (
          <div className="mt-3 grid gap-4 md:grid-cols-2">
            <DocumentationGroup items={documentation?.items ?? []} count={documentation?.count ?? 0} />
            <BudgetGroup items={budget?.items ?? []} count={budget?.count ?? 0} />
          </div>
        )}
      </>
    </CollapsibleCard>
  );
}

function GroupHeader({
  icon,
  title,
  count,
  testId,
}: {
  icon: React.ReactNode;
  title: string;
  count: number;
  testId: string;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        {icon}
        <h3 className="text-sm font-medium text-gray-900">{title}</h3>
      </div>
      <span
        className={`inline-flex min-w-6 items-center justify-center rounded-full px-2 py-0.5 text-xs font-semibold ${
          count > 0 ? "bg-amber-100 text-amber-800" : "bg-gray-100 text-gray-500"
        }`}
        data-testid={`${testId}-count`}
      >
        {count}
      </span>
    </div>
  );
}

function DocumentationGroup({ items, count }: { items: DocumentationBlockerItem[]; count: number }) {
  return (
    <div
      className="rounded-md border border-gray-200 p-3"
      data-testid="group-blockers-documentation"
    >
      <GroupHeader
        icon={<FileWarning className={`${iconSize.sm} text-amber-600`} />}
        title="Termine ohne/überfällige Doku"
        count={count}
        testId="blockers-documentation"
      />
      {items.length === 0 ? (
        <p className="mt-2 text-xs text-gray-500" data-testid="text-blockers-documentation-empty">
          Keine offenen oder überfälligen Termine.
        </p>
      ) : (
        <ul className="mt-2 max-h-64 space-y-1 overflow-y-auto">
          {items.map((item) => (
            <li
              key={item.appointmentId}
              className="flex items-center justify-between gap-2 border-b border-gray-100 py-1 text-xs last:border-0"
              data-testid={`row-blocker-documentation-${item.appointmentId}`}
            >
              <span className="min-w-0 truncate text-gray-800">
                <span className="tabular-nums text-gray-500">{formatShortDate(item.date)}</span>{" "}
                {item.customerName}
                <span className="text-gray-400"> · {item.employeeName}</span>
              </span>
              <OverdueBadge days={item.daysOverdue} overdue={item.overdue} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function OverdueBadge({ days, overdue }: { days: number; overdue: boolean }) {
  if (days < 0) {
    return <span className="shrink-0 text-gray-400">geplant</span>;
  }
  return (
    <span
      className={`shrink-0 rounded px-1.5 py-0.5 font-medium tabular-nums ${
        overdue ? "bg-red-50 text-red-700" : "bg-gray-100 text-gray-600"
      }`}
    >
      {days === 0 ? "heute" : `${days} Tag${days === 1 ? "" : "e"}`}
    </span>
  );
}

function BudgetGroup({ items, count }: { items: BudgetBlockerItem[]; count: number }) {
  return (
    <div className="rounded-md border border-gray-200 p-3" data-testid="group-blockers-budget">
      <GroupHeader
        icon={<Wallet className={`${iconSize.sm} text-amber-600`} />}
        title="Budget/§45b-Probleme"
        count={count}
        testId="blockers-budget"
      />
      {items.length === 0 ? (
        <p className="mt-2 text-xs text-gray-500" data-testid="text-blockers-budget-empty">
          Keine Budget-Probleme.
        </p>
      ) : (
        <ul className="mt-2 max-h-64 space-y-1 overflow-y-auto">
          {items.map((item) => (
            <li
              key={`${item.customerId}-${item.budgetType}`}
              className="flex items-center justify-between gap-2 border-b border-gray-100 py-1 text-xs last:border-0"
              data-testid={`row-blocker-budget-${item.customerId}-${item.budgetType}`}
            >
              <span className="min-w-0 truncate text-gray-800">
                {item.customerName}
                <span className="text-gray-400"> · {formatBudgetType(item.budgetType)}</span>
              </span>
              <span className="shrink-0 rounded bg-red-50 px-1.5 py-0.5 font-medium tabular-nums text-red-700">
                −{formatAmount(item.shortfallCents)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
