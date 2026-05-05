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

export interface AlertItem {
  severity: "rot" | "gelb" | "gruen";
  title: string;
  description: string;
  count: number;
  link?: string;
}
