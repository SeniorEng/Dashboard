import { useMemo, useState } from "react";
import { Link } from "wouter";
import { Layout } from "@/components/layout";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Loader2,
  Search,
  AlertCircle,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { WorkloadBarTooltip, WorkloadInfoTooltip } from "@/features/team/components/workload-info-tooltip";
import { iconSize, componentStyles } from "@/design-system";
import { useTeamWorkload } from "@/features/team/use-team-workload";
import {
  selectTeamWorkloadRows,
  selectTeamWorkloadViewState,
  type SortKey,
  type TeamWorkloadRow,
} from "@/features/team/team-workload-view";
import {
  REISEPUFFER_HOURS,
  DEFAULT_PER_CLIENT_HOURS,
  type TeamWorkloadStatus,
} from "@shared/domain/team-workload";
import { ROLE_LABELS, AVAILABLE_ROLES, formatPhoneForDisplay } from "@/features/team/components/user-types";

const fmtH = (n: number) =>
  n.toLocaleString("de-DE", { maximumFractionDigits: 1 });

const STATUS_STYLE: Record<
  TeamWorkloadStatus,
  { dot: string; text: string; ring: string; label: string }
> = {
  over: {
    dot: "bg-red-500",
    text: "text-red-700",
    ring: "border-l-red-500",
    label: "Überlastet",
  },
  limit: {
    dot: "bg-amber-500",
    text: "text-amber-700",
    ring: "border-l-amber-500",
    label: "Am Limit",
  },
  free: {
    dot: "bg-emerald-500",
    text: "text-emerald-700",
    ring: "border-l-emerald-500",
    label: "Frei",
  },
  "no-soll": {
    dot: "bg-gray-300",
    text: "text-gray-500",
    ring: "border-l-gray-300",
    label: "Kein Soll",
  },
  "no-basis": {
    dot: "bg-gray-300",
    text: "text-gray-500",
    ring: "border-l-gray-300",
    label: "Keine Daten",
  },
};

/** Stacked bar whose full width == Soll; overload spills past Soll in red. */
function WorkloadBar({ row }: { row: TeamWorkloadRow }) {
  const m = row.metrics;
  if (m.sollHours === null || m.sollHours <= 0) return null;
  const soll = m.sollHours;
  // Scale so that Soll always maps to a fixed fraction of the track; the
  // overload tail extends past that marker.
  const scale = Math.max(soll, m.usedAllHours, m.committedHours, 1);
  const pctOf = (h: number) => (h / scale) * 100;
  const sollMarkerPct = pctOf(soll);
  const overHours = m.overHours ?? 0;

  return (
    <WorkloadBarTooltip>
      <div
        className="relative h-3 w-full rounded-full bg-gray-100 overflow-hidden"
        data-testid={`workload-bar-${row.employee.id}`}
      >
        {/* Produktiv */}
        <div
          className="absolute inset-y-0 bg-teal-600"
          style={{ left: 0, width: `${pctOf(m.prodPerformedHours)}%` }}
          aria-hidden="true"
        />
        {/* Fahrt / Büro */}
        <div
          className="absolute inset-y-0 bg-sky-500"
          style={{
            left: `${pctOf(m.prodPerformedHours)}%`,
            width: `${pctOf(m.overheadHours)}%`,
          }}
          aria-hidden="true"
        />
        {/* Krank / Urlaub */}
        <div
          className="absolute inset-y-0 bg-amber-500"
          style={{
            left: `${pctOf(m.committedHours)}%`,
            width: `${pctOf(m.sickVacHours)}%`,
          }}
          aria-hidden="true"
        />
        {/* Über-Soll (spill) */}
        {overHours > 0.05 && (
          <div
            className="absolute inset-y-0 bg-red-500"
            style={{
              left: `${sollMarkerPct}%`,
              width: `${pctOf(m.committedHours - soll)}%`,
            }}
            aria-hidden="true"
          />
        )}
        {/* Soll marker */}
        <div
          className="absolute top-0 h-full w-px bg-gray-900"
          style={{ left: `${sollMarkerPct}%` }}
          aria-hidden="true"
        />
      </div>
    </WorkloadBarTooltip>
  );
}

