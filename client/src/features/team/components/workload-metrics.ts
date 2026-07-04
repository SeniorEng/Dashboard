import { computeTeamWorkload, type TeamWorkloadInputs } from "@shared/domain/team-workload";

export interface WorkloadMetrics {
  totalCustomers: number;
  primaryCount: number;
  /** committed = geleistete produktive Zeit + Overhead (h, gerundet). */
  istHours: number;
  sollHours: number | null;
  hasSoll: boolean;
  hasIstBasis: boolean;
  auslastungPct: number | null;
  overHours: number | null;
  freieStunden: number | null;
  freieKunden: number | null;
  isOverloaded: boolean;
  hasFreeCapacity: boolean;
}

type WorkloadInput = {
  primaryCount: number;
  backupCount: number;
  backup2Count: number;
  avgMonthlyHwMinutes: number;
  avgMonthlyAllMinutes: number;
  avgProdHvMinutes: number;
  avgOverheadMinutes: number;
  avgSickVacMinutes: number;
  monthsConsidered: number;
  monthlyWorkHours: number | null;
};

/**
 * Dünner Adapter auf die EINE SSoT `computeTeamWorkload` (shared/domain).
 * Mappt die SSoT-Kennzahlen auf die von der Benutzerverwaltung genutzten
 * Feldnamen. KEINE eigene Rechenlogik mehr (Ersetzungs-Regel).
 */
export function computeWorkloadMetrics(
  wl: WorkloadInput | undefined,
): WorkloadMetrics | null {
  if (!wl) return null;
  const inputs: TeamWorkloadInputs = {
    monthlyWorkHours: wl.monthlyWorkHours,
    avgProdPerformedHwMinutes: wl.avgMonthlyHwMinutes,
    avgProdPerformedAllMinutes: wl.avgMonthlyAllMinutes,
    avgProdHvMinutes: wl.avgProdHvMinutes,
    avgOverheadMinutes: wl.avgOverheadMinutes,
    avgSickVacMinutes: wl.avgSickVacMinutes,
    hvCount: wl.primaryCount,
    v1Count: wl.backupCount,
    v2Count: wl.backup2Count,
    monthsConsidered: wl.monthsConsidered,
  };
  const m = computeTeamWorkload(inputs);
  return {
    totalCustomers: m.totalCustomers,
    primaryCount: m.hvCount,
    istHours: Math.round(m.committedHours * 10) / 10,
    sollHours: m.sollHours,
    hasSoll: m.hasSoll,
    hasIstBasis: m.hasIstBasis,
    auslastungPct: m.pct !== null ? Math.round(m.pct) : null,
    overHours: m.overHours !== null ? Math.round(m.overHours * 10) / 10 : null,
    freieStunden: m.freeHours,
    freieKunden: m.addClients,
    isOverloaded: m.isOverloaded,
    hasFreeCapacity: m.hasFreeCapacity,
  };
}
