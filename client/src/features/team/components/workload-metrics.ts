export interface WorkloadMetrics {
  totalCustomers: number;
  primaryCount: number;
  istHours: number;
  sollHours: number | null;
  hasSoll: boolean;
  hasIstBasis: boolean;
  auslastungPct: number | null;
  freieStunden: number | null;
  freieKunden: number | null;
  isOverloaded: boolean;
  hasFreeCapacity: boolean;
}

export function computeWorkloadMetrics(
  wl: { primaryCount: number; backupCount: number; backup2Count: number; avgMonthlyHwMinutes: number; avgMonthlyAllMinutes: number; monthsConsidered: number; monthlyWorkHours: number | null } | undefined,
  globalAvg: number,
): WorkloadMetrics | null {
  if (!wl) return null;
  const totalCustomers = wl.primaryCount + wl.backupCount + wl.backup2Count;
  const hwHours = wl.avgMonthlyHwMinutes / 60;
  const allHours = wl.avgMonthlyAllMinutes / 60;
  const istHours = Math.round((hwHours + allHours) * 10) / 10;
  const sollHours = wl.monthlyWorkHours;
  const hasSoll = sollHours !== null && sollHours > 0;
  const hasIstBasis = hasSoll && wl.monthsConsidered > 0;
  const auslastungPct = hasIstBasis ? Math.round((istHours / sollHours!) * 100) : null;
  const freieStunden = hasSoll
    ? hasIstBasis
      ? Math.max(0, sollHours! - istHours)
      : sollHours!
    : null;
  const freieKunden =
    hasIstBasis && globalAvg > 0 ? Math.floor(freieStunden! / globalAvg) : null;
  return {
    totalCustomers,
    primaryCount: wl.primaryCount,
    istHours,
    sollHours,
    hasSoll,
    hasIstBasis,
    auslastungPct,
    freieStunden,
    freieKunden,
    isOverloaded: auslastungPct !== null && auslastungPct > 100,
    hasFreeCapacity: auslastungPct !== null && auslastungPct < 85,
  };
}
