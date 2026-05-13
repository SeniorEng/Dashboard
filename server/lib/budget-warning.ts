import { todayISO } from "@shared/utils/datetime";
import type { BudgetSummary } from "../storage/budget/types";

export interface BuildBudgetWarningOptions {
  /**
   * Datum(e) der gerade angelegten Termine (`YYYY-MM-DD`). Cap-Hinweis
   * wird nur ausgegeben, wenn mind. ein Termin im laufenden Monat liegt
   * (Cap betrifft nur den aktuellen Monat). Fehlt das Feld, fällt die
   * Auswertung konservativ auf "Cap-Hinweis ausgeben" zurück.
   */
  appointmentDates?: readonly string[];
}

export function buildBudgetWarning(
  summary: BudgetSummary,
  opts: BuildBudgetWarningOptions = {},
): string | null {
  const parts: string[] = [];

  if (summary.availableAfterPlannedCents < 0) {
    const overEuro = (Math.abs(summary.availableAfterPlannedCents) / 100)
      .toFixed(2)
      .replace(".", ",");
    parts.push(`Geplante Termine übersteigen §45b um ${overEuro} €.`);
  }

  if (summary.monthlyLimitCents != null) {
    const today = todayISO();
    const [y, m] = today.split("-");
    const currentMonthPrefix = `${y}-${m}`;
    const dates = opts.appointmentDates;
    const affectsCurrentMonth =
      dates === undefined || dates.some((d) => d.startsWith(currentMonthPrefix));

    if (affectsCurrentMonth) {
      const capShortfall = summary.currentMonthPlannedCents - summary.currentMonthAvailableCents;
      if (capShortfall > 0) {
        const capRemainingEuro = (summary.currentMonthAvailableCents / 100)
          .toFixed(2)
          .replace(".", ",");
        if (summary.currentMonthAvailableCents <= 0) {
          parts.push(
            `Monats-Cap §45b in ${m}/${y} erreicht — keine weiteren Buchungen im laufenden Monat möglich.`,
          );
        } else {
          parts.push(
            `Monats-Cap §45b in ${m}/${y} reicht nicht für alle geplanten Termine — noch ${capRemainingEuro} € buchbar.`,
          );
        }
      }
    }
  }

  return parts.length > 0 ? `Achtung: ${parts.join(" ")}` : null;
}
