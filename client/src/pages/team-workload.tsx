import { useMemo, useState } from "react";
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
import { Loader2, Users, Calendar, Search, Info } from "lucide-react";
import { iconSize, componentStyles } from "@/design-system";
import { useTeamWorkload } from "@/features/team/use-team-workload";
import { ROLE_LABELS, AVAILABLE_ROLES, formatPhoneForDisplay } from "@/pages/admin/components/user-types";

type SortKey = "hv-desc" | "hv-asc" | "name-asc";

export default function TeamWorkloadPage() {
  const { data, isLoading } = useTeamWorkload();
  const [searchQuery, setSearchQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<string>("alle");
  const [sortKey, setSortKey] = useState<SortKey>("hv-desc");

  const rows = useMemo(() => {
    if (!data) return [];
    const q = searchQuery.trim().toLowerCase();
    const filtered = data.employees.filter((emp) => {
      if (!emp.isActive) return false;
      if (roleFilter !== "alle" && !emp.roles.includes(roleFilter)) return false;
      if (q && !emp.displayName.toLowerCase().includes(q)) return false;
      return true;
    });
    const withWorkload = filtered.map((emp) => ({
      employee: emp,
      workload: data.workload[emp.id] ?? {
        primaryCount: 0,
        backupCount: 0,
        backup2Count: 0,
        avgMonthlyHwMinutes: 0,
        avgMonthlyAllMinutes: 0,
        monthsConsidered: 0,
      },
    }));
    withWorkload.sort((a, b) => {
      if (sortKey === "name-asc") return a.employee.displayName.localeCompare(b.employee.displayName, "de");
      if (sortKey === "hv-asc") return a.workload.primaryCount - b.workload.primaryCount;
      return b.workload.primaryCount - a.workload.primaryCount;
    });
    return withWorkload;
  }, [data, searchQuery, roleFilter, sortKey]);

  return (
    <Layout>
      <div className="flex items-center justify-between gap-2 mb-6">
        <h1 className={componentStyles.pageTitle} data-testid="text-team-workload-title">
          Team-Auslastung
        </h1>
      </div>

      <p className="text-sm text-gray-600 mb-4" data-testid="text-team-workload-subtitle">
        Übersicht, wie stark die einzelnen Mitarbeiter mit Kunden ausgelastet sind. Reine Lese-Ansicht.
      </p>

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
            <SelectTrigger className="w-[220px] bg-white" data-testid="select-team-workload-sort">
              <SelectValue placeholder="Sortierung" />
            </SelectTrigger>
            <SelectContent>
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
          {rows.map(({ employee, workload }) => {
            const totalCustomers =
              workload.primaryCount + workload.backupCount + workload.backup2Count;
            const hwHours = Math.round((workload.avgMonthlyHwMinutes / 60) * 10) / 10;
            const allHours = Math.round((workload.avgMonthlyAllMinutes / 60) * 10) / 10;
            const monthsConsidered = Math.round(workload.monthsConsidered * 10) / 10;
            const monthsLabel = `Ø über ${monthsConsidered.toLocaleString("de-DE", { maximumFractionDigits: 1 })} von 3 Monaten`;
            return (
              <Card key={employee.id} data-testid={`card-team-workload-${employee.id}`}>
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
