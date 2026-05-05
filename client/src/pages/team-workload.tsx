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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Loader2, Users, Calendar, Search, Info, AlertCircle } from "lucide-react";
import { iconSize, componentStyles } from "@/design-system";
import { useTeamWorkload, type TeamWorkloadEntry } from "@/features/team/use-team-workload";
import { ROLE_LABELS, AVAILABLE_ROLES, formatPhoneForDisplay } from "@/pages/admin/components/user-types";

type SortKey =
  | "hv-desc"
  | "hv-asc"
  | "name-asc"
  | "auslastung-desc"
  | "auslastung-asc"
  | "freie-kunden-desc";

function emptyEntry(): TeamWorkloadEntry {
  return {
    primaryCount: 0,
    backupCount: 0,
    backup2Count: 0,
    avgMonthlyHwMinutes: 0,
    avgMonthlyAllMinutes: 0,
    monthsConsidered: 0,
    monthlyWorkHours: null,
    employmentType: "sozialversicherungspflichtig",
  };
}

interface SollIstView {
  sollHours: number | null;
  istHours: number;
  auslastungPct: number | null;
  freieStunden: number | null;
  moeglicheZusatzKunden: number | null;
}

function deriveSollIst(wl: TeamWorkloadEntry, globalAvg: number): SollIstView {
  const istHoursRaw = (wl.avgMonthlyHwMinutes + wl.avgMonthlyAllMinutes) / 60;
  const sollHours = wl.monthlyWorkHours;
  if (sollHours === null || sollHours <= 0) {
    return { sollHours: null, istHours: istHoursRaw, auslastungPct: null, freieStunden: null, moeglicheZusatzKunden: null };
  }
  // Spiegel der Backend-Logik computeSollIst (server/lib/team-workload.ts):
  // Bei monthsConsidered <= 0 (z.B. komplett im Urlaub) bleiben istHours 0
  // und Zusatzkunden null, weil keine belastbare Datenbasis existiert.
  if (wl.monthsConsidered <= 0) {
    return { sollHours, istHours: 0, auslastungPct: null, freieStunden: sollHours, moeglicheZusatzKunden: null };
  }
  const auslastungPct = (istHoursRaw / sollHours) * 100;
  const freieStunden = Math.max(0, sollHours - istHoursRaw);
  const moeglicheZusatzKunden = globalAvg > 0 ? Math.floor(freieStunden / globalAvg) : null;
  return { sollHours, istHours: istHoursRaw, auslastungPct, freieStunden, moeglicheZusatzKunden };
}

