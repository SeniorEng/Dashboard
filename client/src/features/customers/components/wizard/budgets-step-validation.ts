/**
 * Task #982 — Reine, testbare Validierung des Budget-Schritts im Kundenanlage-
 * Wizard (SSoT für das "Weiter"-Blockieren).
 *
 * Die §45b-Startwert-(Restguthaben-)Obergrenze aus Task #979 wird im UI über
 * `BudgetsStep` angezeigt, das tatsächliche Blockieren des "Weiter"-Schritts
 * läuft aber über `getStepErrors("budgets")` in `use-customer-wizard.ts`. Damit
 * dieses Block-Verhalten nicht still kaputtgehen kann, lebt die Logik hier als
 * reine, seiteneffektfreie Funktion und wird sowohl vom Hook als auch von einem
 * Unit-Test verwendet.
 *
 * Keine DB-/State-/`Date`-Seiteneffekte: `currentYear` und `today` werden
 * explizit übergeben.
 */
import { isPflegekasseCustomer } from "@shared/domain/customers";
import { centsToEuroNumber } from "@shared/utils/money";
import {
  eligible45bCarryoverMonths,
  max45bCarryoverCents,
  max45bStartValueCents,
  max45bStartValueExceededMessage,
} from "@shared/domain/budget/carryover-eligibility";
import type { CustomerFormData } from "./customer-types";

export function budgetsStepErrors(
  formData: CustomerFormData,
  currentYear: number,
  today: string,
): string[] {
  const errors: string[] = [];
  if (!isPflegekasseCustomer(formData.billingType)) return errors;

  if (!formData.pflegegrad || formData.pflegegrad === "0") errors.push("Pflegegrad auswählen");
  if (!formData.pflegegradSeit) errors.push("Pflegegrad seit fehlt");

  {
    // Task #960 — Vorjahres-Übertrag nur validieren, solange er (bis
    // 30.06.) nutzbar ist; bei späterem Vertragsbeginn ist das Feld
    // ausgeblendet und wird beim Speichern auf 0 gezwungen.
    const carryoverUsable = (formData.contractStart || today) < `${currentYear}-07-01`;
    if (carryoverUsable) {
      const uebertrag = parseFloat(formData.uebertrag45b);
      if (isNaN(uebertrag) || uebertrag < 0) {
        errors.push("Übertrag darf nicht negativ sein");
      } else {
        const eligibleMonths = eligible45bCarryoverMonths(formData.pflegegradSeit, currentYear);
        const maxCarryoverCents = max45bCarryoverCents(eligibleMonths);
        if (Math.round(uebertrag * 100) > maxCarryoverCents) {
          errors.push(`Übertrag überschreitet das mögliche Maximum (${centsToEuroNumber(maxCarryoverCents).toFixed(2)} €)`);
        }
      }
    }
  }

  if (formData.restguthaben45bOverrideEnabled) {
    const stichmonat = formData.restguthaben45bStichmonat;
    const contractMonth = (formData.contractStart || today).slice(0, 7);
    if (!stichmonat) {
      errors.push("Stichmonat für das Restguthaben fehlt");
    } else {
      const [stichYear] = stichmonat.split("-").map(Number);
      if (stichYear !== currentYear) errors.push("Stichmonat muss im laufenden Jahr liegen");
      if (stichmonat < contractMonth) errors.push("Stichmonat darf nicht vor dem Vertragsbeginn liegen");
    }
    const rest = parseFloat(formData.restguthaben45b);
    if (isNaN(rest) || rest < 0) {
      errors.push("Restguthaben darf nicht negativ sein");
    } else if (stichmonat) {
      const maxStartCents = max45bStartValueCents(formData.pflegegradSeit, `${stichmonat}-01`);
      if (Math.round(rest * 100) > maxStartCents) {
        errors.push(max45bStartValueExceededMessage(maxStartCents));
      }
    }
  }

  return errors;
}
