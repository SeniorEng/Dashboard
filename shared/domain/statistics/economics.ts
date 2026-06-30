/**
 * Task #1355 — Wirtschaftlichkeit (SSoT für Kosten-/Mengen-Rechnung).
 *
 * EINE gemeinsame, reine Berechnung für das Umsatz- UND das Team-Dashboard,
 * statt einer dritten parallelen Kostenrechnung. Sätze stammen ausschließlich
 * aus dem Service-Katalog (`employee_rate_cents` bzw. `default_price_cents`).
 * Alle Beträge sind Integer-Cents; km-Beträge laufen über die km-SSoT in
 * `shared/domain/invoice-line-items.ts`, damit Anzeige === Buchung gilt.
 */
import type {
  EconomicsBreakdown,
  EconomicsInput,
  EconomicsRatesCents,
} from "../../statistics";
import { computeKmLineTotalCents } from "../invoice-line-items";
import { getEntryTypeLabel } from "../time-entries";

/**
 * Personalkosten für eine Stundenleistung: Minuten → Stunden × Stundensatz,
 * kaufmännisch auf Cent gerundet. Genau diese eine Funktion verwenden beide
 * Dashboards für jede Minuten→Euro-Umrechnung.
 */
export function costForMinutes(minutes: number, rateCentsPerHour: number): number {
  if (!Number.isFinite(minutes) || !Number.isFinite(rateCentsPerHour)) return 0;
  return Math.round((minutes / 60) * rateCentsPerHour);
}

/**
 * Deckungsbeitrags-Marge in ganzen Prozent. Bei Erlös ≤ 0 ⇒ 0 %. Identische
 * Formel wie bisher im Team-/Planung-Dashboard, jetzt zentral.
 */
export function marginPercent(revenueCents: number, marginCents: number): number {
  return revenueCents > 0 ? Math.round((marginCents / revenueCents) * 100) : 0;
}

/**
 * Satz, zu dem nicht-abrechenbare Zeit (Büro/Vertrieb/Sonstiges/Krank/Urlaub)
 * bewertet wird: der Hauswirtschafts-Stundensatz (günstigster produktiver
 * Satz, konservative Bewertung des Overheads).
 */
export function nonBillableRateCents(rates: EconomicsRatesCents): number {
  return rates.hauswirtschaftRateCents;
}

/**
 * Baut die komplette Wirtschaftlichkeits-Aufstellung aus reinen Mengen + Sätzen.
 * Reine Funktion ohne IO — der Storage-Layer sammelt nur die Mengen.
 */
export function buildEconomics(input: EconomicsInput): EconomicsBreakdown {
  const { rates } = input;
  // Task #1503: rollenbasierte Kosten (in SQL über `wageFor` aufgelöst) gewinnen
  // über die flache Katalogrechnung; fehlt das Override, gilt das alte Verhalten.
  const ov = input.costOverride;

  const hwCost = ov
    ? ov.hauswirtschaftCostCents
    : costForMinutes(input.hauswirtschaftMinutes, rates.hauswirtschaftRateCents);
  const abCost = ov
    ? ov.alltagsbegleitungCostCents
    : costForMinutes(input.alltagsbegleitungMinutes, rates.alltagsbegleitungRateCents);
  const billableMinutes = input.hauswirtschaftMinutes + input.alltagsbegleitungMinutes;
  const billableCost = hwCost + abCost;

  const erstberatungCost = ov
    ? ov.erstberatungCostCents
    : costForMinutes(input.erstberatungMinutes, rates.erstberatungRateCents);

  const nbRate = nonBillableRateCents(rates);
  const byCategory = input.nonBillable.map((c) => ({
    category: c.category,
    label: getEntryTypeLabel(c.category),
    minutes: c.minutes,
    costCents: ov
      ? (ov.nonBillableCostCentsByCategory[c.category] ?? 0)
      : costForMinutes(c.minutes, nbRate),
  }));
  const nonBillableMinutes = byCategory.reduce((s, c) => s + c.minutes, 0);
  const nonBillableCost = byCategory.reduce((s, c) => s + c.costCents, 0);

  const personnelTotalMinutes = billableMinutes + input.erstberatungMinutes + nonBillableMinutes;
  const personnelTotalCost = billableCost + erstberatungCost + nonBillableCost;

  const travel = {
    km: input.travelKm,
    chargedCents: computeKmLineTotalCents(input.travelKm, rates.travelKmPriceCents),
    paidCents: ov
      ? ov.travelKmPaidCents
      : computeKmLineTotalCents(input.travelKm, rates.travelKmRateCents),
  };
  const customer = {
    km: input.customerKm,
    chargedCents: computeKmLineTotalCents(input.customerKm, rates.customerKmPriceCents),
    paidCents: ov
      ? ov.customerKmPaidCents
      : computeKmLineTotalCents(input.customerKm, rates.customerKmRateCents),
  };
  // Mitarbeiter-km aus der Zeiterfassung werden dem Kunden NICHT berechnet
  // (kein Termin-Bezug) — nur Kostenseite, zum Anfahrts-Satz bewertet.
  const timeEntry = {
    km: input.timeEntryKm,
    chargedCents: 0,
    paidCents: ov
      ? ov.timeEntryKmPaidCents
      : computeKmLineTotalCents(input.timeEntryKm, rates.travelKmRateCents),
  };
  const kmChargedCents = travel.chargedCents + customer.chargedCents + timeEntry.chargedCents;
  const kmPaidCents = travel.paidCents + customer.paidCents + timeEntry.paidCents;

  const revenueCents = input.documentedServiceRevenueCents + kmChargedCents;
  const totalCostCents = personnelTotalCost + kmPaidCents;
  const marginCents = revenueCents - totalCostCents;
  // Produktiv = kundennahe Wertschöpfung (abrechenbar + Erstberatung + km),
  // nicht-abrechenbar = bezahlter Overhead (Büro/Vertrieb/Sonstiges/Krank/Urlaub).
  const productiveCostCents = billableCost + erstberatungCost + kmPaidCents;

  return {
    rates,
    personnel: {
      hauswirtschaft: { minutes: input.hauswirtschaftMinutes, costCents: hwCost },
      alltagsbegleitung: { minutes: input.alltagsbegleitungMinutes, costCents: abCost },
      billable: { minutes: billableMinutes, costCents: billableCost },
      erstberatung: { minutes: input.erstberatungMinutes, costCents: erstberatungCost },
      nonBillable: { minutes: nonBillableMinutes, costCents: nonBillableCost, byCategory },
      totalMinutes: personnelTotalMinutes,
      totalCostCents: personnelTotalCost,
    },
    km: {
      travel,
      customer,
      timeEntry,
      totalChargedCents: kmChargedCents,
      totalPaidCents: kmPaidCents,
    },
    result: {
      revenueCents,
      documentedRevenueCents: input.documentedServiceRevenueCents,
      kmChargedCents,
      personnelCostCents: personnelTotalCost,
      kmPaidCents,
      totalCostCents,
      marginCents,
      marginPercent: marginPercent(revenueCents, marginCents),
      productiveCostCents,
      nonBillableCostCents: nonBillableCost,
    },
  };
}
