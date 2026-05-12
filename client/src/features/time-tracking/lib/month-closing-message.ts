import { computeMonthCloseCutoff } from "@shared/utils/month-close-cutoff";

const MONTH_NAMES = [
  "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember",
];

export type MonthClosingVariant = "future" | "open" | "overdue" | "closed";

export interface MonthClosingViewModel {
  show: boolean;
  variant: MonthClosingVariant;
  iconKind: "lock" | "unlock";
  monthLabel: string;
  cutoffFormatted: string;
  message: string;
  toneClass: string;
}

export function formatGermanDate(iso: string): string {
  const y = iso.slice(0, 4);
  const m = iso.slice(5, 7);
  const d = iso.slice(8, 10);
  return `${d}.${m}.${y}`;
}

function isFutureMonth(year: number, month: number, today: string): boolean {
  const ty = parseInt(today.slice(0, 4), 10);
  const tm = parseInt(today.slice(5, 7), 10);
  if (year > ty) return true;
  if (year < ty) return false;
  return month > tm;
}

function isCutoffPassed(cutoffIso: string, today: string): boolean {
  return today > cutoffIso;
}

export interface BuildOpts {
  year: number;
  month: number;
  isClosed: boolean;
  today: string;
}

export function buildMonthClosingViewModel(opts: BuildOpts): MonthClosingViewModel {
  const { year, month, isClosed, today } = opts;
  const monthLabel = `${MONTH_NAMES[month - 1]} ${year}`;
  const cutoffIso = computeMonthCloseCutoff(year, month);
  const cutoffFormatted = formatGermanDate(cutoffIso);

  if (isClosed) {
    return {
      show: true,
      variant: "closed",
      iconKind: "lock",
      monthLabel,
      cutoffFormatted,
      message: `${monthLabel} ist abgeschlossen. Änderungen sind nur noch über die Geschäftsleitung möglich.`,
      toneClass: "text-green-700",
    };
  }

  if (isFutureMonth(year, month, today)) {
    return {
      show: false,
      variant: "future",
      iconKind: "unlock",
      monthLabel,
      cutoffFormatted,
      message: "",
      toneClass: "",
    };
  }

  if (isCutoffPassed(cutoffIso, today)) {
    return {
      show: true,
      variant: "overdue",
      iconKind: "lock",
      monthLabel,
      cutoffFormatted,
      message: `Der Cutoff für ${monthLabel} war am ${cutoffFormatted}. Änderungen sind nur noch über die Geschäftsleitung möglich.`,
      toneClass: "text-amber-800",
    };
  }

  return {
    show: true,
    variant: "open",
    iconKind: "unlock",
    monthLabel,
    cutoffFormatted,
    message: `Du kannst Einträge in ${monthLabel} noch bis ${cutoffFormatted} selbst anlegen, ändern oder löschen. Danach ist der Monat automatisch abgeschlossen — Änderungen sind dann nur noch über die Geschäftsleitung möglich.`,
    toneClass: "text-amber-900",
  };
}
