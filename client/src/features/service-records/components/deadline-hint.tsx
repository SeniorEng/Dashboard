import { computeMonthCloseCutoff, daysUntilCutoff, previousMonth } from "@shared/utils/month-close-cutoff";
import { formatDateForDisplay } from "@shared/utils/datetime";

export interface DeadlineInfo {
  text: string;
  tone: "muted" | "amber" | "red";
}

export function getTodayIsoBerlin(): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date());
}

export function computeDeadlineInfo(selectedYear: number, selectedMonth: number): DeadlineInfo | null {
  const today = getTodayIsoBerlin();
  const prev = previousMonth(today);
  if (prev.year !== selectedYear || prev.month !== selectedMonth) return null;
  const cutoff = computeMonthCloseCutoff(selectedYear, selectedMonth);
  const days = daysUntilCutoff(today, selectedYear, selectedMonth);
  const cutoffLabel = formatDateForDisplay(cutoff);
  if (days < 0) {
    return { text: `Monatsabschluss-Frist überschritten (${cutoffLabel})`, tone: "red" };
  }
  if (days === 0) {
    return { text: `Monatsabschluss heute (${cutoffLabel})`, tone: "red" };
  }
  if (days === 1) {
    return { text: `Monatsabschluss morgen (${cutoffLabel})`, tone: "amber" };
  }
  return { text: `Monatsabschluss in ${days} Tagen (${cutoffLabel})`, tone: days <= 3 ? "amber" : "muted" };
}

export function DeadlineHint({ info }: { info: DeadlineInfo }) {
  const cls =
    info.tone === "red"
      ? "text-red-600"
      : info.tone === "amber"
      ? "text-amber-700"
      : "text-muted-foreground";
  return (
    <span className={`text-xs ${cls}`} data-testid="text-deadline-hint">
      {info.text}
    </span>
  );
}