function CustomerBreakdown({ row }: { row: TeamWorkloadRow }) {
  const { employee, workload } = row;
  if (workload.assignments.length === 0) {
    return (
      <div className="text-xs text-gray-500 italic" data-testid={`list-customers-empty-${employee.id}`}>
        Keine Kunden zugewiesen
      </div>
    );
  }
  return (
    <div className="space-y-2" data-testid={`list-customers-${employee.id}`}>
      {(["HV", "V1", "V2"] as const).map((role) => {
        const items = workload.assignments.filter((a) => a.role === role);
        if (items.length === 0) return null;
        const roleColor =
          role === "HV"
            ? "text-teal-700 bg-teal-50"
            : role === "V1"
              ? "text-sky-700 bg-sky-50"
              : "text-violet-700 bg-violet-50";
        return (
          <div key={role} data-testid={`list-customers-${role.toLowerCase()}-${employee.id}`}>
            <div className="flex items-center gap-2 mb-1">
              <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${roleColor}`}>
                {role}
              </span>
              <span className="text-[10px] text-gray-500">
                {items.length} {items.length === 1 ? "Kunde" : "Kunden"}
              </span>
            </div>
            <ul className="flex flex-wrap gap-x-3 gap-y-1 pl-1">
              {items.map((c) => (
                <li key={`${role}-${c.id}`}>
                  <Link
                    href={`/admin/customers/${c.id}`}
                    className="text-xs text-primary hover:underline"
                    data-testid={`link-customer-${employee.id}-${c.id}`}
                  >
                    {c.name}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function WorkloadRowItem({
  row,
  expanded,
  onToggle,
}: {
  row: TeamWorkloadRow;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { employee, workload, metrics: m } = row;
  const style = STATUS_STYLE[m.status];
  const pctRounded = m.pct !== null ? Math.round(m.pct) : null;
  const monthsConsidered = Math.round(workload.monthsConsidered * 10) / 10;

  // Verdict — the one decision sentence.
  let verdict: { text: string; cls: string; testid: string };
  if (m.status === "over") {
    verdict = {
      text: `${fmtH(m.overHours ?? 0)} h über Soll — keine neuen Kunden`,
      cls: "text-red-700",
      testid: `workload-verdict-over-${employee.id}`,
    };
  } else if (m.status === "free") {
    verdict = {
      text:
        m.addClients && m.addClients > 0
          ? `Kann ca. ${m.addClients} ${m.addClients === 1 ? "Kunden" : "Kunden"} übernehmen (${fmtH(m.freeHours ?? 0)} h frei)`
          : `${fmtH(m.freeHours ?? 0)} h frei`,
      cls: "text-emerald-700",
      testid: `workload-verdict-free-${employee.id}`,
    };
  } else if (m.status === "limit") {
    verdict = {
      text: `Am Limit — ${fmtH(m.freeHours ?? 0)} h frei, reicht nicht für einen Kunden`,
      cls: "text-amber-700",
      testid: `workload-verdict-limit-${employee.id}`,
    };
  } else if (m.status === "no-soll") {
    verdict = {
      text:
        workload.monthlyWorkHours === null
          ? "Vertragsstunden fehlen"
          : "Kein Soll (Vertragsstunden = 0)",
      cls: "text-gray-500",
      testid: `workload-verdict-no-soll-${employee.id}`,
    };
  } else {
    verdict = {
      text: "Keine Ist-Daten im Zeitraum",
      cls: "text-gray-500",
      testid: `workload-verdict-no-basis-${employee.id}`,
    };
  }

  return (
    <Card
      className={`border-l-4 ${style.ring}`}
      data-testid={`card-team-workload-${employee.id}`}
    >
      <CardContent className="p-0">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="w-full text-left p-3 sm:p-4 flex flex-col gap-2"
          data-testid={`button-toggle-customers-${employee.id}`}
        >
          {/* Top line: dot + name + status + pct */}
          <div className="flex items-center gap-2">
            <span
              className={`inline-block h-2.5 w-2.5 rounded-full shrink-0 ${style.dot}`}
              aria-hidden="true"
              data-testid={`workload-status-dot-${employee.id}`}
            />
            <span
              className="font-semibold text-gray-900 truncate"
              data-testid={`text-team-workload-name-${employee.id}`}
            >
              {employee.displayName}
            </span>
            <span
              className={`text-[11px] uppercase tracking-wide font-medium ${style.text}`}
              data-testid={`workload-status-label-${employee.id}`}
            >
              {style.label}
            </span>
            <span className="ml-auto flex items-center gap-1.5">
              {pctRounded !== null ? (
                <span
                  className={`text-lg font-bold tabular-nums ${style.text}`}
                  data-testid={`workload-auslastung-${employee.id}`}
                >
                  {pctRounded}%
                </span>
              ) : (
                <span className="text-sm text-gray-400" data-testid={`workload-auslastung-na-${employee.id}`}>
                  –
                </span>
              )}
              {expanded ? (
                <ChevronDown className="h-4 w-4 text-gray-400" />
              ) : (
                <ChevronRight className="h-4 w-4 text-gray-400" />
              )}
            </span>
          </div>

          {/* Bar */}
          {m.sollHours !== null && m.sollHours > 0 && m.hasIstBasis ? (
            <div onClick={(e) => e.stopPropagation()}>
              <WorkloadBar row={row} />
            </div>
          ) : null}

          {/* Verdict + quick stats */}
          <div className="flex items-center gap-x-3 gap-y-1 flex-wrap text-xs">
            <span className={`font-medium ${verdict.cls}`} data-testid={verdict.testid}>
              {verdict.text}
            </span>
            <span className="text-gray-400">·</span>
            <span className="text-gray-600" data-testid={`workload-hv-${employee.id}`}>
              {workload.primaryCount} HV
            </span>
            <span className="text-gray-500" data-testid={`workload-total-${employee.id}`}>
              / {m.totalCustomers} ges.
            </span>
          </div>
        </button>

        {/* Detail panel */}
        {expanded && (
          <div
            className="border-t px-3 sm:px-4 py-3 space-y-3"
            data-testid={`workload-detail-${employee.id}`}
          >
            {/* Contact */}
            <div className="text-xs text-gray-600">
              {employee.telefon ? (
                <a
                  href={`tel:${employee.telefon}`}
                  className="text-primary hover:underline"
                  data-testid={`link-team-workload-phone-${employee.id}`}
                >
                  {formatPhoneForDisplay(employee.telefon)}
                </a>
              ) : (
                <span className="text-gray-400">Keine Telefonnummer</span>
              )}
            </div>

            {/* Hours breakdown */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2 text-sm">
              <div>
                <div className="text-[11px] uppercase tracking-wide text-gray-500">Soll</div>
                <div className="font-semibold text-gray-900" data-testid={`workload-soll-${employee.id}`}>
                  {m.sollHours !== null ? `${fmtH(m.sollHours)} h` : "–"}
                </div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wide text-gray-500 inline-flex items-center gap-1">
                  Ist (geleistet + Fahrt/Büro)
                  <WorkloadInfoTooltip testId={`tooltip-workload-info-${employee.id}`} />
                </div>
                <div className="font-semibold text-gray-900" data-testid={`workload-ist-${employee.id}`}>
                  {fmtH(m.committedHours)} h
                </div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wide text-gray-500">
                  {m.status === "over" ? "Über Soll" : "Frei bis Soll"}
                </div>
                <div
                  className={`font-semibold ${m.status === "over" ? "text-red-600" : "text-emerald-700"}`}
                  data-testid={`workload-freie-stunden-${employee.id}`}
                >
                  {m.status === "over"
                    ? `+${fmtH(m.overHours ?? 0)} h`
                    : m.freeHours !== null
                      ? `${fmtH(m.freeHours)} h`
                      : "–"}
                </div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wide text-gray-500">Produktiv</div>
                <div className="text-gray-900" data-testid={`workload-prod-${employee.id}`}>
                  {fmtH(m.prodPerformedHours)} h
                  <span className="text-gray-400 text-xs">
                    {" "}({fmtH(m.prodPerformedHwHours)} HW · {fmtH(m.prodPerformedAllHours)} Allt.)
                  </span>
                </div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wide text-gray-500">Fahrt / Büro</div>
                <div className="text-gray-900" data-testid={`workload-overhead-${employee.id}`}>
                  {fmtH(m.overheadHours)} h
                </div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wide text-gray-500">Krank / Urlaub</div>
                <div className="text-gray-900" data-testid={`workload-sickvac-${employee.id}`}>
                  {fmtH(m.sickVacHours)} h
                </div>
              </div>
            </div>

            {/* Capacity */}
            <div className="rounded-md bg-gray-50 px-3 py-2 text-xs text-gray-700 space-y-1">
              <div className="flex items-baseline justify-between gap-3">
                <span>Freie Kapazität</span>
                {m.addClients !== null && m.addClients > 0 ? (
                  <span className="font-semibold text-emerald-700" data-testid={`workload-zusatzkunden-${employee.id}`}>
                    +{m.addClients} mögl. Kunden
                  </span>
                ) : m.addClients === 0 ? (
                  <span className="font-semibold text-red-600" data-testid={`workload-zusatzkunden-${employee.id}`}>
                    Keine
                  </span>
                ) : (
                  <span className="text-gray-500" data-testid={`workload-zusatzkunden-na-${employee.id}`}>
                    n/a
                  </span>
                )}
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <span>Kapazität pro Kunde</span>
                <span data-testid={`workload-per-client-${employee.id}`}>
                  {fmtH(m.perClientHours)} h
                  <span className="text-gray-400">
                    {" "}({fmtH(m.perClientOwnHours)} + {fmtH(REISEPUFFER_HOURS)} Puffer
                    {m.perClientOwnIsApprox ? ", Näherung" : ""})
                  </span>
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <span>Rollen</span>
                <span>
                  <span className="text-teal-700" data-testid={`workload-hv-detail-${employee.id}`}>{m.hvCount} HV</span>
                  {" · "}
                  <span className="text-sky-700" data-testid={`workload-v1-${employee.id}`}>{m.v1Count} V1</span>
                  {" · "}
                  <span className="text-violet-700" data-testid={`workload-v2-${employee.id}`}>{m.v2Count} V2</span>
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-3" data-testid={`workload-months-${employee.id}`}>
                <span>Berechnungs-Basis</span>
                <span className="text-gray-500">
                  Ø über {fmtH(monthsConsidered)} von 3 Monaten
                </span>
              </div>
            </div>

            {/* Customers */}
            <div>
              <div className="text-[11px] uppercase tracking-wide text-gray-500 font-medium mb-1.5">
                Kunden ({workload.assignments.length})
              </div>
              <CustomerBreakdown row={row} />
            </div>

            {/* Roles */}
            <div>
              <div className="text-[11px] uppercase tracking-wide text-gray-500 font-medium mb-1.5">
                Tätigkeitsbereiche
              </div>
              <div className="flex flex-wrap gap-1.5" data-testid={`text-team-workload-roles-${employee.id}`}>
                {employee.roles.map((role) => (
                  <span key={role} className="text-xs px-2 py-1 rounded bg-gray-100 text-gray-700">
                    {ROLE_LABELS[role] || role}
                  </span>
                ))}
                {employee.roles.length === 0 && (
                  <span className="text-xs text-gray-500 italic">Keine zugewiesen</span>
                )}
              </div>
            </div>

            <div className="pt-1">
              <Link
                href={`/admin/users?edit=${employee.id}`}
                className="text-xs text-primary hover:underline"
                data-testid={`link-edit-employee-${employee.id}`}
              >
                Mitarbeiter bearbeiten
              </Link>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function TeamWorkloadPage() {
  const { data, isLoading, isError, error, refetch, isFetching } = useTeamWorkload();
  const [searchQuery, setSearchQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<string>("alle");
  const [sortKey, setSortKey] = useState<SortKey>("auslastung-desc");
  const [expandedEmployeeIds, setExpandedEmployeeIds] = useState<Set<number>>(new Set());

  const toggleExpanded = (employeeId: number) => {
    setExpandedEmployeeIds((prev) => {
      const next = new Set(prev);
      if (next.has(employeeId)) next.delete(employeeId);
      else next.add(employeeId);
      return next;
    });
  };

  const { state: viewState, rows } = useMemo(
    () =>
      selectTeamWorkloadViewState({
        data,
        isLoading,
        isError,
        error,
        searchQuery,
        roleFilter,
        sortKey,
      }),
    [data, isLoading, isError, error, searchQuery, roleFilter, sortKey],
  );

  // Summary counts across ALL active employees (independent of the filters).
  const summary = useMemo(() => {
    const allRows = selectTeamWorkloadRows({
      data,
      searchQuery: "",
      roleFilter: "alle",
      sortKey: "name-asc",
    });
    let over = 0;
    let limit = 0;
    let free = 0;
    for (const r of allRows) {
      if (r.metrics.status === "over") over++;
      else if (r.metrics.status === "limit") limit++;
      else if (r.metrics.status === "free") free++;
    }
    return { over, limit, free, total: allRows.length };
  }, [data]);

  return (
    <Layout>
      <div className="flex items-center justify-between gap-2 mb-2">
        <h1 className={componentStyles.pageTitle} data-testid="text-team-workload-title">
          Team-Auslastung
        </h1>
      </div>

      <p className="text-sm text-gray-600 mb-4" data-testid="text-team-workload-subtitle">
        Entscheidungs-Ansicht: Wer ist überlastet, wer kann noch Kunden übernehmen? Reine Lese-Ansicht.
      </p>

      {/* Summary tiles */}
      <div className="grid grid-cols-3 gap-2 sm:gap-3 mb-4">
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2" data-testid="tile-summary-over">
          <div className="text-2xl font-bold text-red-700 tabular-nums" data-testid="text-summary-over-count">
            {summary.over}
          </div>
          <div className="text-[11px] uppercase tracking-wide text-red-700/80">Überlastet</div>
        </div>
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2" data-testid="tile-summary-limit">
          <div className="text-2xl font-bold text-amber-700 tabular-nums" data-testid="text-summary-limit-count">
            {summary.limit}
          </div>
          <div className="text-[11px] uppercase tracking-wide text-amber-700/80">Am Limit</div>
        </div>
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2" data-testid="tile-summary-free">
          <div className="text-2xl font-bold text-emerald-700 tabular-nums" data-testid="text-summary-free-count">
            {summary.free}
          </div>
          <div className="text-[11px] uppercase tracking-wide text-emerald-700/80">Freie Kapazität</div>
        </div>
      </div>

      {/* Calc-basis tile */}
      <div
        className="rounded-lg border border-gray-200 bg-white px-3 py-2 mb-4 text-xs text-gray-600 flex items-start gap-2"
        data-testid="text-team-workload-calc-basis"
      >
        <AlertCircle className="h-4 w-4 text-gray-400 mt-0.5 shrink-0" aria-hidden="true" />
        <span>
          Auslastung = (geleistete produktive Zeit + Fahrt/Büro) ÷ Vertragsstunden, Ø der letzten
          3 abgeschlossenen Monate. Kapazität pro Kunde wird je Mitarbeiter aus den eigenen
          HV-Stunden berechnet, plus {fmtH(REISEPUFFER_HOURS)} h Fahrt-/Rüst-Puffer (Näherung ohne
          HV-Basis: {fmtH(DEFAULT_PER_CLIENT_HOURS)} h).
        </span>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mb-4 text-xs text-gray-600" data-testid="legend-team-workload">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-red-500" aria-hidden="true" /> Überlastet
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-amber-500" aria-hidden="true" /> Am Limit
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" aria-hidden="true" /> Freie Kapazität
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-gray-300" aria-hidden="true" /> Keine Basis
        </span>
      </div>

      {/* Filters */}
      <div className="space-y-3 mb-4">
        <div className="relative">
          <Search className={`absolute left-3 top-1/2 -translate-y-1/2 ${iconSize.sm} text-gray-500`} />
          <Input
            placeholder="Mitarbeitername suchen..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 bg-white"
            data-testid="input-search-team-workload"
          />
        </div>
        <div className="flex gap-2 flex-wrap">
          <Select value={roleFilter} onValueChange={setRoleFilter}>
            <SelectTrigger className="w-[200px] bg-white" data-testid="select-team-workload-role">
              <SelectValue placeholder="Tätigkeitsbereich" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="alle">Alle Bereiche</SelectItem>
              {AVAILABLE_ROLES.map((role) => (
                <SelectItem key={role} value={role} data-testid={`select-team-workload-role-${role}`}>
                  {ROLE_LABELS[role]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={sortKey} onValueChange={(v) => setSortKey(v as SortKey)}>
            <SelectTrigger className="w-[260px] bg-white" data-testid="select-team-workload-sort">
              <SelectValue placeholder="Sortierung" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auslastung-desc" data-testid="select-team-workload-sort-auslastung-desc">
                Höchste Auslastung zuerst
              </SelectItem>
              <SelectItem value="auslastung-asc" data-testid="select-team-workload-sort-auslastung-asc">
                Niedrigste Auslastung zuerst (wer kann noch?)
              </SelectItem>
              <SelectItem value="freie-kunden-desc" data-testid="select-team-workload-sort-freie-kunden-desc">
                Meiste freie Kunden-Kapazität zuerst
              </SelectItem>
              <SelectItem value="hv-desc" data-testid="select-team-workload-sort-hv-desc">
                Meiste HV-Kunden zuerst
              </SelectItem>
              <SelectItem value="hv-asc" data-testid="select-team-workload-sort-hv-asc">
                Wenigste HV-Kunden zuerst
              </SelectItem>
              <SelectItem value="name-asc" data-testid="select-team-workload-sort-name-asc">
                Name (A–Z)
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {viewState.kind === "loading" ? (
        <div className="flex justify-center py-12">
          <Loader2 className={`${iconSize.xl} animate-spin text-teal-600`} />
        </div>
      ) : viewState.kind === "error" ? (
        <div
          className="flex flex-col items-center gap-3 py-12 text-center"
          data-testid="text-team-workload-error"
        >
          <AlertTriangle className={`${iconSize.lg} text-red-600`} />
          <div className="text-sm text-gray-700">Team-Auslastung konnte nicht geladen werden.</div>
          <div className="text-xs text-gray-500 max-w-md" data-testid="text-team-workload-error-detail">
            {viewState.message}
          </div>
          <button
            type="button"
            onClick={() => refetch()}
            disabled={isFetching}
            className="text-sm px-3 py-1.5 rounded border border-gray-300 bg-white hover:bg-gray-50 disabled:opacity-60"
            data-testid="button-team-workload-retry"
          >
            {isFetching ? "Lädt…" : "Erneut versuchen"}
          </button>
        </div>
      ) : viewState.kind === "empty-no-employees" ? (
        <div className="text-center py-12 text-gray-500" data-testid="text-team-workload-empty">
          Keine Mitarbeiter gefunden
        </div>
      ) : viewState.kind === "empty-filtered" ? (
        <div className="text-center py-12 text-gray-500" data-testid="text-team-workload-empty">
          Keine Mitarbeiter passen zu den aktuellen Filtern
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map((row) => (
            <WorkloadRowItem
              key={row.employee.id}
              row={row}
              expanded={expandedEmployeeIds.has(row.employee.id)}
              onToggle={() => toggleExpanded(row.employee.id)}
            />
          ))}
        </div>
      )}
    </Layout>
  );
}
