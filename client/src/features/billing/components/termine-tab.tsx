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
import { PIPELINE_STAGE_LABELS } from "@shared/domain/billing-pipeline";
import { formatDate } from "../utils";
import type { BillingStatusFilter } from "./status-pipeline-card";
import { ZaehlweiseHinweis } from "./zaehlweise-hinweis";

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

/**
 * Beschriftungen aus der Pipeline-SSoT, nicht daneben neu erfunden.
 *
 * ERSETZT den lokalen Satz aus sechs frei gewählten Strings. Er beschrieb
 * dieselben sechs Stufen wie `PIPELINE_STAGE_LABELS` unter anderen Namen —
 * was nicht auffiel, solange beide Seiten „Dokumentiert" sagten. Mit der
 * Umbenennung in der Kaskade (Ticket 6hWgVqw2C8442hcG) fiel es sofort
 * auseinander: ein Klick auf „Nachweis zu erstellen" filterte auf einen Chip,
 * der zwei Zentimeter tiefer „Dokumentiert" hieß. Zwei Namen für dieselbe
 * fachliche Frage sind genau das, was die SSoT-Regel ausschließt.
 *
 * Offen bleibt der Zweitbegriff auf TYP-Ebene: diese Stufe heißt hier
 * `nachgewiesen` und in der Pipeline `unterschrieben`. Das ist dieselbe Frage
 * unter zwei Schlüsseln und gehört zusammengelegt — als Vertragsänderung,
 * nicht nebenbei (FINDING im PR). Bis dahin ist wenigstens die ANZEIGE eine.
 *
 * `kunde_nicht_angetroffen` hat keinen Stufen-Partner (Seitenzustand) und
 * behält deshalb seine eigene Beschriftung.
 */
const STAGE_LABELS: Record<BillingTermineStage, string> = {
  offen: PIPELINE_STAGE_LABELS.offen,
  dokumentiert: PIPELINE_STAGE_LABELS.dokumentiert,
  // NICHT `PIPELINE_STAGE_LABELS.unterschrieben` („abrechnungsreif“).
  //
  // Die beiden Stufen sind NICHT dasselbe, und der Unterschied sitzt genau
  // dort, wo die Beschriftung eine Handlung auslöst: `nachgewiesen` ist in
  // dieser Liste zahler-typ-BLIND definiert (`termine-reader.ts` reicht
  // `documentedAndSignedSqlRaw` als „direkte Unterschrift“ durch, und das
  // Prädikat akzeptiert `msr.status = 'employee_signed'`). Ein
  // Pflegekassen-Termin mit nur mitarbeiter-signiertem Nachweis landet hier
  // also unter `nachgewiesen`, während die Geld-Sicht ihn — richtig, #1874 —
  // unter „Leistungsnachweis fehlt“ führt.
  //
  // „abrechnungsreif“ schickte dann jemanden zum Abrechnen, wo die
  // Kundenunterschrift fehlt. Diese Beschriftung sagt deshalb nur, was
  // gesichert ist: der Nachweis liegt vor. Die eigentliche Auflösung ist die
  // Zusammenlegung der beiden Stufen-Typen (FINDING [P2] im PR).
  nachgewiesen: "Nachweis liegt vor",
  rechnung_erstellt: PIPELINE_STAGE_LABELS.rechnung_erstellt,
  versendet: PIPELINE_STAGE_LABELS.versendet,
  bezahlt: PIPELINE_STAGE_LABELS.bezahlt,
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

      {/* S-1 (Alrik, 18.09.2026). Der wichtigere der beiden Saetze ist hier der
          zweite: diese Liste folgt dem Monatsabschluss NICHT. Wer sie mit der
          Umsatz-Kachel vergleicht, sieht nach dem Cutoff Termine, die dort kein
          Geld mehr sind — das ist Absicht und kein Widerspruch, aber ohne den
          Hinweis liest es sich wie einer. */}
      <ZaehlweiseHinweis sicht="termineListe" />

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
