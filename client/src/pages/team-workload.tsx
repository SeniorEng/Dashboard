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
import { Loader2, Search, AlertCircle, AlertTriangle, ChevronDown, ChevronRight } from "lucide-react";
import { iconSize, componentStyles } from "@/design-system";
import { useTeamWorkload } from "@/features/team/use-team-workload";
import {
  selectTeamWorkloadViewState,
  type SortKey,
} from "@/features/team/team-workload-view";
import { ROLE_LABELS, AVAILABLE_ROLES, formatPhoneForDisplay } from "@/pages/admin/components/user-types";

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

  const globalAvg = data?.globalAvgHoursPerCustomerPerMonth ?? 0;

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

  return (
    <Layout>
      <div className="flex items-center justify-between gap-2 mb-6">
        <h1 className={componentStyles.pageTitle} data-testid="text-team-workload-title">
          Team-Auslastung
        </h1>
      </div>

      <p className="text-sm text-gray-600 mb-2" data-testid="text-team-workload-subtitle">
        Übersicht, wie stark die einzelnen Mitarbeiter mit Kunden ausgelastet sind. Reine Lese-Ansicht.
      </p>

      {data && (
        <p className="text-xs text-gray-500 mb-4" data-testid="text-team-workload-global-avg">
          Berechnungsbasis für mögliche Zusatzkunden:{" "}
          <span className="font-medium text-gray-700">
            Ø {globalAvg > 0 ? globalAvg.toLocaleString("de-DE", { maximumFractionDigits: 2 }) : "–"} h pro Kunde/Monat
          </span>{" "}
          (global, letzte 3 abgeschlossene Monate)
        </p>
      )}

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
          <AlertCircle className={`${iconSize.lg} text-red-600`} />
          <div className="text-sm text-gray-700">
            Team-Auslastung konnte nicht geladen werden.
          </div>
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
        <div className="flex flex-col gap-3">
          {rows.map(({ employee, workload, sollIst }) => {
            const totalCustomers =
              workload.primaryCount + workload.backupCount + workload.backup2Count;
            const hwHours = Math.round((workload.avgMonthlyHwMinutes / 60) * 10) / 10;
            const allHours = Math.round((workload.avgMonthlyAllMinutes / 60) * 10) / 10;
            const monthsConsidered = Math.round(workload.monthsConsidered * 10) / 10;
            const monthsLabel = `Ø über ${monthsConsidered.toLocaleString("de-DE", { maximumFractionDigits: 1 })} von 3 Monaten`;
            const auslastungPctRounded = sollIst.auslastungPct !== null ? Math.round(sollIst.auslastungPct) : null;
            const overloaded = auslastungPctRounded !== null && auslastungPctRounded >= 100;
            const employmentLabel = workload.employmentType === "minijobber" ? "Minijob" : "SV-pflichtig";
            return (
              <Card
                key={employee.id}
                className={overloaded ? "border-red-300" : undefined}
                data-testid={`card-team-workload-${employee.id}`}
              >
                <CardContent className="p-4">
                  {/* Header: Name + Phone + Pills */}
                  <div className="mb-4">
                    <div
                      className="font-semibold text-gray-900 text-base leading-tight"
                      data-testid={`text-team-workload-name-${employee.id}`}
                    >
                      {employee.displayName}
                    </div>
                    <div className="text-sm text-gray-500 mt-0.5">
                      {employee.telefon ? (
                        <a
                          href={`tel:${employee.telefon}`}
                          className="text-primary hover:underline"
                          data-testid={`link-team-workload-phone-${employee.id}`}
                        >
                          {formatPhoneForDisplay(employee.telefon)}
                        </a>
                      ) : (
                        "–"
                      )}
                    </div>
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {overloaded && (
                        <span
                          className="inline-flex items-center gap-1 text-[11px] uppercase tracking-wide px-2 py-0.5 rounded border border-red-200 bg-red-50 text-red-700 font-medium"
                          data-testid={`badge-team-workload-overloaded-${employee.id}`}
                        >
                          <AlertTriangle className="h-3 w-3" />
                          Überlastet
                        </span>
                      )}
                      {employee.isTeamLead && (
                        <span
                          className="text-[11px] uppercase tracking-wide px-2 py-0.5 rounded border border-gray-200 bg-white text-gray-700 font-medium"
                          data-testid={`badge-team-workload-lead-${employee.id}`}
                        >
                          Teamleitung
                        </span>
                      )}
                      <span
                        className="text-[11px] uppercase tracking-wide px-2 py-0.5 rounded border border-gray-200 bg-white text-gray-700 font-medium"
                        data-testid={`badge-team-workload-employment-${employee.id}`}
                      >
                        {employmentLabel}
                      </span>
                    </div>
                  </div>

                  {/* Hero: Auslastung % + Progress Bar */}
                  {sollIst.sollHours !== null && auslastungPctRounded !== null ? (
                    <div className="mb-4" data-testid={`workload-sollist-${employee.id}`}>
                      <div className="flex items-baseline gap-2">
                        <span
                          className={`text-3xl font-bold ${overloaded ? "text-red-600" : auslastungPctRounded >= 85 ? "text-amber-600" : "text-teal-700"}`}
                          data-testid={`workload-auslastung-${employee.id}`}
                        >
                          {auslastungPctRounded}%
                        </span>
                        <span className="text-xs uppercase tracking-wide text-gray-500 font-medium">
                          Auslastung
                        </span>
                      </div>
                      {/* Progress bar with 100% marker */}
                      <div className="relative mt-2 h-2 rounded-full bg-gray-100 overflow-hidden">
                        <div
                          className={`h-full ${overloaded ? "bg-red-500" : auslastungPctRounded >= 85 ? "bg-amber-500" : "bg-teal-600"}`}
                          style={{ width: `${Math.min(auslastungPctRounded, 100)}%` }}
                        />
                        {overloaded && (
                          <div
                            className="absolute top-0 h-full w-0.5 bg-gray-900"
                            style={{ left: `${Math.min((100 / auslastungPctRounded) * 100, 100)}%` }}
                            aria-hidden="true"
                          />
                        )}
                      </div>
                      <div className="mt-2 flex items-center justify-between text-xs text-gray-700 gap-2 flex-wrap">
                        <span>
                          <span className="font-medium" data-testid={`workload-ist-${employee.id}`}>
                            {sollIst.istHours.toLocaleString("de-DE", { maximumFractionDigits: 1 })} h
                          </span>{" "}
                          <span className="text-gray-500">Ist</span>
                        </span>
                        <span className="text-gray-500 uppercase tracking-wide text-[11px]">
                          Soll <span className="font-medium text-gray-700" data-testid={`workload-soll-${employee.id}`}>{sollIst.sollHours} h</span>
                        </span>
                        {sollIst.freieStunden !== null && (
                          <span
                            className={`font-medium ${overloaded ? "text-red-600" : "text-teal-700"}`}
                            data-testid={`workload-freie-stunden-${employee.id}`}
                          >
                            {overloaded
                              ? `+${Math.abs(sollIst.freieStunden).toLocaleString("de-DE", { maximumFractionDigits: 1 })} h über`
                              : `${sollIst.freieStunden.toLocaleString("de-DE", { maximumFractionDigits: 1 })} h frei`}
                          </span>
                        )}
                      </div>
                    </div>
                  ) : workload.monthlyWorkHours === null ? (
                    <div
                      className="mb-4 flex items-center gap-2 text-xs"
                      data-testid={`workload-soll-missing-${employee.id}`}
                    >
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-100 text-amber-800">
                        <AlertCircle className="h-3 w-3" />
                        Vertragsstunden fehlen
                      </span>
                      <Link
                        href={`/admin/users?edit=${employee.id}`}
                        className="text-primary hover:underline"
                        data-testid={`link-edit-employee-${employee.id}`}
                      >
                        jetzt ergänzen
                      </Link>
                    </div>
                  ) : workload.monthlyWorkHours > 0 ? (
                    <div
                      className="mb-4 flex items-baseline gap-2 text-sm flex-wrap"
                      data-testid={`workload-soll-no-ist-${employee.id}`}
                    >
                      <span className="text-gray-500 uppercase tracking-wide text-[11px]">Soll</span>
                      <span className="font-semibold text-gray-900" data-testid={`workload-soll-${employee.id}`}>
                        {workload.monthlyWorkHours} h
                      </span>
                      <span className="text-gray-400">·</span>
                      <span className="text-gray-500 uppercase tracking-wide text-[11px]">Ist</span>
                      <span className="text-gray-500 italic">noch keine Daten erfasst</span>
                    </div>
                  ) : (
                    <div
                      className="mb-4 text-xs text-gray-500"
                      data-testid={`workload-soll-zero-${employee.id}`}
                    >
                      Soll/Ist: n/a (Vertragsstunden = 0)
                    </div>
                  )}

                  {/* Key-Value Stats */}
                  <div
                    className="space-y-1.5 text-sm"
                    data-testid={`workload-stats-${employee.id}`}
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-gray-600">Hauptverantwortlich</span>
                      <span className="text-right">
                        <span className="font-semibold text-gray-900" data-testid={`workload-hv-primary-${employee.id}`}>
                          {workload.primaryCount}
                        </span>
                        <span className="text-gray-500 text-xs">
                          {" · "}
                          <span className="text-teal-700" data-testid={`workload-hv-${employee.id}`}>
                            {workload.primaryCount} HV
                          </span>
                          {" · "}
                          <span className="text-blue-600" data-testid={`workload-v1-${employee.id}`}>
                            {workload.backupCount} V1
                          </span>
                          {" · "}
                          <span className="text-purple-600" data-testid={`workload-v2-${employee.id}`}>
                            {workload.backup2Count} V2
                          </span>
                          {" · "}
                          <span className="text-gray-500" data-testid={`workload-total-${employee.id}`}>
                            {totalCustomers} ges.
                          </span>
                        </span>
                      </span>
                    </div>
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-gray-600">Ø Stunden / Monat</span>
                      <span className="text-right">
                        <span className="font-semibold text-gray-900" data-testid={`workload-hw-hours-${employee.id}`}>
                          {hwHours} h
                        </span>
                        <span className="text-gray-500 text-xs"> HW · </span>
                        <span className="font-semibold text-gray-900" data-testid={`workload-all-hours-${employee.id}`}>
                          {allHours} h
                        </span>
                        <span className="text-gray-500 text-xs"> Allt.</span>
                      </span>
                    </div>
                    <div className="flex items-baseline justify-between gap-3" data-testid={`workload-months-${employee.id}`}>
                      <span className="text-gray-600">Berechnungs-Basis</span>
                      <span className="text-xs text-gray-500">{monthsLabel}</span>
                    </div>
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-gray-600">Freie Kapazität</span>
                      {sollIst.moeglicheZusatzKunden !== null && sollIst.moeglicheZusatzKunden > 0 ? (
                        <span
                          className="font-semibold text-emerald-700"
                          data-testid={`workload-zusatzkunden-${employee.id}`}
                        >
                          +{sollIst.moeglicheZusatzKunden} mögl. Kunden
                        </span>
                      ) : sollIst.moeglicheZusatzKunden === 0 ? (
                        <span
                          className="font-semibold text-red-600"
                          data-testid={`workload-zusatzkunden-${employee.id}`}
                        >
                          Keine
                        </span>
                      ) : (
                        <span
                          className="text-gray-500 text-xs"
                          data-testid={`workload-zusatzkunden-na-${employee.id}`}
                        >
                          n/a
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Tätigkeitsbereiche als Pills */}
                  <div className="mt-4">
                    <div className="text-[11px] uppercase tracking-wide text-gray-500 font-medium mb-1.5">
                      Tätigkeitsbereiche
                    </div>
                    <div className="flex flex-wrap gap-1.5" data-testid={`text-team-workload-roles-${employee.id}`}>
                      {employee.roles.map((role) => (
                        <span
                          key={role}
                          className="text-xs px-2 py-1 rounded bg-gray-100 text-gray-700"
                        >
                          {ROLE_LABELS[role] || role}
                        </span>
                      ))}
                      {employee.roles.length === 0 && (
                        <span className="text-xs text-gray-500 italic">Keine zugewiesen</span>
                      )}
                    </div>
                  </div>

                  <div>
                    {workload.assignments.length > 0 && (
                      <div className="mt-3 border-t pt-2">
                        <button
                          type="button"
                          onClick={() => toggleExpanded(employee.id)}
                          className="inline-flex items-center gap-1 text-xs text-gray-600 hover:text-gray-900"
                          data-testid={`button-toggle-customers-${employee.id}`}
                          aria-expanded={expandedEmployeeIds.has(employee.id)}
                        >
                          {expandedEmployeeIds.has(employee.id) ? (
                            <ChevronDown className="h-3 w-3" />
                          ) : (
                            <ChevronRight className="h-3 w-3" />
                          )}
                          {expandedEmployeeIds.has(employee.id) ? "Kunden ausblenden" : "Kunden anzeigen"}
                          <span className="text-gray-400">({workload.assignments.length})</span>
                        </button>

                        {expandedEmployeeIds.has(employee.id) && (
                          <div
                            className="mt-2 space-y-2"
                            data-testid={`list-customers-${employee.id}`}
                          >
                            {(["HV", "V1", "V2"] as const).map((role) => {
                              const items = workload.assignments.filter((a) => a.role === role);
                              if (items.length === 0) return null;
                              const roleColor =
                                role === "HV"
                                  ? "text-teal-700 bg-teal-50"
                                  : role === "V1"
                                    ? "text-blue-700 bg-blue-50"
                                    : "text-purple-700 bg-purple-50";
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
                        )}
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </Layout>
  );
}
