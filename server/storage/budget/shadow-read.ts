/**
 * Task #874 — Budget GF Phase 4: Shadow-Read-Harness (Invariante I18).
 *
 * Vergleicht den unified Reader (`readUnifiedBudgetAvailability`, DER eine
 * Verfügbarkeits-Reader) mit den Legacy-Summary-Readern (`getBudgetSummary*`)
 * pro Topf und Kunde. Das Ergebnis ist die Drift, die als Phase-6-Lösch-Gate
 * dient: die Legacy-`customer_budgets`-Fallbacks dürfen erst entfernt werden,
 * wenn diese Drift über ein Soak-Fenster auf live Traffic 0 ist.
 *
 * REIN LESEND: weder der unified Reader noch die hier genutzten Legacy-Reader
 * (`getBudgetSummary`, `getBudgetSummary45a`, `getBudgetSummary39_42a` — alle
 * ohne `syncCarryoverAndExpiry`) schreiben. Bewusst NICHT über
 * `getAllBudgetSummaries`, weil dessen Wrapper synct (schreibt).
 *
 * BEKANNTE DRIFT (Stand Phase 4, vom Soak zu überwachen): die §45b-Legacy-
 * Summary subtrahiert den Netto-Konsum ALL-TIME inkl. `manual_adjustment`, der
 * unified Reader rechnet asOf-Datum OHNE `manual_adjustment` (Allocation-Sicht
 * wie `getAvailableForDate`). Für Kunden ohne `manual_adjustment` ist die Drift
 * 0; mit `manual_adjustment` legt der Soak die Differenz offen — das ist die
 * Reconciliation-Aufgabe für Phase 6 (Legacy bleibt bis dahin SSoT).
 */
import { readUnifiedBudgetAvailability, type CappedBudgetPot } from "./unified-reader";
import {
  getBudgetSummary,
  getBudgetSummary45a,
  getBudgetSummary39_42a,
} from "./summary-queries";
import { readBudgetTypeSettings } from "./preferences-storage";
import { todayISO } from "@shared/utils/datetime";

export interface PotDrift {
  budgetType: CappedBudgetPot;
  unifiedAvailableCents: number;
  legacyAvailableCents: number;
  /** unified − legacy (signed). */
  deltaCents: number;
}

export interface ShadowReadResult {
  customerId: number;
  asOfDate: string;
  pots: PotDrift[];
  /** max |deltaCents| über alle Töpfe. */
  maxAbsDeltaCents: number;
  hasDrift: boolean;
}

/**
 * Vergleicht unified vs legacy Verfügbarkeit pro Topf für einen Kunden. Rein
 * lesend; `asOfDate` defaultet auf heute (der Live-Read-Pfad).
 */
export async function compareUnifiedVsLegacy(
  customerId: number,
  asOfDate: string = todayISO(),
): Promise<ShadowReadResult> {
  const [unified, settings, legacy45b, legacy45a, legacy39] = await Promise.all([
    readUnifiedBudgetAvailability(customerId, asOfDate),
    readBudgetTypeSettings(customerId, { kind: "forDate", asOfDate }),
    getBudgetSummary(customerId),
    getBudgetSummary45a(customerId),
    getBudgetSummary39_42a(customerId),
  ]);

  const enabledMap = new Map(settings.map((s) => [s.budgetType, s.enabled]));
  // getAllBudgetSummaries liefert für deaktivierte §45a/§39-Töpfe 0 zurück;
  // wir spiegeln das, damit der Vergleich denselben Live-Pfad abbildet.
  const enabled45a = enabledMap.get("umwandlung_45a") ?? false;
  const enabled39 = enabledMap.get("ersatzpflege_39_42a") ?? false;

  const pots: PotDrift[] = [
    {
      budgetType: "entlastungsbetrag_45b",
      unifiedAvailableCents: unified.pots.entlastungsbetrag_45b.availableCents,
      legacyAvailableCents: legacy45b.availableCents,
      deltaCents: unified.pots.entlastungsbetrag_45b.availableCents - legacy45b.availableCents,
    },
    {
      budgetType: "umwandlung_45a",
      unifiedAvailableCents: unified.pots.umwandlung_45a.availableCents,
      legacyAvailableCents: enabled45a ? legacy45a.currentMonthAvailableCents : 0,
      deltaCents:
        unified.pots.umwandlung_45a.availableCents -
        (enabled45a ? legacy45a.currentMonthAvailableCents : 0),
    },
    {
      budgetType: "ersatzpflege_39_42a",
      unifiedAvailableCents: unified.pots.ersatzpflege_39_42a.availableCents,
      legacyAvailableCents: enabled39 ? legacy39.currentYearAvailableCents : 0,
      deltaCents:
        unified.pots.ersatzpflege_39_42a.availableCents -
        (enabled39 ? legacy39.currentYearAvailableCents : 0),
    },
  ];

  const maxAbsDeltaCents = pots.reduce((m, p) => Math.max(m, Math.abs(p.deltaCents)), 0);

  return {
    customerId,
    asOfDate,
    pots,
    maxAbsDeltaCents,
    hasDrift: maxAbsDeltaCents > 0,
  };
}

/**
 * Loggt eine Shadow-Read-Drift strukturiert (nur bei Drift). Nicht-blockierend
 * gedacht: der Aufrufer ruft das in einem `setImmediate`/`catch`-Wrapper, damit
 * der eigentliche Read-Pfad nie betroffen ist.
 */
export function logShadowDrift(result: ShadowReadResult): void {
  if (!result.hasDrift) return;
  const detail = result.pots
    .filter((p) => p.deltaCents !== 0)
    .map((p) => `${p.budgetType}: unified=${p.unifiedAvailableCents} legacy=${p.legacyAvailableCents} Δ=${p.deltaCents}`)
    .join(" | ");
  console.warn(
    `[budget-shadow-read] DRIFT customer=${result.customerId} asOf=${result.asOfDate} maxΔ=${result.maxAbsDeltaCents} :: ${detail}`,
  );
}
