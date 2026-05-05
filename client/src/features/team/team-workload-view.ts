import type {
  TeamWorkloadEmployee,
  TeamWorkloadEntry,
  TeamWorkloadResponse,
} from "./use-team-workload";

export type SortKey =
  | "hv-desc"
  | "hv-asc"
  | "name-asc"
  | "auslastung-desc"
  | "auslastung-asc"
  | "freie-kunden-desc";

export interface SollIstView {
  sollHours: number | null;
  istHours: number;
  auslastungPct: number | null;
  freieStunden: number | null;
  moeglicheZusatzKunden: number | null;
}

export interface TeamWorkloadRow {
  employee: TeamWorkloadEmployee & { displayName: string; roles: string[] };
  workload: TeamWorkloadEntry;
  sollIst: SollIstView;
}

export type TeamWorkloadViewState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "empty-no-employees" }
  | { kind: "empty-filtered" }
  | { kind: "rows"; rows: TeamWorkloadRow[] };

export function emptyEntry(): TeamWorkloadEntry {
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

export function safeName(emp: {
  displayName: string | null;
  vorname: string | null;
  nachname: string | null;
}): string {
  if (emp.displayName && emp.displayName.trim()) return emp.displayName;
  const combined = `${emp.vorname ?? ""} ${emp.nachname ?? ""}`.trim();
  return combined || "Unbenannt";
}

export function deriveSollIst(
  wl: TeamWorkloadEntry,
  globalAvg: number,
): SollIstView {
  const istHoursRaw = (wl.avgMonthlyHwMinutes + wl.avgMonthlyAllMinutes) / 60;
  const sollHours = wl.monthlyWorkHours;
  if (sollHours === null || sollHours <= 0) {
    return {
      sollHours: null,
      istHours: istHoursRaw,
      auslastungPct: null,
      freieStunden: null,
      moeglicheZusatzKunden: null,
    };
  }
  if (wl.monthsConsidered <= 0) {
    return {
      sollHours,
      istHours: 0,
      auslastungPct: null,
      freieStunden: sollHours,
      moeglicheZusatzKunden: null,
    };
  }
  const auslastungPct = (istHoursRaw / sollHours) * 100;
  const freieStunden = Math.max(0, sollHours - istHoursRaw);
  const moeglicheZusatzKunden =
    globalAvg > 0 ? Math.floor(freieStunden / globalAvg) : null;
  return {
    sollHours,
    istHours: istHoursRaw,
    auslastungPct,
    freieStunden,
    moeglicheZusatzKunden,
  };
}

export function selectTeamWorkloadRows(args: {
  data: TeamWorkloadResponse | undefined;
  searchQuery: string;
  roleFilter: string;
  sortKey: SortKey;
}): TeamWorkloadRow[] {
  const { data, searchQuery, roleFilter, sortKey } = args;
  if (!data || !Array.isArray(data.employees)) return [];
  const globalAvg = data.globalAvgHoursPerCustomerPerMonth ?? 0;
  const workloadMap = data.workload ?? {};
  const q = searchQuery.trim().toLowerCase();
  const filtered = data.employees.filter((emp) => {
    if (!emp.isActive) return false;
    const empRoles = Array.isArray(emp.roles) ? emp.roles : [];
    if (roleFilter !== "alle" && !empRoles.includes(roleFilter)) return false;
    if (q && !safeName(emp).toLowerCase().includes(q)) return false;
    return true;
  });
  const withWorkload: TeamWorkloadRow[] = filtered.map((emp) => {
    const workload = workloadMap[emp.id] ?? emptyEntry();
    const sollIst = deriveSollIst(workload, globalAvg);
    return {
      employee: {
        ...emp,
        displayName: safeName(emp),
        roles: Array.isArray(emp.roles) ? emp.roles : [],
      },
      workload,
      sollIst,
    };
  });
  withWorkload.sort((a, b) => {
    switch (sortKey) {
      case "name-asc":
        return (a.employee.displayName ?? "").localeCompare(
          b.employee.displayName ?? "",
          "de",
        );
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
}

export function selectTeamWorkloadViewState(args: {
  data: TeamWorkloadResponse | undefined;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  searchQuery: string;
  roleFilter: string;
  sortKey: SortKey;
}): { state: TeamWorkloadViewState; rows: TeamWorkloadRow[] } {
  const { data, isLoading, isError, error } = args;
  if (isLoading) {
    return { state: { kind: "loading" }, rows: [] };
  }
  if (isError) {
    const message =
      error instanceof Error && error.message
        ? error.message
        : "Bitte erneut versuchen oder die Seite neu laden.";
    return { state: { kind: "error", message }, rows: [] };
  }
  const rows = selectTeamWorkloadRows(args);
  if (rows.length === 0) {
    const hasEmployees =
      Array.isArray(data?.employees) && (data?.employees.length ?? 0) > 0;
    return {
      state: hasEmployees
        ? { kind: "empty-filtered" }
        : { kind: "empty-no-employees" },
      rows: [],
    };
  }
  return { state: { kind: "rows", rows }, rows };
}
