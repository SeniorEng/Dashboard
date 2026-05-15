import type { BudgetSummary } from "../storage/budget/types";
import { formatEuroDE } from "@shared/utils/money";

export interface BuildBudgetWarningOptions {
  /**
   * Datum(e) der gerade angelegten Termine (`YYYY-MM-DD`). Wird nicht mehr
   * für den (entfallenen) §45b-Monats-Cap, sondern nur für zukünftige
   * Erweiterungen reserviert.
   */
  appointmentDates?: readonly string[];
}

/**
 * §45b ist seit Task #425 ein Jahrestopf mit monatlicher Aufstockung
 * (kein Monats-Cap mehr). Übrig bleibt nur die Pot-Erschöpfungs-Warnung
 * `availableAfterPlannedCents < 0`.
 */
export function buildBudgetWarning(
  summary: BudgetSummary,
  _opts: BuildBudgetWarningOptions = {},
): string | null {
  const parts: string[] = [];

  if (summary.availableAfterPlannedCents < 0) {
    const overEuro = formatEuroDE(Math.abs(summary.availableAfterPlannedCents));
    parts.push(`Geplante Termine übersteigen §45b um ${overEuro}.`);
  }

  return parts.length > 0 ? `Achtung: ${parts.join(" ")}` : null;
}
