import { formatCurrency } from "@shared/utils/format";

export function cents(value: number | string | bigint | null | undefined): string {
  if (value == null) return formatCurrency(0);
  const num = typeof value === "string" ? parseInt(value) || 0 : Number(value) || 0;
  return formatCurrency(num);
}

export function pct(a: number, b: number): string {
  if (b === 0) return "0%";
  return `${Math.round((a / b) * 100)}%`;
}

export function hours(minutes: number | null | undefined): string {
  const min = Number(minutes) || 0;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m > 0 ? `${h}h ${m}min` : `${h}h`;
}

export const SERVICE_TYPE_LABELS: Record<string, string> = {
  hauswirtschaft: "Hauswirtschaft",
  alltagsbegleitung: "Alltagsbegleitung",
  erstberatung: "Erstberatung",
};

export const SERVICE_TYPE_COLORS: Record<string, string> = {
  hauswirtschaft: "#3b82f6",
  alltagsbegleitung: "#14b8a6",
  erstberatung: "#f59e0b",
};

export const ENTRY_TYPE_LABELS: Record<string, string> = {
  verfuegbar: "Verfügbar",
  urlaub: "Urlaub",
  krank: "Krank",
  pause: "Pause",
  bueroarbeit: "Büroarbeit",
  besprechung: "Besprechung",
  vertrieb: "Vertrieb",
  sonstiges: "Sonstiges",
  weiterbildung: "Weiterbildung",
};

export const ENTRY_TYPE_COLORS: Record<string, string> = {
  verfuegbar: "#22c55e",
  urlaub: "#f59e0b",
  krank: "#ef4444",
  pause: "#94a3b8",
  bueroarbeit: "#6366f1",
  besprechung: "#8b5cf6",
  vertrieb: "#0ea5e9",
  sonstiges: "#a3a3a3",
  weiterbildung: "#ec4899",
};