export default function TeamWorkloadPage() {
  const { data, isLoading } = useTeamWorkload();
  const [searchQuery, setSearchQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<string>("alle");
  const [sortKey, setSortKey] = useState<SortKey>("auslastung-desc");

  const globalAvg = data?.globalAvgHoursPerCustomerPerMonth ?? 0;

  const rows = useMemo(() => {
    if (!data) return [];
    const q = searchQuery.trim().toLowerCase();
    const filtered = data.employees.filter((emp) => {
      if (!emp.isActive) return false;
      if (roleFilter !== "alle" && !emp.roles.includes(roleFilter)) return false;
      if (q && !emp.displayName.toLowerCase().includes(q)) return false;
      return true;
    });
    const withWorkload = filtered.map((emp) => {
      const workload = data.workload[emp.id] ?? emptyEntry();
      const sollIst = deriveSollIst(workload, globalAvg);
      return { employee: emp, workload, sollIst };
    });
    withWorkload.sort((a, b) => {
      switch (sortKey) {
        case "name-asc":
          return a.employee.displayName.localeCompare(b.employee.displayName, "de");
        case "hv-asc":
          return a.workload.primaryCount - b.workload.primaryCount;
        case "hv-desc":
          return b.workload.primaryCount - a.workload.primaryCount;
        case "auslastung-desc": {
          const av = a.sollIst.auslastungPct ?? -1;
          const bv = b.sollIst.auslastungPct ?? -1;
          return bv - av;
        }
        case "auslastung-asc": {
          // Mitarbeiter ohne Soll-Ist (null) ans Ende stellen, damit "wer kann noch?" sinnvoll wird.
          const av = a.sollIst.auslastungPct ?? Number.POSITIVE_INFINITY;
          const bv = b.sollIst.auslastungPct ?? Number.POSITIVE_INFINITY;
          return av - bv;
        }
        case "freie-kunden-desc": {
          const av = a.sollIst.moeglicheZusatzKunden ?? -1;
          const bv = b.sollIst.moeglicheZusatzKunden ?? -1;
          return bv - av;
        }
        default:
          return 0;
      }
    });
    return withWorkload;
  }, [data, searchQuery, roleFilter, sortKey, globalAvg]);

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

      {isLoading ? (
        <div className="flex justify-center py-12">
          <Loader2 className={`${iconSize.xl} animate-spin text-teal-600`} />
        </div>
      ) : rows.length === 0 ? (
        <div className="text-center py-12 text-gray-500" data-testid="text-team-workload-empty">
          Keine Mitarbeiter gefunden
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
                  <div className="flex items-center gap-2 flex-wrap mb-3">
                    <span className="font-semibold text-gray-900" data-testid={`text-team-workload-name-${employee.id}`}>
                      {employee.displayName}
                    </span>
                    <span className="text-gray-500">·</span>
                    <span className="text-sm text-gray-500">
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
                    </span>
                    {employee.isTeamLead && (
                      <span
                        className="text-xs px-2 py-0.5 rounded bg-indigo-100 text-indigo-700"
                        data-testid={`badge-team-workload-lead-${employee.id}`}
                      >
                        Teamleitung
                      </span>
                    )}
                    <span
                      className="text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-700"
                      data-testid={`badge-team-workload-employment-${employee.id}`}
                    >
                      {employmentLabel}
                    </span>
                    {overloaded && (
                      <span
                        className="text-xs px-2 py-0.5 rounded bg-red-100 text-red-700"
                        data-testid={`badge-team-workload-overloaded-${employee.id}`}
                      >
                        überlastet
                      </span>
                    )}
                  </div>

                  <div>
                    <div className="text-xs text-gray-500 mb-1">Tätigkeitsbereiche</div>
                    <div className="flex flex-wrap gap-x-3 gap-y-1" data-testid={`text-team-workload-roles-${employee.id}`}>
                      {employee.roles.map((role) => (
                        <span key={role} className="text-sm text-gray-700">
                          {ROLE_LABELS[role] || role}
                        </span>
                      ))}
                      {employee.roles.length === 0 && (
                        <span className="text-sm text-gray-500 italic">Keine zugewiesen</span>
                      )}
                    </div>

                    <div
                      className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-600"
                      data-testid={`workload-stats-${employee.id}`}
                    >
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="inline-flex items-center gap-1 cursor-help">
                            <Users className="h-3 w-3" />
                            <span className="font-medium" data-testid={`workload-total-${employee.id}`}>
                              {totalCustomers} Kunden
                            </span>
                            <span className="text-gray-500">
                              (
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
                              )
                            </span>
                            <Info className="h-3 w-3 text-gray-400 ml-0.5" />
                          </span>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs">
                          <div className="space-y-0.5">
                            <div><strong>HV</strong> = Hauptverantwortliche</div>
                            <div><strong>V1</strong> = Vertretung 1</div>
                            <div><strong>V2</strong> = Vertretung 2</div>
                          </div>
                        </TooltipContent>
                      </Tooltip>
                      <span className="text-gray-300">|</span>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="inline-flex items-center gap-1 cursor-help">
                            <Calendar className="h-3 w-3" />
                            <span>Ø</span>
                            <span className="font-medium" data-testid={`workload-hw-hours-${employee.id}`}>
                              {hwHours}h
                            </span>
                            <span className="text-gray-500">HW</span>
                            <span className="text-gray-500">·</span>
                            <span className="font-medium" data-testid={`workload-all-hours-${employee.id}`}>
                              {allHours}h
                            </span>
                            <span className="text-gray-500">ALL</span>
                            <span className="text-gray-400" data-testid={`workload-months-${employee.id}`}>
                              ({monthsLabel})
                            </span>
                            <Info className="h-3 w-3 text-gray-400 ml-0.5" />
                          </span>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs">
                          <div className="space-y-0.5">
                            <div><strong>HW</strong> = Hauswirtschaft</div>
                            <div><strong>ALL</strong> = Alltagsbegleitung</div>
                            <div className="text-[10px] opacity-80 mt-1">
                              Ø der letzten 3 abgeschlossenen Monate, normalisiert auf tatsächlich
                              verfügbare Arbeitstage. Tage mit Urlaub oder Krankheit sowie Tage vor
                              dem Eintrittsdatum werden herausgerechnet, damit Abwesenheiten die
                              Auslastung nicht künstlich senken.
                            </div>
                          </div>
                        </TooltipContent>
                      </Tooltip>
                    </div>

                    {sollIst.sollHours !== null ? (
                      <div
                        className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs"
                        data-testid={`workload-sollist-${employee.id}`}
                      >
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="inline-flex items-center gap-1 cursor-help text-gray-700">
                              <span className="text-gray-500">Soll/Ist:</span>
                              <span className="font-medium" data-testid={`workload-soll-${employee.id}`}>
                                {sollIst.sollHours}h
                              </span>
                              <span className="text-gray-500">/</span>
                              <span className="font-medium" data-testid={`workload-ist-${employee.id}`}>
                                {sollIst.istHours.toLocaleString("de-DE", { maximumFractionDigits: 1 })}h
                              </span>
                              <Info className="h-3 w-3 text-gray-400 ml-0.5" />
                            </span>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-xs">
                            <div className="text-[11px]">
                              <strong>Soll</strong> = vertragliche Stunden/Monat aus dem Mitarbeiter-Profil.
                              <br />
                              <strong>Ist</strong> = Ø Hauswirtschaft + Alltagsbegleitung der letzten 3 Monate.
                            </div>
                          </TooltipContent>
                        </Tooltip>
                        <span className="text-gray-300">|</span>
                        {auslastungPctRounded !== null ? (
                          <span
                            className={`font-medium ${overloaded ? "text-red-600" : auslastungPctRounded >= 85 ? "text-amber-600" : "text-teal-700"}`}
                            data-testid={`workload-auslastung-${employee.id}`}
                          >
                            {auslastungPctRounded}% ausgelastet
                          </span>
                        ) : (
                          <span className="text-gray-500" data-testid={`workload-auslastung-na-${employee.id}`}>
                            Auslastung n/a
                          </span>
                        )}
                        <span className="text-gray-300">|</span>
                        <span className="text-gray-700" data-testid={`workload-freie-stunden-${employee.id}`}>
                          {sollIst.freieStunden !== null
                            ? `${sollIst.freieStunden.toLocaleString("de-DE", { maximumFractionDigits: 1 })}h frei`
                            : "–"}
                        </span>
                        {sollIst.moeglicheZusatzKunden !== null ? (
                          <>
                            <span className="text-gray-300">|</span>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span
                                  className="inline-flex items-center gap-1 cursor-help font-medium text-emerald-700"
                                  data-testid={`workload-zusatzkunden-${employee.id}`}
                                >
                                  +{sollIst.moeglicheZusatzKunden} mögl. Kunden
                                  <Info className="h-3 w-3 text-gray-400 ml-0.5" />
                                </span>
                              </TooltipTrigger>
                              <TooltipContent className="max-w-xs">
                                <div className="text-[11px]">
                                  Freie Stunden ÷ Ø {globalAvg.toLocaleString("de-DE", { maximumFractionDigits: 2 })} h pro Kunde/Monat (global, letzte 3 Monate), abgerundet.
                                </div>
                              </TooltipContent>
                            </Tooltip>
                          </>
                        ) : globalAvg <= 0 ? (
                          <>
                            <span className="text-gray-300">|</span>
                            <span className="text-gray-500" data-testid={`workload-zusatzkunden-na-${employee.id}`}>
                              Zusatzkunden n/a
                            </span>
                          </>
                        ) : null}
                      </div>
                    ) : workload.monthlyWorkHours === null ? (
                      <div
                        className="mt-2 flex items-center gap-2 text-xs"
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
                    ) : (
                      <div
                        className="mt-2 flex items-center gap-2 text-xs text-gray-500"
                        data-testid={`workload-soll-na-${employee.id}`}
                      >
                        <span>Soll/Ist: n/a (kein Soll hinterlegt)</span>
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
