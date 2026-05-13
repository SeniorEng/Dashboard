import { todayISO } from "@shared/utils/datetime";
import type { BudgetSummary } from "../storage/budget/types";

/**
 * Task #423: Erzeugt eine sprechende Budget-Warnung für Termin-/Serien-POSTs.
 *
 * Vorher: pauschal "Achtung: Das Budget reicht möglicherweise nicht für alle
 * geplanten Termine.", auch wenn das Topf-Guthaben ausreichte und nur der
 * Monats-Cap erreicht war. Das war für die User irreführend.
 *
 * Jetzt:
 *  - Topf-Engpass (`availableAfterPlannedCents < 0`):
 *      "Geplante Termine übersteigen §45b um X €."
 *  - Monats-Cap-Engpass (`currentMonthAvailableCents <= 0` bei gesetztem Cap):
 *      "Monats-Cap §45b in MM/YYYY erreicht — keine weiteren Buchungen möglich."
 *      Wird NUR ausgegeben, wenn mindestens einer der angelegten Termine im
 *      laufenden Monat liegt — der Summary-Wert beschreibt immer den aktuellen
 *      Monat, daher ist die Cap-Aussage für reine Folgemonate irrelevant.
 *  - Beides gleichzeitig → beide Sätze, getrennt durch Leerzeichen.
 *  - Kein Engpass → `null` (kein Warnbanner).
 */
export interface BuildBudgetWarningOptions {
  /**
   * Datum(e) der gerade angelegten Termine im Format `YYYY-MM-DD`. Wird nur
   * für die Cap-Auswertung benötigt: liegt kein Termin im laufenden Monat,
   * wird der Cap-Hinweis unterdrückt (Cap betrifft nur den aktuellen Monat).
   * Wenn das Feld fehlt, wird der Cap-Hinweis konservativ gefeuert.
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

  if (summary.monthlyLimitCents != null && summary.currentMonthAvailableCents <= 0) {
    const today = todayISO();
    const [y, m] = today.split("-");
    const currentMonthPrefix = `${y}-${m}`;
    const dates = opts.appointmentDates;
    const affectsCurrentMonth =
      dates === undefined || dates.some((d) => d.startsWith(currentMonthPrefix));
    if (affectsCurrentMonth) {
      parts.push(
        `Monats-Cap §45b in ${m}/${y} erreicht — keine weiteren Buchungen im laufenden Monat möglich.`,
      );
    }
  }

  return parts.length > 0 ? `Achtung: ${parts.join(" ")}` : null;
}
