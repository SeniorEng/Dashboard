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
import { validate45aAmount, validate39_42aAmount } from "@shared/domain/budgets";
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

  // Task #1168 — §45a-/§39/§42a-Voraussetzungen + statutorische Obergrenzen
  // bereits im Wizard blocken, mit derselben Quelle wie der Server
  // (`validate45aAmount` prüft PG-Gate UND PG-Maximum; §39/§42a braucht den
  // PG-Gate separat, `validate39_42aAmount` deckt nur das 3.539-€-Maximum ab).
  // Nur prüfen, wenn der Topf im Wizard wirklich aktiviert ist — sonst würde
  // der Default-Wert (§39/§42a = 3.539 €) einen PG-1-Kunden fälschlich am
  // "Weiter" hindern, obwohl der Create-Payload den Topf gar nicht sendet.
  {
    const pg = formData.pflegegrad ? parseInt(formData.pflegegrad, 10) : 0;
    const is45aEnabled =
      formData.budgetTypeSettings.find(s => s.budgetType === "umwandlung_45a")?.enabled ?? false;
    const is39Enabled =
      formData.budgetTypeSettings.find(s => s.budgetType === "ersatzpflege_39_42a")?.enabled ?? false;

    if (is45aEnabled) {
      const v45a = parseFloat(formData.pflegesachleistungen36);
      if (!isNaN(v45a) && v45a > 0) {
        const msg = validate45aAmount(Math.round(v45a * 100), pg);
        if (msg) errors.push(msg);
      }
    }
    if (is39Enabled) {
      const v39 = parseFloat(formData.verhinderungspflege39);
      if (!isNaN(v39) && v39 > 0) {
        if (pg < 2) {
          errors.push("§39/§42a (Verhinderungspflege/Kurzzeitpflege) ist erst ab Pflegegrad 2 verfügbar");
        } else {
          const msg = validate39_42aAmount(Math.round(v39 * 100));
          if (msg) errors.push(msg);
        }
      }
    }
  }

  return errors;
}
