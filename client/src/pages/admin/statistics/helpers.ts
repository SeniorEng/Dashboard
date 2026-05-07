import { formatCurrency } from "@shared/utils/format";

export interface CsvColumn<T> {
  label: string;
  value: (row: T) => string | number | null | undefined;
}

function escapeCsv(value: string): string {
  if (value.includes('"') || value.includes(",") || value.includes("\n") || value.includes(";")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function exportToCsv<T>(filename: string, columns: CsvColumn<T>[], rows: T[]): void {
  const SEP = ";";
  const header = columns.map((c) => escapeCsv(c.label)).join(SEP);
  const body = rows.map((r) =>
    columns.map((c) => {
      const v = c.value(r);
      if (v == null) return "";
      return escapeCsv(String(v));
    }).join(SEP)
  ).join("\n");
  const csv = "\uFEFF" + header + "\n" + body;
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.endsWith(".csv") ? filename : `${filename}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function cents(value: number | string | bigint | null | undefined): string {
  if (value == null) return formatCurrency(0);
  const num = typeof value === "string" ? parseInt(value) || 0 : Number(value) || 0;
  return formatCurrency(num);
}

export function hours(minutes: number | null | undefined): string {
  const min = Number(minutes) || 0;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}min`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}min`;
}

/**
 * Period helpers for "Gesamtjahr" vs. specific month comparison.
 *
 * When the user picked "Gesamtjahr" (month === "all"), KPI deltas should
 * compare against the previous year (deltaYearAbs/deltaYearPct). For a
 * specific month, the comparison stays month-over-month (deltaAbs/deltaPct).
 */
export function isYearPeriod(month: string): boolean {
  return month === "all";
}

export function compareLabel(month: string): string {
  return isYearPeriod(month) ? "vs. Vorjahr" : "vs. Vormonat";
}

export interface KpiDeltaInput {
  deltaAbs: number | null;
  deltaPct: number | null;
  deltaYearAbs: number | null;
  deltaYearPct: number | null;
}

export function pickDelta(
  month: string,
  kpi: KpiDeltaInput,
): { abs: number | null; pct: number | null } {
  return isYearPeriod(month)
    ? { abs: kpi.deltaYearAbs, pct: kpi.deltaYearPct }
    : { abs: kpi.deltaAbs, pct: kpi.deltaPct };
}

export const fmtCentsDelta = (abs: number): string =>
  `${abs > 0 ? "+" : ""}${cents(abs)}`;

export const fmtHoursDelta = (abs: number): string => {
  const sign = abs > 0 ? "+" : abs < 0 ? "-" : "";
  return `${sign}${hours(Math.abs(abs))}`;
};

export const fmtIntDelta = (abs: number): string =>
  `${abs > 0 ? "+" : ""}${abs.toLocaleString("de-DE")}`;

export const fmtDecimalDelta = (abs: number): string =>
  `${abs > 0 ? "+" : ""}${abs.toLocaleString("de-DE", { maximumFractionDigits: 1 })}`;

export const fmtPctPointDelta = (abs: number): string =>
  `${abs > 0 ? "+" : ""}${abs.toLocaleString("de-DE", { maximumFractionDigits: 1 })} %-Pkt.`;

export interface AlertItem {
  severity: "rot" | "gelb" | "gruen";
  title: string;
  description: string;
  count: number;
  link?: string;
}
