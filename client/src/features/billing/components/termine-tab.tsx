import { useState } from "react";
import { Link } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { iconSize } from "@/design-system";
import { Loader2, CalendarDays, ChevronDown, ChevronRight } from "lucide-react";
import type {
  BillingTermineResponse,
  BillingTermineStage,
  BillingTermineEmployeeGroup,
} from "@shared/api";
import { formatDate } from "../utils";
import type { BillingStatusFilter } from "./status-pipeline-card";

interface TermineTabProps {
  termine: BillingTermineResponse | undefined;
  isLoading: boolean;
  statusFilter: BillingStatusFilter;
  setStatusFilter: (status: BillingStatusFilter) => void;
}

const STAGE_ORDER: BillingTermineStage[] = [
  "offen",
  "dokumentiert",
  "nachgewiesen",
  "rechnung_erstellt",
  "versendet",
  "bezahlt",
  "kunde_nicht_angetroffen",
];

const STAGE_LABELS: Record<BillingTermineStage, string> = {
  offen: "Offen",
  dokumentiert: "Dokumentiert",
  nachgewiesen: "Leistungsnachweis",
  rechnung_erstellt: "Rechnung erstellt",
  versendet: "Versendet",
  bezahlt: "Bezahlt",
  kunde_nicht_angetroffen: "Kunde nicht angetroffen",
};

const STAGE_BADGE: Record<BillingTermineStage, string> = {
  offen: "bg-gray-100 text-gray-700 border-gray-200",
  dokumentiert: "bg-amber-50 text-amber-700 border-amber-200",
  nachgewiesen: "bg-blue-50 text-blue-700 border-blue-200",
  rechnung_erstellt: "bg-teal-50 text-teal-700 border-teal-200",
  versendet: "bg-indigo-50 text-indigo-700 border-indigo-200",
  bezahlt: "bg-green-50 text-green-700 border-green-200",
  kunde_nicht_angetroffen: "bg-rose-50 text-rose-700 border-rose-200",
};

function EmployeeGroup({
  group,
  statusFilter,
  defaultOpen,
}: {
  group: BillingTermineEmployeeGroup;
  statusFilter: BillingStatusFilter;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const appts =
    statusFilter === "alle"
      ? group.appointments
      : group.appointments.filter((a) => a.stage === statusFilter);
  if (appts.length === 0) return null;

  return (
    <section className="flex flex-col gap-2" data-testid={`termine-employee-${group.employeeId}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-md border border-gray-200 bg-white px-3 py-2 text-left hover:bg-gray-50"
        data-testid={`button-termine-employee-toggle-${group.employeeId}`}
      >
        {open ? (
          <ChevronDown className={`${iconSize.sm} text-gray-400`} />
        ) : (
          <ChevronRight className={`${iconSize.sm} text-gray-400`} />
        )}
        <span className="text-sm font-semibold text-gray-900">{group.employeeName}</span>
        <span
          className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600"
          data-testid={`text-termine-count-${group.employeeId}`}
        >
          {appts.length}
        </span>
      </button>

      {open &&
        appts.map((appt) => (
          <Link
            key={appt.appointmentId}
            href={`/appointment/${appt.appointmentId}`}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-gray-100 bg-white px-3 py-2 hover:bg-gray-50"
            data-testid={`row-termine-appt-${appt.appointmentId}`}
          >
            <span className="text-sm tabular-nums text-gray-500 w-28 shrink-0">
              {formatDate(appt.date)} · {appt.time}
            </span>
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-gray-900">
              {appt.customerName}
            </span>
            <span className="text-xs text-gray-500">{appt.serviceLabel}</span>
            <span
              className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${STAGE_BADGE[appt.stage]}`}
              data-testid={`badge-termine-stage-${appt.appointmentId}`}
            >
              {STAGE_LABELS[appt.stage]}
            </span>
          </Link>
        ))}
    </section>
  );
}

// Task #1473: „Termine End-to-End"-Tab. Status-Chips (geteilter Filter mit der
// Pipeline) + pro Mitarbeiter:in eine aufklappbare Gruppe mit den Terminen des
// Monats. Liest ausschließlich den Termine-Reader (keine Geldbeträge).
export function TermineTab({
  termine,
  isLoading,
  statusFilter,
  setStatusFilter,
}: TermineTabProps) {
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className={`${iconSize.xl} animate-spin text-teal-600`} />
      </div>
    );
  }

  const employees = termine?.employees ?? [];
  const totalsByStage = STAGE_ORDER.reduce(
    (acc, stage) => {
      acc[stage] = employees.reduce((sum, e) => sum + (e.countsByStage[stage] ?? 0), 0);
      return acc;
    },
    {} as Record<BillingTermineStage, number>,
  );
  const grandTotal = Object.values(totalsByStage).reduce((a, b) => a + b, 0);

  const visibleEmployees = employees.filter((e) =>
    statusFilter === "alle"
      ? e.appointments.length > 0
      : (e.countsByStage[statusFilter] ?? 0) > 0,
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2" data-testid="bar-termine-chips">
        <button
          type="button"
          onClick={() => setStatusFilter("alle")}
          className={`rounded-full border px-3 py-1 text-xs font-medium ${
            statusFilter === "alle"
              ? "border-teal-400 bg-teal-50 text-teal-700"
              : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
          }`}
          data-testid="chip-termine-alle"
        >
          Alle ({grandTotal})
        </button>
        {STAGE_ORDER.map((stage) => (
          <button
            key={stage}
            type="button"
            onClick={() => setStatusFilter(stage)}
            className={`rounded-full border px-3 py-1 text-xs font-medium ${
              statusFilter === stage
                ? "border-teal-400 bg-teal-50 text-teal-700"
                : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
            }`}
            data-testid={`chip-termine-${stage}`}
          >
            {STAGE_LABELS[stage]} ({totalsByStage[stage]})
          </button>
        ))}
      </div>

      {visibleEmployees.length === 0 ? (
        <Card>
          <CardContent className="p-12 text-center">
            <CalendarDays className={`${iconSize["2xl"]} mx-auto mb-4 text-gray-300`} />
            <p className="text-gray-500" data-testid="text-termine-empty">
              Keine Termine für diese Auswahl.
            </p>
          </CardContent>
        </Card>
      ) : (
        visibleEmployees.map((group) => (
          <EmployeeGroup
            key={group.employeeId}
            group={group}
            statusFilter={statusFilter}
            defaultOpen={statusFilter !== "alle" || visibleEmployees.length <= 5}
          />
        ))
      )}
    </div>
  );
}
