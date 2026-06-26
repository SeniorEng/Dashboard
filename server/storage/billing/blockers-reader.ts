/**
 * Task #1462 — „Was hängt"-Reader (Phase 4, Teil A, READ-ONLY).
 *
 * Komponiert AUSSCHLIESSLICH bestehende SSoTs zu genau zwei Blocker-Gruppen
 * für den gewählten Abrechnungs-Monat:
 *   1) Termine ohne/überfällige Doku  ← `getAdminMonthClosingReadiness`
 *   2) Budget/§45b-Probleme           ← `checkBudgetConservation` ZUM
 *      Monatsstichtag (Periode-bewusst), geschnitten auf die im Monat aktiven
 *      Kunden (`getAllAppointmentsInRange`)
 *
 * Die fachliche Auswahl/Zählung lebt vollständig in
 * `shared/domain/billing-blockers.ts`; dieser Reader ist nur der Lesepfad.
 * Keine Mutation, keine eigene Berechnung.
 */
import { db } from "../../lib/db";
import { monthDateRange } from "../time-tracking/shared";
import { getAdminMonthClosingReadiness } from "../time-tracking/month-closing";
import { getAllAppointmentsInRange } from "../time-tracking/appointments";
import { checkBudgetConservation } from "../../lib/budget-conservation";
import {
  buildDocumentationBlockers,
  selectBudgetBlockers,
} from "@shared/domain/billing-blockers";
import type { BillingBlockersResponse } from "@shared/api/billing-blockers";

export async function readBillingBlockers(
  year: number,
  month: number,
  asOfDate: string,
): Promise<BillingBlockersResponse> {
  const now = new Date(`${asOfDate}T00:00:00`);
  const { startDate, endDate } = monthDateRange(year, month);

  // Budget-Blocker müssen den GEWÄHLTEN Zeitraum widerspiegeln, nicht „heute":
  // die projizierte Topf-Sicht wird zum Monatsende (`endDate`) bewertet, damit
  // ein Kunde z. B. im Juni überzogen, im Mai aber sauber erscheinen kann.
  const [readiness, conservation, apptsInRange] = await Promise.all([
    getAdminMonthClosingReadiness(year, month),
    checkBudgetConservation(db, endDate),
    getAllAppointmentsInRange(startDate, endDate),
  ]);

  const documentationItems = buildDocumentationBlockers(readiness, now);

  // Schnittmenge: nur Töpfe von Kunden, die im Monat tatsächlich Termine haben.
  const customerNameById = new Map<number, string>();
  for (const appt of apptsInRange) {
    if (appt.customerId != null && !customerNameById.has(appt.customerId)) {
      customerNameById.set(appt.customerId, appt.customerName);
    }
  }
  const budgetItems = selectBudgetBlockers(conservation.potRows, customerNameById);

  return {
    billingYear: year,
    billingMonth: month,
    asOfDate,
    documentation: { count: documentationItems.length, items: documentationItems },
    budget: { count: budgetItems.length, items: budgetItems },
  };
}
