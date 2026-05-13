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
 *  - Beides gleichzeitig → beide Sätze, getrennt durch Leerzeichen.
 *  - Kein Engpass → `null` (kein Warnbanner).
 */
export function buildBudgetWarning(summary: BudgetSummary): string | null {
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
    parts.push(
      `Monats-Cap §45b in ${m}/${y} erreicht — keine weiteren Buchungen im laufenden Monat möglich.`
    );
  }

  return parts.length > 0 ? `Achtung: ${parts.join(" ")}` : null;
}
